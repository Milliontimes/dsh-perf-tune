/**
 * 工具层单元测试（Lead 所有）：用 mock ctx + 注入的假通道/假审计，
 * 覆盖 index.js 的注册、参数校验、dry-run、四道写入闸、审计与 perf_limits。
 *
 * 不碰真实硬件、不发真实 MQTT、不读写真实 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { apply, resetRuntimeStateForTests } from '../index.js'
import { defaultConfig } from '../lib/config.js'
import { effectiveLimits } from '../lib/envelope.js'

// ───────────── 测试脚手架 ─────────────

/** mock cordis ctx：只实现插件用到的 tools.register 与 effect。 */
function createMockCtx() {
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        const dispose = () => registered.delete(definition.name)
        disposers.push(dispose)
        return dispose
      },
    },
    effect(callback, _label) {
      disposers.push(callback())
      return () => {}
    },
    on() {},
  }
  return { ctx, registered, disposers }
}

/** 假通道：记录调用、返回预设结果。 */
function createFakeChannels(results = {}) {
  const calls = { nvidiaRead: [], nvidiaWrite: [], mqttRead: [], mqttPublish: [], httpRead: [], commandRead: [] }
  return {
    calls,
    createNvidiaChannel: () => ({
      async read(params) {
        calls.nvidiaRead.push(params)
        return results.nvidiaRead ?? { kind: 'nvidia-smi', gpuIndex: 0, fields: [{ name: 'power.draw', raw: '11.09', value: 11.09 }], warnings: [] }
      },
      async write(op) {
        calls.nvidiaWrite.push(op)
        return results.nvidiaWrite ?? { op: op.op, applied: true, commands: [{ args: [], code: 0, stdout: '', stderr: '' }], verify: { checked: true, ok: true, observed: { 'clocks.gr': 1600 }, note: '' }, warnings: [] }
      },
    }),
    createMqttChannel: () => ({
      async read(params) {
        calls.mqttRead.push(params)
        return results.mqttRead ?? { kind: 'mqtt', messages: [{ topic: 'Customize/SupportInfo', payload: '{}', retained: true, qos: 0 }], warnings: [] }
      },
      async publish(params) {
        calls.mqttPublish.push(params)
        return results.mqttPublish ?? { kind: 'mqtt', sent: true, topic: params.topic, bytes: Buffer.byteLength(params.payload) }
      },
    }),
    createHttpChannel: () => ({
      async read(params) {
        calls.httpRead.push(params)
        return results.httpRead ?? { kind: 'http', url: params.url, status: 200, value: { ok: true }, truncated: false, warnings: [] }
      },
    }),
    createCommandChannel: () => ({
      async read(params) {
        calls.commandRead.push(params)
        return results.commandRead ?? { kind: 'command', program: params.program, args: params.args, code: 0, stdout: 'x', stderr: '', truncated: false, timedOut: false }
      },
    }),
  }
}

/** 内存审计替身：appendAudit 记录到哪里，readAuditTail 读回来。 */
function createFakeAudit(entries) {
  return {
    entries,
    appendAudit: async (entry) => {
      entries.push(entry)
      return { path: '<memory>', bytes: 0 }
    },
    readAuditTail: async ({ limit = 10 } = {}) => entries.slice(-limit).reverse(),
    auditPath: (config) => config.audit?.path ?? '<memory>/audit.jsonl',
    configPath: () => '<memory>/config.json',
  }
}

/** 组装一个可用的插件环境。 */
function createHarness({ configOverrides = {}, auditFails = false } = {}) {
  const { ctx, registered } = createMockCtx()
  const channels = createFakeChannels()
  const auditEntries = []
  const audit = createFakeAudit(auditEntries)
  if (auditFails) {
    audit.appendAudit = async () => {
      const { PerfError } = await import('../lib/errors.js')
      throw new PerfError('E_IO', '模拟审计写入失败')
    }
  }
  let clock = 1_000_000
  const config = { ...defaultConfig(), ...configOverrides }
  const deps = {
    ...channels,
    ...audit,
    loadConfig: async () => ({ config, source: 'test', path: '<memory>/config.json', warnings: [] }),
    now: () => clock,
  }
  const instance = apply(ctx, { __test__: deps })
  return {
    ctx,
    registered,
    channels,
    auditEntries,
    config,
    instance,
    /** 推进假时钟（毫秒）。 */
    advanceClock(ms) {
      clock += ms
    },
    tool(name) {
      const definition = registered.get(name)
      assert.ok(definition, `工具 ${name} 未注册`)
      return definition
    },
  }
}

/** 调用一个工具（模拟注册表：先按 schema 校验参数，再执行）。 */
async function callTool(harness, name, args) {
  const definition = harness.tool(name)
  return await definition.execute(args, { signal: undefined })
}

/** 断言一次调用抛出带指定错误码的消息。 */
async function assertRejectsWith(harness, name, args, codePattern) {
  await assert.rejects(
    () => callTool(harness, name, args),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, codePattern)
      return true
    },
  )
}

// ───────────── 测试 ─────────────

describe('插件注册', () => {
  test('apply() 注册 perf_read / perf_tune / perf_limits 且返回 dispose', () => {
    const harness = createHarness()
    assert.deepEqual([...harness.registered.keys()].sort(), ['perf_limits', 'perf_read', 'perf_tune'])
    assert.equal(typeof harness.instance.dispose, 'function')

    const read = harness.tool('perf_read')
    assert.equal(read.parameters.type, 'object')
    assert.equal(read.parameters.additionalProperties, false)
    assert.deepEqual(read.parameters.required, ['source'])
    assert.ok(read.parameters.properties.source.enum.includes('nvidia-smi'))
    assert.equal(typeof read.output.render, 'function')
    // 输出 schema 不能约束过死（通道结果异构）
    assert.deepEqual(read.output.schema, {})
  })

  test('dispose 后工具被注销（模拟热卸载）', () => {
    const harness = createHarness()
    harness.instance.dispose()
    assert.equal(harness.registered.size, 0)
  })
})

describe('perf_read', () => {
  test('nvidia-smi 通道：字段透传、结果合并 config 元信息', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_read', {
      source: 'nvidia-smi',
      fields: ['power.draw', 'temperature.gpu'],
      gpuIndex: 0,
      timeoutMs: 9000,
    })
    assert.equal(result.kind, 'nvidia-smi')
    assert.equal(result.fields[0].value, 11.09)
    assert.equal(result.config.source, 'test')
    assert.equal(harness.channels.calls.nvidiaRead.length, 1)
    assert.deepEqual(harness.channels.calls.nvidiaRead[0].fields, ['power.draw', 'temperature.gpu'])
    assert.equal(harness.channels.calls.nvidiaRead[0].timeoutMs, 9000)
  })

  test('nvidia-smi 缺 fields / 非法字段名 → E_ARGS', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_read', { source: 'nvidia-smi' }, /\[E_ARGS\]/)
    await assertRejectsWith(harness, 'perf_read', { source: 'nvidia-smi', fields: ['bad field; rm -rf /'] }, /\[E_ARGS\]/)
    await assertRejectsWith(harness, 'perf_read', { source: 'nvidia-smi', fields: [] }, /\[E_ARGS\]/)
  })

  test('mqtt 通道：默认 topics ["#"]、waitMs 收敛到默认值', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_read', { source: 'mqtt' })
    assert.equal(result.kind, 'mqtt')
    const call = harness.channels.calls.mqttRead[0]
    assert.deepEqual(call.topics, ['#'])
    assert.equal(call.waitMs, 1200)
    assert.equal(call.maxMessages, 100)
  })

  test('mqtt waitMs 越界/非整数 → E_ARGS（不静默 clamp）', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_read', { source: 'mqtt', waitMs: 99999 }, /\[E_ARGS\]/)
    await assertRejectsWith(harness, 'perf_read', { source: 'mqtt', waitMs: 1.5 }, /\[E_ARGS\]/)
  })

  test('http / command 通道参数缺失 → E_ARGS', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_read', { source: 'http' }, /\[E_ARGS\]/)
    await assertRejectsWith(harness, 'perf_read', { source: 'command' }, /\[E_ARGS\]/)
    const ok = await callTool(harness, 'perf_read', { source: 'http', url: 'http://127.0.0.1:4014/api/gpus', path: 'gpus.0.power_w' })
    assert.equal(ok.kind, 'http')
    assert.deepEqual(harness.channels.calls.httpRead[0].path, 'gpus.0.power_w')
  })

  test('未知参数（additionalProperties:false）→ E_ARGS', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_read', { source: 'mqtt', nonsense: 1 }, /\[E_ARGS\]/)
  })
})

describe('perf_tune — nvidia-smi', () => {
  beforeEach(() => resetRuntimeStateForTests())

  test('dry-run（默认）：不写硬件、返回规范化 request 与包线、落 dry-run 审计', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1600 })
    assert.equal(result.dryRun, true)
    assert.deepEqual(result.request.op, { op: 'lock-core', mhz: 1600, gpuIndex: 0 })
    assert.deepEqual(result.limits, { min: 300, max: 2500 })
    assert.equal(harness.channels.calls.nvidiaWrite.length, 0)
    assert.equal(harness.auditEntries.length, 1)
    assert.equal(harness.auditEntries[0].decision, 'dry-run')
  })

  test('冷却未到时第二次写入被 E_COOLDOWN 拒绝（且不触发通道）', async () => {
    const harness = createHarness()
    await callTool(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1500, apply: true })
    assert.equal(harness.channels.calls.nvidiaWrite.length, 1)
    harness.advanceClock(200)
    await assertRejectsWith(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1600, apply: true }, /\[E_COOLDOWN\]/)
    assert.equal(harness.channels.calls.nvidiaWrite.length, 1)
    harness.advanceClock(2000)
    await callTool(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1600, apply: true })
    assert.equal(harness.channels.calls.nvidiaWrite.length, 2)
  })

  test('apply:true：intent → 执行 → applied 三段审计，结果透传 verify', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-mem', mhz: 7000, apply: true })
    assert.equal(result.dryRun, false)
    assert.equal(result.result.applied, true)
    assert.equal(result.result.verify.ok, true)
    assert.deepEqual(harness.auditEntries.map((entry) => entry.decision), ['intent', 'applied'])
    assert.equal(harness.channels.calls.nvidiaWrite[0].op, 'lock-mem')
    assert.equal(harness.channels.calls.nvidiaWrite[0].mhz, 7000)
  })

  test('越界立即 E_SAFETY（不静默 clamp、不写、不审计）', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 3000, apply: true }, /\[E_SAFETY\]/)
    assert.equal(harness.channels.calls.nvidiaWrite.length, 0)
    assert.equal(harness.auditEntries.length, 0)
  })

  test('mhz / mhzRange 同给 → E_ARGS；op 缺失 → E_ARGS', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1500, mhzRange: { min: 1500, max: 1600 } }, /\[E_ARGS\]/)
    await assertRejectsWith(harness, 'perf_tune', { channel: 'nvidia-smi' }, /\[E_ARGS\]/)
  })

  test('writes.enabled=false → E_WRITE_DISABLED（但 dry-run 仍可用）', async () => {
    const harness = createHarness({ configOverrides: { writes: { enabled: false, minIntervalMs: 1500 } } })
    const dry = await callTool(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1500 })
    assert.equal(dry.dryRun, true)
    await assertRejectsWith(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1500, apply: true }, /\[E_WRITE_DISABLED\]/)
    assert.equal(harness.channels.calls.nvidiaWrite.length, 0)
  })

  test('审计写失败 → 拒绝执行硬件写入（不产生无痕迹写入）', async () => {
    const harness = createHarness({ auditFails: true })
    await assertRejectsWith(harness, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 1500, apply: true }, /\[E_IO\]/)
    assert.equal(harness.channels.calls.nvidiaWrite.length, 0)
  })
})

describe('perf_tune — mqtt', () => {
  beforeEach(() => resetRuntimeStateForTests())

  test('dry-run：返回规范化 payload 与已校验数值字段，不发布', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_tune', {
      channel: 'mqtt',
      topic: 'Customize/Control',
      payload: JSON.stringify({ GPU: { ConfigurableTGPSwitch: 1, ConfigurableTGPTarget: 115, DynamicBoost: 25 } }),
    })
    assert.equal(result.dryRun, true)
    assert.equal(result.request.topic, 'Customize/Control')
    assert.equal(result.request.payload.GPU.ConfigurableTGPTarget, 115)
    assert.ok(result.request.checked.some((item) => item.key === 'ConfigurableTGPTarget' && item.value === 115))
    assert.equal(harness.channels.calls.mqttPublish.length, 0)
    assert.equal(harness.auditEntries[0].decision, 'dry-run')
  })

  test('模式切换指令 {"Action":"OPERATING_TURBO_MODE"} 可以通过包线', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_tune', { channel: 'mqtt', topic: 'Fan/Control', payload: '{"Action":"OPERATING_TURBO_MODE"}' })
    assert.equal(result.dryRun, true)
    assert.equal(result.request.payload.Action, 'OPERATING_TURBO_MODE')
  })

  test('topic 不在白名单 / TGP 越界 / 未知数值 key → E_SAFETY', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_tune', { channel: 'mqtt', topic: 'System/Control', payload: '{"Action":"X"}' }, /\[E_SAFETY\]/)
    await assertRejectsWith(harness, 'perf_tune', { channel: 'mqtt', topic: 'Customize/Control', payload: '{"ConfigurableTGPTarget":141}' }, /\[E_SAFETY\]/)
    await assertRejectsWith(harness, 'perf_tune', { channel: 'mqtt', topic: 'Customize/Control', payload: '{"MysteryValue":10}' }, /\[E_SAFETY\]/)
  })

  test('payload 非 JSON → E_ARGS；JSON 根不是对象 → E_SAFETY', async () => {
    const harness = createHarness()
    await assertRejectsWith(harness, 'perf_tune', { channel: 'mqtt', topic: 'Fan/Control', payload: 'not-json' }, /\[E_ARGS\]/)
    // 契约 §8.4：根不是普通对象 → E_SAFETY/E_ARGS（实现取 E_SAFETY）
    await assertRejectsWith(harness, 'perf_tune', { channel: 'mqtt', topic: 'Fan/Control', payload: '[1,2,3]' }, /\[E_SAFETY\]/)
  })

  test('apply:true 发布规范化 JSON 文本（不是原字符串）并记录 intent/applied', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_tune', {
      channel: 'mqtt',
      topic: 'Fan/Control',
      payload: '{ "Action" : "OPERATING_OFFICE_MODE" }',
      qos: 1,
      apply: true,
    })
    assert.equal(result.dryRun, false)
    const published = harness.channels.calls.mqttPublish[0]
    assert.equal(published.topic, 'Fan/Control')
    assert.equal(published.payload, '{"Action":"OPERATING_OFFICE_MODE"}')
    assert.equal(published.qos, 1)
    assert.deepEqual(harness.auditEntries.map((entry) => entry.decision), ['intent', 'applied'])
  })
})

describe('perf_limits', () => {
  test('返回硬包线、生效包线、写入开关、配置与审计信息', async () => {
    const harness = createHarness()
    const result = await callTool(harness, 'perf_limits', {})
    assert.equal(result.ok, true)
    assert.equal(result.writes.enabled, true)
    assert.equal(result.writes.minIntervalMs, 1500)
    assert.deepEqual(result.limits.nvidiaSmi.coreMhz, { min: 300, max: 2500 })
    assert.ok(result.limits.mqtt.topics.includes('Fan/Control'))
    assert.equal(result.limits.mqtt.maxPayloadBytes === undefined ? 2048 : result.limits.mqtt.maxPayloadBytes, 2048)
    assert.ok(result.hardEnvelope.mqtt.numericRules.some((rule) => rule.key === 'ConfigurableTGPTarget'))
    assert.deepEqual(result.channels['nvidia-smi'].ops.includes('lock-core'), true)
    assert.equal(result.config.source, 'test')
    assert.equal(typeof result.audit.path, 'string')
  })

  test('配置非法时返回 ok:false + 错误码，而不是抛错', async () => {
    const { PerfError } = await import('../lib/errors.js')
    const mock = createMockCtx()
    apply(mock.ctx, {
      __test__: {
        loadConfig: async () => {
          throw new PerfError('E_CONFIG', '模拟配置错误：JSON 解析失败')
        },
        configPath: () => '<memory>/config.json',
      },
    })
    const limitsTool = mock.registered.get('perf_limits')
    const result = await limitsTool.execute({}, { signal: undefined })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'E_CONFIG')
    assert.match(result.error.message, /模拟配置错误/)
  })
})

describe('配置收窄（真实 envelope 集成）', () => {
  const narrowedLimits = {
    nvidiaSmi: { coreMhz: { min: 800, max: 2000 } },
    mqtt: { numeric: { ConfigurableTGPTarget: { min: 60, max: 115 } } },
  }

  test('effectiveLimits 把核心锁频收窄到 800..2000', () => {
    const limits = effectiveLimits({ ...defaultConfig(), limits: narrowedLimits })
    assert.deepEqual(limits.nvidiaSmi.coreMhz, { min: 800, max: 2000 })
  })

  test('收窄后 2100 MHz 被拒；默认包线则放行；TGP 115 放行 / 116 拒绝', async () => {
    const wide = createHarness()
    const allowed = await callTool(wide, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 2100 })
    assert.equal(allowed.dryRun, true)

    const narrow = createHarness({ configOverrides: { limits: narrowedLimits } })
    await assertRejectsWith(narrow, 'perf_tune', { channel: 'nvidia-smi', op: 'lock-core', mhz: 2100 }, /\[E_SAFETY\]/)
    const tgpOk = await callTool(narrow, 'perf_tune', { channel: 'mqtt', topic: 'Customize/Control', payload: '{"ConfigurableTGPTarget":115}' })
    assert.equal(tgpOk.dryRun, true)
    await assertRejectsWith(narrow, 'perf_tune', { channel: 'mqtt', topic: 'Customize/Control', payload: '{"ConfigurableTGPTarget":116}' }, /\[E_SAFETY\]/)
  })
})

// 清理：测试没有创建真实文件，保险起见清一次临时目录（若有）
let scratch
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-perf-tune-tools-'))
})
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})
