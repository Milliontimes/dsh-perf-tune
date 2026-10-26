# dsh-perf-tune 实现契约（v1，2026-10-26）

DSH（DeepSeek Harness）插件：给 agent 提供「读本机性能指标 / 调频 / 限定安全范围」的工具集。
理论依据：OEM 控制台逆向结论（控制台本地 MQTT 总线 + nvidia-smi/NVML 能力边界）。

**设计原则**

1. **机制与知识分离**：插件不内置任何"指标清单/控制清单"。指标与控制由调用方参数描述（agent 借助记忆系统知道该读什么、写什么）。
2. **不可放宽的安全包线**：写入的目标值统一经过 `lib/envelope.js` 的硬包线校验（核心/显存频率、TGP、显存偏移……），配置文件只能**收窄**，不能放宽。
3. **写入四道闸**：`writes.enabled` 开关 → 每次调用显式 `apply: true` → 数值包线校验 → 冷却时间 + 审计 + 写后回读校验。
4. **零运行时依赖**：只能 `import` `node:` 内置模块与包内相对路径。**禁止** `import '@deepseek-ai/*'` 或任何第三方包（插件目录是 `link:` 安装，Node 解析不到 profile 的 node_modules）。

---

## 0. 目录与文件所有权（禁止越界写别的文件）

| 文件 | 负责人 | 说明 |
| --- | --- | --- |
| `CONTRACT.md` | Lead | 本契约 |
| `index.js` | Lead | 插件入口：`name`/`inject`/`apply`，注册 3 个工具，编排调用 |
| `package.json`, `cordis.patch.yml` | Lead | bundle 清单与插桩 |
| `lib/errors.js` | T3 | `PerfError` 与错误码 |
| `lib/config.js` | T3 | 默认配置 + 加载/校验 |
| `lib/envelope.js` | T3 | 硬安全包线 + 配置收窄 + 写入校验 |
| `lib/audit.js` | T3 | JSONL 审计追加/读尾部 |
| `lib/run.js` | T2 | 子进程执行封装（shell:false、超时、截断） |
| `lib/channel-nvidia.js` | T2 | nvidia-smi 读 / 锁频 / 复位 / 回读校验 |
| `lib/channel-http.js` | T2 | HTTP GET + JSON 取值 |
| `lib/channel-command.js` | T2 | 只读命令通道（白名单） |
| `lib/mqtt-client.js` | T1 | 最小 MQTT 3.1.1 客户端（零依赖） |
| `lib/channel-mqtt.js` | T1 | MQTT 读（订阅收消息）/ 发布 |
| `test/*.test.mjs` | 各自 | `node --test test/` 必须全绿 |
| `README.md`, `config/perf.example.json`, `scripts/live-read.mjs`, `test/tools.test.mjs` | Lead | 文档 / 示例 / 实测脚本 / 工具层测试 |

> 不要运行 `npm/pnpm install`，不要联网，不要对真实硬件**写入**（只读命令可以跑，例如 `nvidia-smi --query-gpu=...`、MQTT 订阅）。

---

## 1. 运行环境约束

- ESM：`package.json` 里 `"type": "module"`；`lib/*.js` 直接用 `export`。
- Node ≥ 22（Electron host 内运行）。不要用 Electron API、不要 top-level await。
- 所有 I/O 函数必须接受可选 `AbortSignal`（参数名 `signal`）并在 `abort` 时尽快结束；抛出的取消错误用 `PerfError('E_IO', '已取消')`。
- 执行外部程序一律 `child_process.execFile`（`shell: false`），**绝不**拼 shell 字符串。
- 不要 `console.log`（会污染 host 输出）；需要诊断用返回值的 `warnings: string[]`。
- 时间/随机可注入，便于测试：工厂函数参数 `deps` 里带 `{ run, now, sleep, fetch, connect }`，默认用真实实现。
- 测试内不得依赖网络/真实 GPU/真实 MQTT broker（唯一例外：`test/mqtt-client.test.mjs` 可以起一个 **本进程内 loopback TCP 假 broker**）。

---

## 2. 错误约定（`lib/errors.js`，T3）

```js
export class PerfError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details)
}
export function isPerfError(value)
```

固定错误码（其它模块只能从这里取）：

| code | 含义 |
| --- | --- |
| `E_ARGS` | 参数不合法（缺失/类型错/互斥字段冲突） |
| `E_CONFIG` | 配置文件缺失、JSON 解析失败、字段非法、配置试图放宽硬包线 |
| `E_CHANNEL` | 通道执行失败（外部程序非零退出、HTTP 非 2xx、MQTT CONNACK 拒绝等） |
| `E_NOT_FOUND` | 目标不存在（nvidia-smi 不存在、JSON path 无值、topic 无 retained） |
| `E_TIMEOUT` | 超时 |
| `E_SAFETY` | 写入值越界或被硬包线拒绝 |
| `E_WRITE_DISABLED` | `writes.enabled` 为 false |
| `E_COOLDOWN` | 距上次写入太近 |
| `E_ADMIN_REQUIRED` | 需要管理员权限（nvidia-smi 写操作典型） |
| `E_UNSUPPORTED` | 该操作/字段/能力不被当前环境支持 |
| `E_IO` | 本地 I/O（审计文件、配置文件读写）失败；也用于取消 |

`message` 必须自解释（工具层最终只把 `message` 展示给模型，`details` 不会外露）。示例：
`new PerfError('E_SAFETY', '核心锁频 3000 MHz 超出硬包线 300..2500 MHz')`。

---

## 3. `lib/run.js`（T2）

```js
export async function run(program, args = [], options = {})
```

`options`: `{ timeoutMs = 15000, maxBytes = 262144, signal, env, cwd }`

返回：
```js
{ program, args, code: number|null, stdout: string, stderr: string,
  timedOut: boolean, truncated: boolean, durationMs: number }
```

规则：

- `program` 非空字符串；`args` 必须是 `string[]`，否则 `E_ARGS`。
- `shell: false`；`windowsHide: true`。
- 超时：杀掉进程（Windows 用 `process.kill(pid)` 或 `taskkill /PID <pid> /T /F` 兜底），返回 `code: null, timedOut: true`（**不抛错**，由调用方判断）。
- 程序不存在（`ENOENT`）→ `E_NOT_FOUND`，`details: { program }`。
- `signal` 取消 → 杀进程并抛 `PerfError('E_IO', '已取消')`。
- `stdout/stderr` 按 UTF-8 解码；超过 `maxBytes` 截断并置 `truncated: true`。
- 非零退出**不抛**（返回 `code`），便于通道决定语义。

---

## 4. `lib/channel-nvidia.js`（T2）

```js
export function createNvidiaChannel({ config, deps } = {})
// deps: { run, now, sleep }，默认用 lib/run.js 的 run 与真实计时
```

返回对象：
```js
{
  kind: 'nvidia-smi',
  async read(params, { signal } = {}) -> {
    kind: 'nvidia-smi',
    gpuIndex: number,
    fields: [ { name: string, raw: string, value: number|string|null } ],
    warnings: string[]
  },
  async write(op, { signal } = {}) -> {
    op: string,
    applied: boolean,
    commands: [ { args: string[], code: number|null, stdout: string, stderr: string } ],
    verify: { checked: boolean, ok: boolean|null, observed: object|null, note: string },
    warnings: string[]
  }
}
```

### 4.1 read

参数：`{ fields: string[], gpuIndex?: number, timeoutMs?: number }`

- `fields` 必须是非空 `string[]`，每项匹配 `/^[A-Za-z0-9_.]+$/`，最多 64 个；否则 `E_ARGS`（**不要**内置字段白名单——nvidia-smi 自己不认识的字段会报错，把 stderr 转成 `E_CHANNEL`）。
- gpuIndex 默认取 `config.nvidiaSmi?.gpuIndex ?? 0`。
- 执行：`["--query-gpu=" + fields.join(","), "--format=csv,noheader,nounits", "-i", String(gpuIndex)]`
- 解析第一行 CSV：按 `,` 切分后 `trim()`（去掉可能的引号）。`"[N/A]"`/`"N/A"` → `value: null`；纯数字（含负号、小数）→ `Number`；`"[Not Supported]"` → `null`；其它保留字符串。字段数与 query 不一致 → `E_CHANNEL`（附 stderr）。
- 退出码非 0 → `E_CHANNEL`，message 含 stderr 前 300 字。stderr 含 `Insufficient Permissions` 或 `admin` 时错误码改 `E_ADMIN_REQUIRED`。

### 4.2 write

`op` 为对象，`op.op` 取值：

| op.op | 必填 | nvidia-smi 参数 | 说明 |
| --- | --- | --- | --- |
| `lock-core` | `mhz`: number 或 `{min,max}` | `-lgc <spec>` | spec=`1600` 或 `1650,1800` |
| `reset-core` | — | `-rgc` | |
| `lock-mem` | `mhz` 同上 | `-lmc <spec>` | |
| `reset-mem` | — | `-rmc` | |
| `reset-all` | — | 先 `-rgc` 再 `-rmc` | 两条都尝试，失败信息合并 |
| `power-limit` | `watts`: number | `-pl <W>` | 本机大概率被驱动拒绝，如实回报 `E_UNSUPPORTED`（stderr 透传） |

- 每次命令都带 `["-i", String(gpuIndex)]` 前缀。
- **本层不再做数值包线校验**——包线由 `index.js` 调用 `lib/envelope.js` 完成，通道只负责「执行 + 如实回报」。但通道仍需拒绝明显非法输入（`mhz` 非正数、非有限数 → `E_ARGS`）。
- 非零退出：`lock-*`/`power-limit` 抛 `E_CHANNEL`/`E_UNSUPPORTED`/`E_ADMIN_REQUIRED`（按 stderr 判断），`reset-*` 抛 `E_CHANNEL`。
- 写入成功后做回读校验（`verify`）：
  - `lock-core`：轮询 `read({fields:['clocks.gr','clocks.max.gr']})` 最多 3 秒（间隔 300ms），拿到数值就停；
    `ok`：空闲期实测时钟可能低于锁定下限，所以「实测值 ≥ 下限×0.5」记 `true`，否则 `false` 但 `note` 说明「空闲降频属正常，需负载下复验」。
  - `lock-mem`：同理读 `clocks.mem`，`ok = 实测值 > 0`，`note` 提示需负载复验。
  - `reset-*`：回读 `clocks.gr`/`clocks.mem`，`ok = null`（无法区分「已解锁」与「仍在锁定」），`note` 说明。
  - 回读本身失败不影响写入结论：`checked:false, ok:null, note` 附错误信息。
- 返回值 `commands` 里只放 `{ args, code, stdout: 头部 200 字, stderr: 头部 300 字 }`。

---

## 5. `lib/mqtt-client.js` + `lib/channel-mqtt.js`（T1）

理论依据（OEM 控制台逆向结论）：`GCUBridge.exe` 是 broker，`127.0.0.1:13688`，MQTT 3.1.1，本机 broker 按 clientId→username→password 表校验。**插件不内置任何凭据**：凭据由 `config.mqtt.read` / `config.mqtt.write` 提供（不同机型/控制台版本可能不同）；未配置时通道报 `E_CONFIG`。

- 读身份：`config.mqtt.read.{clientId,username,password}`
- 写身份：`config.mqtt.write.{clientId,username,password}`
（CONNACK `rc=2` = clientId/username 不匹配，`rc=4` = 密码错；两者都要在 message 里写明。）

### 5.1 `lib/mqtt-client.js`（零依赖，`node:net`）

```js
export async function mqttRead(params, { signal } = {})
// params: { host='127.0.0.1', port=13688, clientId, username, password,
//           topics=['#'], qos=0, waitMs=1200, maxMessages=100, timeoutMs=8000 }
// -> { messages: [ { topic, payload: string, retained: boolean, qos: number } ], warnings: string[] }

export async function mqttPublish(params, { signal } = {})
// params: { host, port, clientId, username, password, topic,
//           payload: string, qos=1, retain=false, timeoutMs=5000 }
// -> { sent: true, topic, bytes: number }
```

实现要求：

- 手写 MQTT 3.1.1 报文（protocol level 4）：`CONNECT`（cleanSession=1）→ 等 `CONNACK` → `SUBSCRIBE`/`PUBLISH` → `DISCONNECT`。
- TCP 流是**可能拆包/粘包**的：必须有按剩余长度字节流累积的收包缓冲；一个 TCP chunk 里可以有多个报文。
- `mqttRead`：连上 → 订阅所有 topics（一个 SUBSCRIBE 报文，packetId=1，qos 用参数）→ 收集 `waitMs` 内所有 PUBLISH（含 `retain=true` 的立即投递）→ 到 `maxMessages` 或 `waitMs` 截止或 `timeoutMs` 兜底 → 发 DISCONNECT → 返回。收包 QoS1 要回 `PUBACK`。`socket` 错误 → 若已有消息则返回并记 `warnings`，否则抛 `E_CHANNEL`。
- `mqttPublish`：`retain` 只接受 `false`（传 true 抛 `E_ARGS`）；`qos` 只接受 0/1（2 → `E_UNSUPPORTED`）；payload 按 UTF-8 编码，>2048 字节抛 `E_ARGS`；QoS1 要等 `PUBACK`（带 `timeoutMs`）再 DISCONNECT。
- `topics` 校验：每项非空 ≤256 字符、不含 `\0`；允许 `#`/`+` 通配（仅读）。
- 报文长度上限 1 MiB，超过 → `E_CHANNEL`。
- 超时统一 `E_TIMEOUT`；连接被拒/ECONNREFUSED → `E_CHANNEL`（message 提示 GCUBridge 未运行）。
- 不要把 socket 泄漏出去；函数结束必须关闭 socket（`destroy()`）。

### 5.2 `lib/channel-mqtt.js`（T1）

```js
export function createMqttChannel({ config, deps } = {})
// deps: { mqttRead, mqttPublish }，默认用 lib/mqtt-client.js
```

```js
{
  kind: 'mqtt',
  async read(params, { signal } = {}) -> 同 mqttRead 返回（kind 换成 'mqtt'）
  async publish(params, { signal } = {}) -> { kind:'mqtt', sent:true, topic, bytes }
}
```

- 端点/凭据默认取 `config.mqtt`：读用 `config.mqtt.read`，写用 `config.mqtt.write`；调用参数可覆盖（测试用）。
- 未配置凭据（`config.mqtt.read/write` 为 null 或 `clientId` 为空）→ `E_CONFIG`（不触网、不调用底层实现），message 指明缺哪个配置段。
- `publish` 的 `payload` 是**字符串**（JSON 文本），本层不做包线校验（由 envelope 做）；但会拒绝 `retain: true` 与 `qos: 2`。
- 发布后**不 retain**、不重试；返回值带 `bytes`。

---

## 6. `lib/channel-http.js` + `lib/channel-command.js`（T2）

### 6.1 HTTP（只读）

```js
export function createHttpChannel({ config, deps } = {}) // deps: { fetch, now }
// read({ url, path?, timeoutMs=5000, headers={} }, { signal })
// -> { kind:'http', url, status, value, bodyText?, truncated: boolean, warnings: [] }
```

- 只允许 `http:`/`https:`；host 必须在 `config.http.allowHosts`（默认 `['127.0.0.1','localhost','::1']`）里，否则 `E_SAFETY`（message 写明允许的 host 列表）。端口不限。
- 非 2xx → `E_CHANNEL`（message 含 status 与 body 前 200 字）。
- body 上限 512 KiB（超限截断置 `truncated:true`）；尝试 `JSON.parse`：成功则 `value` 为解析结果，失败则 `value` 为 `null`、`bodyText` 为前 4 KiB。
- `path`（可选）：点号/下标取值（`gpus.0.power_w`、`gpus[0].power_w` 两种都支持），取不到 → `E_NOT_FOUND`。

### 6.2 命令（只读）

```js
export function createCommandChannel({ config, deps } = {}) // deps: { run }
// read({ program, args=[], timeoutMs=10000 }, { signal })
// -> { kind:'command', program, args, code, stdout, stderr, truncated, timedOut }
```

- `config.command.allowPrograms`（默认 `[]`，元素为 basename，不区分大小写）与 `config.command.allowPaths`（绝对路径精确匹配）组成白名单。`program` 含路径分隔符时只匹配 `allowPaths`；否则按 basename 匹配 `allowPrograms`。不在白名单 → `E_UNSUPPORTED`（message 列出已允许项）。
- 走 `lib/run.js` 的 `run`，`maxBytes` 默认 256 KiB；非零退出**不抛**，返回码交给调用方判断。
- 超时返回 `timedOut: true`（不抛）。

---

## 7. `lib/config.js`（T3）

```js
export function configPath(env = process.env)   // env.DSH_PERF_TUNE_CONFIG 优先，否则 <DSH_HOME 或 ~/.dsh>/perf-tune/config.json
export async function loadConfig({ env = process.env, fs } = {})
// -> { config, source: 'file'|'default', path: string, warnings: string[] }
export function defaultConfig()
export function validateConfig(raw)  // 返回规范化后的 config；非法抛 E_CONFIG
```

默认配置（**必须**与本表逐字段一致）：

```json
{
  "mqtt": {
    "host": "127.0.0.1",
    "port": 13688,
    "read":  null,
    "write": null
  },
  "nvidiaSmi": { "path": null, "gpuIndex": 0 },
  "http": { "allowHosts": ["127.0.0.1", "localhost", "::1"] },
  "command": { "allowPrograms": [], "allowPaths": [] },
  "writes": { "enabled": true, "minIntervalMs": 1500 },
  "limits": {},
  "audit": { "path": null, "maxBytes": 1048576 }
}
```

加载规则：

- 文件不存在 → 返回默认配置，`source:'default'`，`warnings: ['未找到配置文件 <path>，使用内置默认值']`。
- JSON 解析失败 → `E_CONFIG`（message 含路径与 JSON 的错误位置）。
- 文件存在 → 与默认值**深合并**（对象逐键合并，数组整体替换），然后 `validateConfig`。
- `validateConfig` 检查：`mqtt.port` 1..65535；`mqtt.read` / `mqtt.write` 为 null（未配置）或含非空 `clientId` 的凭据对象（`username`/`password` 允许空字符串）；`nvidiaSmi.gpuIndex` 非负整数；`writes.minIntervalMs` 整数 ≥ 1000（低于 1000 收敛到 1000 并记 warning？——**直接抛 E_CONFIG** 更符合"限定安全范围"，选抛错）；`audit.maxBytes` ≥ 4096；允许出现未知键（记入 warnings，不报错）。
- 每次工具调用都重新 `loadConfig`（文件小，不缓存），这样记忆系统改配置无需重启。配置文件里可以包含注释吗？→ **不允许**，只支持纯 JSON（README 说明）。

---

## 8. `lib/envelope.js`（T3）

```js
export const HARD_ENVELOPE = Object.freeze({ ... })   // 见下
export function effectiveLimits(config)   // 硬包线 ∩ config.limits；配置放宽 → E_CONFIG
export function checkNvidiaWrite(op, limits)   // -> { op, argsHint: {...} }；越界 E_SAFETY
export function checkMqttPublish(topic, payloadJson, limits)
// -> { topic, payload: object, bytes, checked: [ { key, value, min, max } ] }；越界 E_SAFETY
```

### 8.1 硬包线（**不可**被配置放宽）

```js
nvidiaSmi: {
  coreMhz:  { min: 300,  max: 2500 },   // 核心锁定频率
  memMhz:   { min: 500,  max: 9000 },   // 显存锁定频率
  powerW:   { min: 60,   max: 140 },    // 整卡功耗（本机 OEM 上限 140W）
},
mqtt: {
  maxPayloadBytes: 2048,
  topics: ['Fan/Control', 'Customize/Control'],   // 控制面硬白名单
  numeric: [                                        // 按 key 匹配的数值包线
    { key: 'ConfigurableTGPTarget',  match: /^ConfigurableTGPTarget$/i,  min: 60,  max: 140 },
    { key: 'ConfigurableTGPSwitch',  match: /^ConfigurableTGPSwitch$/i,  min: 0,   max: 1   },
    { key: 'DynamicBoost',           match: /^DynamicBoost$/i,           min: 0,   max: 25  },
    { key: 'DynamicBoostSwitch',     match: /^DynamicBoostSwitch$/i,     min: 0,   max: 1   },
    { key: 'TargetTemperature',      match: /^TargetTemperature$/i,      min: 60,  max: 87  },
    { key: 'coreOffset',             match: /core.*(offset|freq)/i,      min: 0,   max: 250 },
    { key: 'memOffset',              match: /mem.*(offset|freq)/i,       min: -2000, max: 2000 },
    { key: 'fanDuty',                match: /fan.*(speed|duty|pwm|percent)/i, min: 0, max: 100 },
    { key: 'pl1pl2',                 match: /^PL[12]$/i,                 min: 60,  max: 150 },
    { key: 'pl4',                    match: /^PL4$/i,                    min: 60,  max: 220 },
    { key: 'temperature',            match: /temp(erature)?(limit|target)/i, min: 50, max: 87 },
  ],
  unknownNumericKeys: 'reject',   // 规则未匹配到的数值型 key → E_SAFETY
},
write: { hardMinIntervalMs: 1000, maxPayloadDepth: 8 },
```

### 8.2 `effectiveLimits(config)`

- 起点是硬包线；`config.limits` 支持收窄：
  ```json
  { "nvidiaSmi": { "coreMhz": {"min": 800, "max": 2000},
                   "memMhz":  {"min": 500, "max": 8001},
                   "powerW":  {"min": 100, "max": 140} },
    "writes": { "minIntervalMs": 5000 },
    "mqtt": { "numeric": { "ConfigurableTGPTarget": {"min": 60, "max": 115} } } }
  ```
- 收窄规则：`newMin >= hard.min`、`newMax <= hard.max`、`newMin < newMax`；任何一条不满足 → `E_CONFIG`（message 写明配置项与允许区间）。`config.limits.nvidiaSmi.*` 的键只允许 `coreMhz|memMhz|powerW`。
- 返回结构：`{ nvidiaSmi: {...}, mqtt: {...含已收窄的 numeric 规则}, writes: { enabled, minIntervalMs, hardMinIntervalMs } }`。

### 8.3 `checkNvidiaWrite(op, limits)`

- 支持 `lib/channel-nvidia.js` 的 op：`lock-core/lock-mem` 的 `mhz`（number 或 `{min,max}`）必须落在对应包线内、整数化（`Math.round`）、`min<=max`；`power-limit` 的 `watts` 落在 `powerW`；`reset-*` 不需要数值。
- 返回 `{ op: { ...规范化后的 op }, limits: { min, max } }`；越界 → `E_SAFETY`（message 给出实际值与允许区间，**不静默 clamp**）。

### 8.4 `checkMqttPublish(topic, payloadJson, limits)`

- `topic` 必须在 `limits.mqtt.topics` 里（精确匹配，**不做前缀匹配**），否则 `E_SAFETY`。
- `payloadJson` 字符串按 UTF-8 计算字节数，> `maxPayloadBytes` → `E_SAFETY`。
- `JSON.parse` 失败、根不是普通对象、含 `__proto__`/`constructor`/`prototype` 键、嵌套深度 > 8 → `E_SAFETY`/`E_ARGS`（解析失败用 `E_ARGS`）。
- 递归遍历：数值/布尔值 → 依次匹配 `numeric` 规则（首个匹配生效）；命中后校验区间，并把 `{key,value,min,max}` 记进 `checked`；未命中任何规则的数值/布尔 → `E_SAFETY`（message 列出未知 key）。
- 字符串值：不校验内容，但单个字符串 > 256 字符 → `E_SAFETY`；`Action` 类字符串同样适用。
- 数组：允许，元素同样递归校验（深度计 1）。
- 返回 `{ topic, payload, bytes, checked }`。
- `limits.mqtt.numeric` 里配置收窄过的项要参与匹配（配置项 key = 硬包线规则 key，如 `ConfigurableTGPTarget`）。

---

## 9. `lib/audit.js`（T3）

```js
export function auditPath(config, env = process.env)   // config.audit.path || <DSH_HOME 或 ~/.dsh>/perf-tune/audit.jsonl
export async function appendAudit(entry, { config, env, fs } = {})
// -> { path, bytes }；同时处理目录创建与超过 maxBytes 的单次轮转（改名 audit.jsonl.1 覆盖旧的）
export async function readAuditTail({ limit = 10, config, env, fs } = {})
// -> [entry...] 最新在前；文件不存在返回 []
```

`entry` 形状（由 `index.js` 构造，字段固定）：

```js
{ ts: '2026-10-26T19:40:00.000Z', tool: 'perf_tune',
  decision: 'dry-run'|'intent'|'applied'|'rejected'|'failed',
  channel: 'nvidia-smi'|'mqtt', request: object, reason?: string, result?: object }
```

> `intent` 是写入执行前落盘的「意图」记录（先写 intent 再动硬件），`applied`/`failed` 是执行结果；
> `rejected` 预留给闸门拒绝（当前实现拒绝时直接抛错、不落审计，见 §13）。

- 一行一条 JSON（`JSON.stringify`），行尾 `\n`，UTF-8；单条 entry 序列化后 > 8 KiB 时对 `request/result` 做截断（保留前 4 KiB 字符串化内容 + `_truncated: true`）。
- 写失败抛 `E_IO`（message 含路径），由 `index.js` 决定是否降级为 warning（**已发生的硬件写入必须尽量留痕**：`index.js` 会先写 intent 再执行）。

---

## 10. `index.js`（工具层，Lead）

- `export const name = 'perf-tune'`；`export const inject = ['tools']`；`export function apply(ctx, config = {})`。
- 注册 3 个工具（原始 JSON Schema 定义，不走 `defineTool`）：
  - `perf_read`：`{ source: 'nvidia-smi'|'mqtt'|'http'|'command', fields?, gpuIndex?, topics?, waitMs?, url?, path?, program?, args?, timeoutMs? }`
  - `perf_tune`：`{ channel: 'nvidia-smi'|'mqtt', apply?: boolean（默认 false）, op?, mhz?, watts?, gpuIndex?, topic?, payload?, qos? }`
  - `perf_limits`：`{}`
- 每次调用：`loadConfig()` → `effectiveLimits()` → 通道调用 → 审计；写入路径额外做 `writes.enabled`、`apply`、冷却（`minIntervalMs`，硬下限 1000ms）、intent 审计、执行、结果审计、回读校验透传。
- 工具参数校验必须自己做（原始注册不会自动校验），非法 → 抛 `PerfError('E_ARGS', ...)`；工具层抛错前统一格式化为 `Error('[<code>] <message>')`。
- 返回值统一是普通 JSON；`perf_tune` 的 dry-run 返回 `{ dryRun: true, channel, request: <规范化后的请求>, limits: <相关包线> }`。

---

## 11. 测试要求

- 每个模块至少一个 `test/<module>.test.mjs`，用 `node:test` + `node:assert/strict`。
- `node --test test/` 必须全绿（cwd = `<仓库根目录>`）。
- 不得依赖真实硬件/网络；MQTT 客户端测试用本进程 loopback 假 broker（监听 `127.0.0.1:0` 取随机端口）。
- 覆盖点：
  - T1：CONNACK rc=0/rc=2/rc=4、粘包/拆包、retained 消息、QoS1 PUBACK、超时、publish retain=true 拒绝、payload>2048 拒绝、topics 校验、未配置凭据 → `E_CONFIG`。
  - T2：字段解析（含 `[N/A]`、小数、负号）、字段数不匹配、非零退出、超时、ENOENT、锁频 args 拼装、reset-all 两条命令、回读轮询、HTTP allowHosts/非 2xx/JSON path、命令白名单。
  - T3：默认配置深合并（`mqtt.read/write` 默认 null）、坏 JSON、放宽包线拒绝、收窄成功、nvidia op 越界、mqtt topic 白名单、未知数值 key 拒绝、深度/大小限制、audit 追加+尾部读取+轮转。

---

## 12. 汇报格式（teammate → Lead）

完成后给 Lead 一条消息，包含：

1. 实际写入的文件清单（相对 `<仓库根目录>`）。
2. `node --test test/` 的通过/失败统计。
3. 与契约不一致或需要 Lead 决策的地方（如果有）。
4. 你做过的**只读**实机验证（如有）：命令 + 关键输出（例如 `nvidia-smi --query-gpu=...`）。

---

## 13. 实现偏差与定案（2026-10-26 收尾时 Lead 确认）

以下与上面条款的字面描述有出入，均为实现中发现的更好/唯一可行做法，**已定案**：

1. **`lib/run.js` 用 `spawn({ shell: false })` 而不是字面 `execFile`**。原因：Node 26 的
   `execFile` 在 `maxBuffer` 溢出时会直接杀掉子进程并丢失退出码（`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`），
   无法同时满足 §3「截断但正常返回」。`spawn` 同样零 shell、不拼任何 shell 字符串，仅自己收流截断。
   Windows 超时/取消用 `child.kill` + `taskkill /T /F` 兜底。
2. **`maxBytes` 语义 = stdout、stderr 各自上限**（`truncated = 任一超限`），而非两者合计；按 UTF-8 字符边界截断。
3. **HTTP 通道 `redirect: 'manual'`**：3xx 按非 2xx → `E_CHANNEL`。否则本机端点 30x 到外部 host 会绕过
   `http.allowHosts` 白名单。
4. **`power-limit` 的回读校验**：回读 `power.limit` 与目标比对（±2W）；本机返回 `[N/A]` 时
   `verify.checked=true, ok=null` 并在 note 说明——不伪造成功。
5. **MQTT 订阅 QoS 2 → `E_UNSUPPORTED`**（只实现 QoS 0/1；契约只显式规定写侧 QoS 2 拒绝）。
6. **`appendAudit` 返回的 `bytes` = 实际写入字节数（含换行）**；`loadConfig`/`appendAudit`/`readAuditTail`
   额外接受 `signal`（加法，abort → `E_IO`「已取消」）。
7. **数组元素里的数值包线**：MQTT payload 中 `FanDuty:[40,80]` 这类数组元素继承「最近的命名属性」的匹配规则；
   数组内的未知数值 key 仍拒绝并给出 `List[0].X` 路径（§8.4 未明确 key 来源，取最保守可用解）。
8. **被闸门拒绝的写入（越界/冷却/禁用）当前不落审计**——直接抛错，理由是「没有发生写入」；
   代价是拒绝原因只进工具错误而没进审计（模型能看到 message）。除审计 I/O 失败外，写入路径的
   intent 审计失败会**拒绝执行**（不产生无痕迹写入）。
9. **未知配置键**：`loadConfig` 记 warnings 并从规范化 config 中**剔除**；但 `limits.*` 子树更严格——
   未知命名空间 / 未知 rule.key / 非法收窄区间一律 `E_CONFIG`（fail-closed）。
10. **`index.js` 传入 `{ config }` 给 `appendAudit`/`readAuditTail`**，确保 `config.audit.path` 覆盖生效
    （两条工具与 `perf_limits` 报告同一路径）。

