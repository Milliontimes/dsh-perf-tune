/**
 * dsh-perf-tune — DSH 插件入口。
 *
 * 定位：给 agent 提供「读本机性能指标 / 调频」的工具集，但**不内置指标与控制清单**
 * （那部分知识属于记忆系统/调用方），只内置机制与安全边界：
 *
 *  - `perf_read`   读：nvidia-smi / OEM 控制台本地 MQTT 总线 / HTTP / 白名单只读命令
 *  - `perf_tune`   写（调频/调功耗）：nvidia-smi 锁频 / 复位，MQTT 控制面发布
 *  - `perf_limits` 查看：硬安全包线、配置收窄结果、写入开关/冷却、最近审计
 *
 * 写入四道闸：
 *  1) `writes.enabled`（外部配置，默认 true）
 *  2) 每次调用必须显式 `apply: true`（默认 false = dry-run）
 *  3) 硬安全包线校验（lib/envelope.js，配置只能收窄不能放宽，越界直接拒绝不静默 clamp）
 *  4) 冷却 + JSONL 审计（intent 先落盘）+ 写后回读校验
 *
 * 理论依据：OEM 控制台逆向结论（控制台 MQTT 总线 + NVML/EC 边界）。
 *
 * 注意：本插件是 `link:` 安装，插件目录解析不到 profile 的 node_modules，因此**零第三方依赖**，
 * 只能 import node: 内置模块与包内相对路径。
 *
 * @module @local/dsh-perf-tune
 */

import { appendAudit, auditPath, readAuditTail } from './lib/audit.js'
import { createCommandChannel } from './lib/channel-command.js'
import { createHttpChannel } from './lib/channel-http.js'
import { createMqttChannel } from './lib/channel-mqtt.js'
import { createNvidiaChannel } from './lib/channel-nvidia.js'
import { configPath as resolveConfigPath, loadConfig } from './lib/config.js'
import { HARD_ENVELOPE, checkMqttPublish, checkNvidiaWrite, effectiveLimits } from './lib/envelope.js'
import { PerfError } from './lib/errors.js'

/** 插件名（cordis 日志/插件管理器展示用）。 */
export const name = 'perf-tune'

/** 依赖的服务：只需要工具注册表。 */
export const inject = ['tools']

/** nvidia-smi 通道支持的写操作（会展示给模型，不涉及包线数值）。 */
const NVIDIA_OPS = ['lock-core', 'reset-core', 'lock-mem', 'reset-mem', 'reset-all', 'power-limit']

/** nvidia-smi 读字段的合法字符集（字段清单本身不内置，由 nvidia-smi 决定支持什么）。 */
const NVIDIA_FIELD_PATTERN = /^[A-Za-z0-9_.]+$/

/**
 * 进程内运行时状态：全进程共享的写入冷却与最近一次写入摘要。
 * 注意：这是进程级而不是会话级状态——硬件是整机共享的。
 */
const runtime = {
  lastWriteAt: 0,
  lastWriteChannel: null,
  lastWriteRequest: null,
  lastWriteResult: null,
}

// ───────────────────────────── 参数校验（原始 JSON Schema 子集） ─────────────────────────────

/** 判断普通对象（非数组、非 null）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 单值是否匹配一个标量 schema 的 enum/const（标量比较即可）。 */
function sameScalar(left, right) {
  return Object.is(left, right)
}

/**
 * 按 dsh-tools 支持的原始 JSON Schema 子集校验参数。
 * 原始注册（不经 defineTool）不会自动校验，所以工具层自己来。
 * @param {object} schema - 参数 schema（object 根）。
 * @param {unknown} value - 收到的参数。
 * @param {string} [path] - 诊断路径。
 * @returns {string[]} 违规列表；空数组表示通过。
 */
function validateArgs(schema, value, path = 'arguments') {
  const violations = []
  if (!isPlainObject(schema)) return violations
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((branch) => validateArgs(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`${path} 必须且只能匹配一个分支（匹配 ${matches.length} 个）`)
    return violations
  }
  if (schema.type !== undefined) {
    const ok =
      schema.type === 'object' ? isPlainObject(value)
        : schema.type === 'array' ? Array.isArray(value)
          : schema.type === 'string' ? typeof value === 'string'
            : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : schema.type === 'integer' ? Number.isInteger(value)
                : schema.type === 'boolean' ? typeof value === 'boolean'
                  : schema.type === 'null' ? value === null
                    : true
    if (!ok) {
      violations.push(`${path} 类型应为 ${schema.type}，实际是 ${describeType(value)}`)
      return violations
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameScalar(candidate, value))) {
    violations.push(`${path} 取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')} 之一`)
  }
  if (schema.const !== undefined && !sameScalar(schema.const, value)) {
    violations.push(`${path} 取值必须是 ${JSON.stringify(schema.const)}`)
  }
  if (schema.type === 'object' && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`${path}.${key} 是必填项`)
    }
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        violations.push(...validateArgs(properties[key], child, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        violations.push(`${path}.${key} 不是允许的参数（可用参数：${Object.keys(properties).join(', ')}）`)
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => violations.push(...validateArgs(schema.items, item, `${path}[${index}]`)))
  }
  return violations
}

/** 类型名，用于错误信息。 */
function describeType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// ───────────────────────────── 工具定义辅助 ─────────────────────────────

/** 把工具的 JSON 结果渲染成文本内容块。 */
function renderJson(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text.length > 60000 ? `${text.slice(0, 60000)}\n…<截断>` : text }]
}

/** 错误 → 工具错误。模型只会看到 message，所以把 code 拼进 message。 */
function toToolError(error) {
  if (error instanceof PerfError) return new Error(`[${error.code}] ${error.message}`)
  if (error instanceof Error) return error
  return new Error(String(error))
}

/**
 * 构造一个原始 JSON Schema 工具定义（不走 defineTool：插件目录解析不到 @deepseek-ai/dsh-tools）。
 * @param {{ name: string, description: string, parameters: object, execute: Function }} definition
 * @returns {object} 注册到 ctx.tools 的定义。
 */
function definePerfTool(definition) {
  const parameters = definition.parameters
  return {
    name: definition.name,
    description: definition.description,
    parameters,
    // 输出结构随通道而变（消息列表 / 字段列表 / 判定结果），用无约束 schema + render 呈现。
    output: { schema: {}, render: renderJson },
    /** 写工具与读工具都不声明并发安全：写入天然串行，读取不放大并发。 */
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new Error(`[E_ARGS] ${violations.join('; ')}`)
      try {
        return await definition.execute(args, exec)
      } catch (error) {
        throw toToolError(error)
      }
    },
  }
}

// ───────────────────────────── 依赖装配（可在测试中替换） ─────────────────────────────

/** 真实实现的内部依赖表。 */
const INTERNALS = {
  createNvidiaChannel,
  createMqttChannel,
  createHttpChannel,
  createCommandChannel,
  loadConfig,
  configPath: resolveConfigPath,
  effectiveLimits,
  checkNvidiaWrite,
  checkMqttPublish,
  appendAudit,
  readAuditTail,
  auditPath,
  HARD_ENVELOPE,
  now: () => Date.now(),
}

/**
 * 合并插件配置与内部依赖（测试通过 `config.__test__` 注入替身）。
 * @param {object|undefined} pluginConfig - patch 行上的 config。
 * @returns {object} 依赖表。
 */
function resolveDeps(pluginConfig) {
  const overrides = pluginConfig?.__test__
  return overrides !== undefined ? { ...INTERNALS, ...overrides } : { ...INTERNALS }
}

/** 依配置加载配置并计算生效包线。 */
async function loadRuntime(deps, pluginConfig) {
  const env = pluginConfig?.configPath !== undefined
    ? { ...process.env, DSH_PERF_TUNE_CONFIG: pluginConfig.configPath }
    : process.env
  const loaded = await deps.loadConfig({ env })
  return { ...loaded, limits: deps.effectiveLimits(loaded.config) }
}

/** 错误消息提取。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 结果摘要（审计用，避免把大字段全量落盘）。 */
function summarizeResult(result) {
  if (!isPlainObject(result)) return result === undefined ? null : { value: result }
  const summary = { ...result }
  if (Array.isArray(summary.commands)) {
    summary.commands = summary.commands.map((command) => ({
      args: command.args,
      code: command.code,
      stderr: typeof command.stderr === 'string' ? command.stderr.slice(0, 300) : command.stderr,
    }))
  }
  if (Array.isArray(summary.messages)) summary.messages = summary.messages.slice(0, 5)
  return summary
}

// ───────────────────────────── 写入闸门 ─────────────────────────────

/** 写入冷却检查（进程级）。 */
function assertCooldown(deps, minIntervalMs, channel) {
  const now = deps.now()
  if (runtime.lastWriteAt === 0) return
  const elapsed = now - runtime.lastWriteAt
  if (elapsed >= minIntervalMs) return
  const wait = minIntervalMs - elapsed
  throw new PerfError(
    'E_COOLDOWN',
    `写入冷却未到：距上次写入（${runtime.lastWriteChannel ?? '未知通道'}）仅 ${elapsed}ms，冷却 ${minIntervalMs}ms，请等待 ${wait}ms 后重试`,
  )
}

/**
 * 先写 intent 审计再执行写入：审计落盘失败则拒绝本次写入（不产生无痕迹的硬件写入）。
 * @returns {Promise<object>} 通道写入结果。
 */
async function runAuditedWrite(deps, { channel, request, config, minIntervalMs, write }) {
  const base = {
    ts: new Date(deps.now()).toISOString(),
    tool: 'perf_tune',
    channel,
    request,
  }
  try {
    await deps.appendAudit({ ...base, decision: 'intent' }, { config })
  } catch (error) {
    throw new PerfError('E_IO', `审计写入失败，已拒绝执行本次硬件写入：${errorMessage(error)}`)
  }

  const startedAt = deps.now()
  let result
  try {
    result = await write()
  } catch (error) {
    try {
      await deps.appendAudit({ ...base, decision: 'failed', reason: errorMessage(error), durationMs: deps.now() - startedAt }, { config })
    } catch {
      // 失败结果已通过错误消息返回；审计降级不覆盖原始错误。
    }
    throw error
  }

  runtime.lastWriteAt = deps.now()
  runtime.lastWriteChannel = channel
  runtime.lastWriteRequest = request
  runtime.lastWriteResult = result

  let auditWarning
  try {
    await deps.appendAudit({ ...base, decision: 'applied', durationMs: runtime.lastWriteAt - startedAt, result: summarizeResult(result) }, { config })
  } catch (error) {
    auditWarning = `写入已生效但审计追加失败：${errorMessage(error)}`
  }

  return {
    dryRun: false,
    channel,
    request,
    result,
    cooldownMs: minIntervalMs,
    ...(auditWarning === undefined ? {} : { warnings: [auditWarning] }),
  }
}

// ───────────────────────────── 工具：perf_read ─────────────────────────────

/** `perf_read` 的参数 schema。 */
const READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: {
      type: 'string',
      enum: ['nvidia-smi', 'mqtt', 'http', 'command'],
      description: '数据通道：nvidia-smi（GPU/NVML）、mqtt（OEM 控制台本地总线 127.0.0.1:13688）、http（本机 JSON 端点）、command（配置白名单内的只读命令）。',
    },
    fields: {
      type: 'array',
      items: { type: 'string' },
      description: 'nvidia-smi 必填：--query-gpu 字段名，例如 ["power.draw","temperature.gpu","clocks.gr","clocks.max.gr","fan.speed","utilization.gpu"]。插件不内置字段清单；nvidia-smi 不认识的字段会报错。',
    },
    gpuIndex: { type: 'integer', description: 'nvidia-smi 的 GPU 序号，默认取配置 nvidiaSmi.gpuIndex（本机 0）。' },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'mqtt 消息：要订阅的 topic 列表，默认 ["#"]；支持 # / + 通配。只收集 retained 消息与 waitMs 内新发布的消息。',
    },
    waitMs: { type: 'integer', description: 'mqtt 收集窗口（毫秒），默认 1200，最大 10000。' },
    maxMessages: { type: 'integer', description: 'mqtt 最多收集条数，默认 100，最大 500。' },
    qos: { type: 'integer', description: 'mqtt 订阅/发布 QoS：0 或 1（默认 0 读、1 写；2 不支持）。' },
    url: { type: 'string', description: 'http 必填：完整 URL，host 必须在配置 http.allowHosts 内（默认只允许本机回环）。例如本机 GPU 仪表盘 http://127.0.0.1:4014/api/gpus。' },
    path: { type: 'string', description: 'http 可选：从 JSON 里取值的路径，如 "gpus.0.power_w" 或 "gpus[0].power_w"。' },
    program: { type: 'string', description: 'command 必填：要执行的程序，必须在配置 command.allowPrograms / allowPaths 白名单内。' },
    args: { type: 'array', items: { type: 'string' }, description: 'command 可选：程序参数（argv 数组，不经 shell）。' },
    timeoutMs: { type: 'integer', description: '本次调用超时（毫秒）：nvidia-smi 默认 15000、mqtt 默认 8000、http 默认 5000、command 默认 10000。' },
  },
}

/** 构造 `perf_read` 工具。 */
function createReadTool(deps, pluginConfig) {
  return definePerfTool({
    name: 'perf_read',
    description: [
      '读取本机性能指标（只读）。通道：nvidia-smi（GPU 功耗/温度/频率/利用率等，字段名透传给 nvidia-smi，插件不内置清单）；',
      'mqtt（OEM 电竞控制台本地总线 127.0.0.1:13688，可订阅主题收 retained/实时消息，例如 "Customize/SupportInfo"、"#"）；',
      'http（本机 JSON 端点，例如本机 GPU 仪表盘 4014）；command（配置白名单内的只读命令）。',
      '本工具不内置任何指标清单；指标该读什么、怎么解释由记忆系统/调用方提供。返回值里的 warnings 是降级说明（例如 MQTT 未收到消息）。',
    ].join(' '),
    parameters: READ_PARAMETERS,
    async execute(args, exec) {
      const { config, source: configSource, path: configFile, warnings: configWarnings, limits } = await loadRuntime(deps, pluginConfig)
      const signal = exec?.signal
      const timeoutMs = args.timeoutMs
      const warnings = [...(configWarnings ?? [])]
      let result
      if (args.source === 'nvidia-smi') {
        if (!Array.isArray(args.fields) || args.fields.length === 0) {
          throw new PerfError('E_ARGS', 'perf_read 的 source=nvidia-smi 时必须提供非空 fields（nvidia-smi --query-gpu 字段名数组）')
        }
        if (args.fields.length > 64) throw new PerfError('E_ARGS', `fields 最多 64 个，收到 ${args.fields.length} 个`)
        for (const field of args.fields) {
          if (typeof field !== 'string' || !NVIDIA_FIELD_PATTERN.test(field)) {
            throw new PerfError('E_ARGS', `非法 nvidia-smi 字段名 ${JSON.stringify(field)}（只允许字母、数字、下划线、点）`)
          }
        }
        const channel = deps.createNvidiaChannel({ config })
        result = await channel.read({ fields: args.fields, gpuIndex: args.gpuIndex, timeoutMs }, { signal })
      } else if (args.source === 'mqtt') {
        const topics = args.topics ?? ['#']
        if (!Array.isArray(topics) || topics.length === 0) throw new PerfError('E_ARGS', 'topics 必须是非空字符串数组')
        const waitMs = clampInt(args.waitMs, 1200, 0, 10000, 'waitMs')
        const maxMessages = clampInt(args.maxMessages, 100, 1, 500, 'maxMessages')
        const channel = deps.createMqttChannel({ config })
        result = await channel.read({ topics, waitMs, maxMessages, qos: args.qos, timeoutMs }, { signal })
      } else if (args.source === 'http') {
        if (typeof args.url !== 'string' || args.url.length === 0) throw new PerfError('E_ARGS', 'perf_read 的 source=http 时必须提供 url')
        const channel = deps.createHttpChannel({ config })
        result = await channel.read({ url: args.url, path: args.path, timeoutMs }, { signal })
      } else if (args.source === 'command') {
        if (typeof args.program !== 'string' || args.program.length === 0) throw new PerfError('E_ARGS', 'perf_read 的 source=command 时必须提供 program')
        const argv = args.args ?? []
        if (!Array.isArray(argv)) throw new PerfError('E_ARGS', 'args 必须是字符串数组')
        const channel = deps.createCommandChannel({ config })
        result = await channel.read({ program: args.program, args: argv, timeoutMs }, { signal })
      } else {
        throw new PerfError('E_ARGS', `未知 source ${JSON.stringify(args.source)}`)
      }
      return {
        ...result,
        warnings: [...warnings, ...((result && result.warnings) ?? [])],
        // 注意：工具输出必须是 lossless JSON（undefined 字段会被注册表判为非法输出），
        // 所以可选字段用条件展开，不能写成 `foo: undefined`。
        config: {
          path: configFile,
          source: configSource,
          ...(limits?.writes?.enabled === false ? { limitsHint: '写入已禁用' } : {}),
        },
      }
    },
  })
}

/**
 * 整数参数收敛：未给用默认值，非整数抛 E_ARGS，越界抛 E_ARGS（不静默 clamp 模型输入）。
 * @returns {number|undefined} 合法整数或 undefined（未提供）。
 */
function clampInt(value, defaultValue, min, max, label) {
  if (value === undefined) return defaultValue
  if (!Number.isInteger(value)) throw new PerfError('E_ARGS', `${label} 必须是整数，收到 ${JSON.stringify(value)}`)
  if (value < min || value > max) throw new PerfError('E_ARGS', `${label} 必须在 ${min}..${max} 之间，收到 ${value}`)
  return value
}

// ───────────────────────────── 工具：perf_tune ─────────────────────────────

/** `perf_tune` 的参数 schema。 */
const TUNE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['channel'],
  properties: {
    channel: {
      type: 'string',
      enum: ['nvidia-smi', 'mqtt'],
      description: '写入通道：nvidia-smi（锁频/复位/尝试改功耗上限）或 mqtt（向 OEM 控制台控制面发布 JSON 指令）。',
    },
    apply: {
      type: 'boolean',
      description: '必须显式为 true 才会真正写硬件；缺省/false = dry-run（只做参数/包线校验并返回将要发送的内容）。',
    },
    op: {
      type: 'string',
      enum: NVIDIA_OPS,
      description: 'nvidia-smi 写操作：lock-core（-lgc 锁核心频率）、reset-core（-rgc）、lock-mem（-lmc）、reset-mem（-rmc）、reset-all（-rgc + -rmc）、power-limit（-pl，本机驱动大概率拒绝，会如实报错）。',
    },
    mhz: { type: 'number', description: 'lock-core / lock-mem 的目标频率（MHz，整数语义）；与 mhzRange 二选一。' },
    mhzRange: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max'],
      properties: { min: { type: 'number' }, max: { type: 'number' } },
      description: 'lock-core / lock-mem 的频率区间（MHz），等价于 nvidia-smi 的 <min,max> 写法；与 mhz 二选一。',
    },
    watts: { type: 'number', description: 'power-limit 的目标瓦数。' },
    gpuIndex: { type: 'integer', description: 'nvidia-smi 的 GPU 序号，默认取配置值（本机 0）。' },
    topic: {
      type: 'string',
      description: 'mqtt 必填：控制面 topic，必须命中硬白名单（Fan/Control、Customize/Control）。',
    },
    payload: {
      type: 'string',
      description: 'mqtt 必填：要发布的 JSON 文本（对象根）。数值字段会逐个按硬包线校验（TGP ≤140、DynamicBoost ≤25、核心/显存偏移、温度、风扇……），未知数值 key 会被拒绝。',
    },
    qos: { type: 'integer', description: 'mqtt 发布 QoS：0 或 1（默认 1；2 不支持）。retain 永远为 false。' },
  },
}

/** 构造 `perf_tune` 工具。 */
function createTuneTool(deps, pluginConfig) {
  return definePerfTool({
    name: 'perf_tune',
    description: [
      '调频/调功耗（默认 dry-run，必须 apply:true 才写硬件）。nvidia-smi 通道支持锁核心/显存频率与复位；',
      'mqtt 通道向 OEM 电竞控制台控制面（Fan/Control、Customize/Control）发布 JSON 指令（例如切换性能模式 {"Action":"OPERATING_TURBO_MODE"}）。',
      '所有目标值都会过不可放宽的硬件安全包线；越界直接拒绝而不是静默夹取；写入有进程级冷却、写入前先落 intent 审计、写后回读校验。',
      '先用 perf_limits 查看当前包线与写入开关；不确定时先不带 apply 调用一次看 dry-run 结果。',
    ].join(' '),
    parameters: TUNE_PARAMETERS,
    async execute(args, exec) {
      const { config, source: configSource, path: configFile, warnings: configWarnings, limits } = await loadRuntime(deps, pluginConfig)
      const apply = args.apply === true
      const channel = args.channel
      const configMeta = { path: configFile, source: configSource, warnings: configWarnings ?? [] }
      const signal = exec?.signal

      if (channel === 'nvidia-smi') {
        if (args.op === undefined) throw new PerfError('E_ARGS', 'channel=nvidia-smi 时必须提供 op（lock-core/reset-core/lock-mem/reset-mem/reset-all/power-limit）')
        if (args.mhz !== undefined && args.mhzRange !== undefined) throw new PerfError('E_ARGS', 'mhz 与 mhzRange 只能二选一')
        const rawOp = { op: args.op }
        if (args.mhz !== undefined) rawOp.mhz = args.mhz
        if (args.mhzRange !== undefined) rawOp.mhz = args.mhzRange
        if (args.watts !== undefined) rawOp.watts = args.watts
        if (args.gpuIndex !== undefined) rawOp.gpuIndex = args.gpuIndex
        if (config.nvidiaSmi?.gpuIndex !== undefined && rawOp.gpuIndex === undefined) rawOp.gpuIndex = config.nvidiaSmi.gpuIndex
        const checked = deps.checkNvidiaWrite(rawOp, limits)
        const op = checked?.op ?? rawOp
        const request = { channel: 'nvidia-smi', op }
        const relevantLimits = checked?.limits ?? null

        if (!apply) {
          await auditDryRun(deps, { channel, request, config })
          return {
            dryRun: true,
            channel,
            request,
            limits: relevantLimits,
            config: configMeta,
            note: '未执行硬件写入。核对 request 与 limits 后，带 apply:true 再次调用才会真正写入。',
          }
        }

        assertWritesEnabled(limits)
        assertCooldown(deps, limits.writes.minIntervalMs, channel)
        const nvidiaChannel = deps.createNvidiaChannel({ config })
        return await runAuditedWrite(deps, {
          channel,
          request,
          config,
          minIntervalMs: limits.writes.minIntervalMs,
          write: () => nvidiaChannel.write(op, { signal }),
        })
      }

      if (channel === 'mqtt') {
        if (typeof args.topic !== 'string' || args.topic.length === 0) throw new PerfError('E_ARGS', 'channel=mqtt 时必须提供 topic')
        if (typeof args.payload !== 'string' || args.payload.length === 0) throw new PerfError('E_ARGS', 'channel=mqtt 时必须提供 payload（JSON 文本）')
        const checked = deps.checkMqttPublish(args.topic, args.payload, limits)
        const payloadText = JSON.stringify(checked.payload)
        const request = { channel: 'mqtt', topic: checked.topic, payload: checked.payload, bytes: Buffer.byteLength(payloadText, 'utf8'), checked: checked.checked ?? [] }

        if (!apply) {
          await auditDryRun(deps, { channel, request, config })
          return {
            dryRun: true,
            channel,
            request,
            limits: { topics: limits.mqtt.topics, maxPayloadBytes: limits.mqtt.maxPayloadBytes },
            config: configMeta,
            note: '未发布 MQTT 消息。核对 request 与 limits 后，带 apply:true 再次调用才会真正发布。',
          }
        }

        assertWritesEnabled(limits)
        assertCooldown(deps, limits.writes.minIntervalMs, channel)
        const mqttChannel = deps.createMqttChannel({ config })
        return await runAuditedWrite(deps, {
          channel,
          request,
          config,
          minIntervalMs: limits.writes.minIntervalMs,
          write: () => mqttChannel.publish({ topic: checked.topic, payload: payloadText, qos: args.qos }, { signal }),
        })
      }

      throw new PerfError('E_ARGS', `未知写入通道 ${JSON.stringify(channel)}（支持 nvidia-smi / mqtt）`)
    },
  })
}

/** 写入开关检查。 */
function assertWritesEnabled(limits) {
  if (limits.writes.enabled !== true) {
    throw new PerfError('E_WRITE_DISABLED', '写入已被配置禁用（config.writes.enabled=false）；如确需写入请修改配置文件后重试')
  }
}

/** dry-run 审计（失败不阻塞：dry-run 没有副作用）。 */
async function auditDryRun(deps, { channel, request, config }) {
  try {
    await deps.appendAudit({
      ts: new Date(deps.now()).toISOString(),
      tool: 'perf_tune',
      decision: 'dry-run',
      channel,
      request,
    }, { config })
  } catch {
    // dry-run 审计失败不影响结果。
  }
}

// ───────────────────────────── 工具：perf_limits ─────────────────────────────

/** 把硬包线整理成可读摘要（不暴露内部实现细节）。 */
function summarizeHardEnvelope() {
  const envelope = INTERNALS.HARD_ENVELOPE ?? {}
  const numeric = envelope.mqtt?.numeric
  return {
    nvidiaSmi: envelope.nvidiaSmi ?? null,
    mqtt: {
      topics: envelope.mqtt?.topics ?? null,
      maxPayloadBytes: envelope.mqtt?.maxPayloadBytes ?? null,
      numericRules: Array.isArray(numeric)
        ? numeric.map((rule) => ({ key: rule.key, min: rule.min, max: rule.max }))
        : null,
    },
    write: envelope.write ?? null,
  }
}

/** 把生效包线里的 MQTT 数值规则整理成摘要。 */
function summarizeNumericRules(rules) {
  if (!Array.isArray(rules)) return null
  return rules.map((rule) => ({ key: rule.key, min: rule.min, max: rule.max }))
}

/** 构造 `perf_limits` 工具。 */
function createLimitsTool(deps, pluginConfig) {
  return definePerfTool({
    name: 'perf_limits',
    description: [
      '查看本插件的安全边界与当前状态：nvidia-smi 频率/功耗硬包线、MQTT 控制面 topic 白名单与数值包线、配置收窄结果、写入开关与冷却、',
      '配置文件路径、审计文件路径与最近 5 条审计。写硬件前先调用它确认允许范围。',
    ].join(' '),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      let loaded
      try {
        loaded = await loadRuntime(deps, pluginConfig)
      } catch (error) {
        return {
          ok: false,
          error: { code: error instanceof PerfError ? error.code : 'E_CONFIG', message: errorMessage(error) },
          configPath: deps.configPath(),
          hint: '配置文件读取/校验失败；修好 perf-tune 配置后重试（读/写工具此时也可能失败）。',
        }
      }
      const { config, source, path: configFile, warnings, limits } = loaded
      let recent = []
      let auditFailure
      try {
        recent = await deps.readAuditTail({ limit: 5, config })
      } catch (error) {
        auditFailure = errorMessage(error)
      }
      return {
        ok: true,
        writes: {
          enabled: limits.writes.enabled,
          minIntervalMs: limits.writes.minIntervalMs,
          lastWrite: runtime.lastWriteAt === 0
            ? null
            : {
                at: new Date(runtime.lastWriteAt).toISOString(),
                channel: runtime.lastWriteChannel,
                request: runtime.lastWriteRequest,
              },
        },
        limits: {
          nvidiaSmi: limits.nvidiaSmi,
          mqtt: {
            topics: limits.mqtt.topics,
            maxPayloadBytes: limits.mqtt.maxPayloadBytes,
            numeric: summarizeNumericRules(limits.mqtt.numeric),
          },
        },
        hardEnvelope: summarizeHardEnvelope(),
        channels: {
          'nvidia-smi': { gpuIndex: config.nvidiaSmi?.gpuIndex ?? 0, ops: NVIDIA_OPS },
          mqtt: { host: config.mqtt?.host, port: config.mqtt?.port, controlTopics: limits.mqtt.topics },
          http: { allowHosts: config.http?.allowHosts ?? [] },
          command: { allowPrograms: config.command?.allowPrograms ?? [], allowPaths: config.command?.allowPaths ?? [] },
        },
        config: { path: configFile, source, warnings },
        audit: { path: deps.auditPath(config), recent, ...(auditFailure === undefined ? {} : { error: auditFailure }) },
      }
    },
  })
}

// ───────────────────────────── 插件入口 ─────────────────────────────

/**
 * **仅测试用**：清空进程级写入冷却/最近写入状态。
 * 生产代码不要调用（写入冷却正是靠这份状态生效）。
 */
export function resetRuntimeStateForTests() {
  runtime.lastWriteAt = 0
  runtime.lastWriteChannel = null
  runtime.lastWriteRequest = null
  runtime.lastWriteResult = null
}

/**
 * 插件激活：注册三个工具。
 * @param {object} ctx - cordis 上下文（需要 ctx.tools）。
 * @param {object} [config] - 来自 cordis.patch.yml 的配置；支持 `configPath` 覆盖配置文件路径，
 *   `__test__` 仅用于单元测试注入内部依赖（不要写进 profile 配置）。
 */
export function apply(ctx, config = {}) {
  const deps = resolveDeps(config)
  const tools = [
    createReadTool(deps, config),
    createTuneTool(deps, config),
    createLimitsTool(deps, config),
  ]
  const disposers = []
  for (const tool of tools) disposers.push(ctx.tools.register(tool))
  // 插件卸载/热重载时撤销注册，避免同名工具重复注册。
  const dispose = () => {
    while (disposers.length > 0) {
      const disposer = disposers.pop()
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        // 注销失败不阻塞卸载。
      }
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'perf-tune tools')
  } else {
    // 没有 effect 能力时至少保证返回可用的清理函数。
    return { dispose }
  }
  return { dispose }
}
