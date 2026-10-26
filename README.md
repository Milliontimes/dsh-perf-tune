# dsh-perf-tune

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的本机性能插件：让 agent 能**读**本机性能指标、能**调**频/调功耗，同时把所有写入关进一个**不可放宽的安全包线**里，并留下审计。

设计上刻意分成两半：

- **机制在插件里**：通道（`nvidia-smi` / OEM 控制台本地 MQTT 总线 / HTTP / 白名单命令）、安全包线、写入冷却、审计、写后回读校验。
- **清单不内置**：读哪些指标、调哪些值、什么值算「这个游戏的甜点」，属于记忆系统/调用方的知识。插件只负责「你说读什么我读什么、你说写什么我先检查再写」。

理论依据是 OEM 电竞控制台（机械革命）的本地 MQTT 总线与 nvidia-smi/NVML 能力边界；协议结论已内联在本文档与 [CONTRACT.md](./CONTRACT.md)。

## 0. AIGC 声明 · 适配机型 · 欢迎 Fork

- **AIGC 声明**：本项目的代码、测试与文档由 AI（DeepSeek Harness / DeepSeek 模型）辅助生成，并经过人工审阅与实机验证。真机写入硬件前请先用 `perf_limits` 与 dry-run 确认。
- **适配机型**：机械革命 极光X 2024（MECHREVO 极光X，RTX 4070 Laptop，Windows 11）。OEM 控制台的 MQTT 端点与安全包线是按该机型实测/逆向得到的，其它机型不一定通用。
- **凭据**：仓库**不包含**任何 MQTT/设备凭据。OEM 控制台 broker 的凭据可能因机型、控制台版本而异，必须由使用者在本机配置文件中自行填写；未配置时只有 MQTT 通道报 `E_CONFIG`，`nvidia-smi` / HTTP / command 通道不受影响。
- **欢迎 Fork**：MIT 协议，欢迎 fork、提 issue / PR。适配新机型时建议把机型差异做成配置或独立包线，而不是放宽硬包线。

---

## 1. 三个工具

| 工具 | 作用 | 写硬件？ |
| --- | --- | --- |
| `perf_read` | 只读：`nvidia-smi` 字段、MQTT 主题（retained + 实时消息）、HTTP JSON 端点、白名单只读命令 | 否 |
| `perf_tune` | 调频/调功耗/切性能模式：nvidia-smi 锁核心/显存频率、复位、功耗上限；OEM 控制台 MQTT 控制面发布 JSON | **默认 dry-run**，`apply:true` 才写 |
| `perf_limits` | 查看硬包线、配置收窄结果、写入开关/冷却、配置文件与审计路径、最近 5 条审计 | 否 |

### 写入四道闸（缺一不写）

1. **配置开关**：`config.writes.enabled`（默认 `true`；置 `false` 后所有写入被 `E_WRITE_DISABLED` 拒绝）。
2. **显式 apply**：每次调用必须 `apply: true` 才动硬件；缺省是 dry-run，只做包线校验并返回将要执行的规范化请求。
3. **硬包线**：`lib/envelope.js` 里的数值边界**不可被配置放宽**，只允许配置收窄；越界直接 `E_SAFETY`，**绝不静默 clamp**。
4. **冷却 + 审计 + 回读**：进程级写入冷却（默认 1500ms，硬下限 1000ms）；写入前先落 `intent` 审计（审计写失败则拒绝执行）；写后回读校验（nvidia-smi 回读频率、功耗上限回读同比）并落 `applied`/`failed`。

---

## 2. 安装

插件是零依赖纯 ESM 包，源码目录即安装源。

### 2.1 普通 profile（web / headless / 自建 profile）

```powershell
# 安装（link 方式，改源码后重启该 profile 即生效；适合本机自用插件）
dsh plugin --profile web add link:<仓库绝对路径>

# 卸载
dsh plugin --profile web remove @local/dsh-perf-tune

# 查看 profile 组合后的插件层（应出现 `@local/dsh-perf-tune` 行）
dsh --profile web --dump-config | Select-String -Context 0,2 perf-tune
```

### 2.2 桌面版 DSH（desktop profile，本机实测）

**`dsh plugin --profile desktop add` 会被 CLI 拒绝**（`profile "desktop" is managed exclusively by the Electron application`）。
两条可用路线：

- **推荐：应用内插件管理器**（`plugin_manager install_bundle`，`dshmarket`/插件页）填**本地绝对路径**
  `<仓库绝对路径>` 即可（它接受 npm 包名 / 本地绝对路径 / git 仓库 / tgz 直链四类 spec）。
- **手工等价操作**（2026-10-26 在本机按此装好并验证；备份好 `package.json` / `pnpm-lock.yaml`）：

  1. 在 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\@local\` 下建 junction：
     `powershell -Command "New-Item -ItemType Junction -Path '<profile>\node_modules\@local\dsh-perf-tune' -Target '<仓库绝对路径>'"`
  2. 编辑 `<profile>\package.json`：`dependencies` 加
     `"@local/dsh-perf-tune": "link:<仓库绝对路径>"`，并在 `dsh.profile.bundles` **末尾**追加
     `"@local/dsh-perf-tune"`。
  3. DSH 的 HMR 监听到 profile 清单/补丁变化后会**自动 recompose 热插拔**（本机实测：保存 package.json 后
     当前会话立刻出现三个 `perf_*` 工具，无需重启）。若没热插拔，重启桌面版即可。
  4. 卸载：从 `dependencies`、`dsh.profile.bundles` 删掉对应项，删除 junction，重启/等热重载。

> 本机（`desktop` profile）已于 2026-10-26 安装并验证：三个工具经真实 DSH 工具管线调用通过
> （`perf_limits`、`perf_read` 的 nvidia-smi/MQTT/HTTP、`perf_tune` 的 nvidia-smi/MQTT dry-run、越界 `E_SAFETY`）。

### 2.3 改了插件源码之后

- 安装方式是 **link**（junction）时，改 `index.js`/`lib/*.js` 后需要触发一次 profile recompose 才会重新 import：
  在 profile 的 `cordis.patch.yml` 里加/删一行注释保存（HMR 监听 profile patch），或直接重启 DSH。
  （HMR 会替换「加载过的文件在磁盘上变了」的插件——见 `@deepseek-ai/dsh-hmr` README；只改补丁内容就能触发。）
- 注意 `package.json` 的**纯内容变化**不会触发模块重载；有意义的触发是 `dsh.profile.bundles` 变化或 profile patch 文件变化。


---

## 3. 配置

不建配置文件也能用 `nvidia-smi` / HTTP / command 通道；**MQTT 通道必须先填本机的 OEM 控制台 broker 凭据**（仓库不附带任何凭据）。复制示例后按下面「MQTT 凭据」一节填写：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\perf-tune" | Out-Null
Copy-Item <仓库绝对路径>\config\perf.example.json "$env:USERPROFILE\.dsh\perf-tune\config.json"
```

- 默认路径：`%USERPROFILE%\.dsh\perf-tune\config.json`（`DSH_HOME` 生效时为 `$DSH_HOME\perf-tune\config.json`）
- 可用环境变量 `DSH_PERF_TUNE_CONFIG=<绝对路径>` 指向别处
- 每次调用都会重新读文件**不缓存**，改配置不需重启插件（记忆系统写配置后下一次工具调用即生效）

### 配置字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mqtt.host` / `mqtt.port` | `127.0.0.1` / `13688` | OEM 控制台本地 MQTT 总线（GCUBridge） |
| `mqtt.read.{clientId,username,password}` | `null`（未配置） | 只读订阅身份；**必须自行填写**，仓库不提供 |
| `mqtt.write.{clientId,username,password}` | `null`（未配置） | 控制面发布身份；**必须自行填写**，仓库不提供 |
| `nvidiaSmi.path` | `null`（= PATH 里的 nvidia-smi） | 自定义 nvidia-smi 路径 |
| `nvidiaSmi.gpuIndex` | `0` | 默认 GPU 序号 |
| `http.allowHosts` | `["127.0.0.1","localhost","::1"]` | HTTP 通道 host 白名单（本机端点，如本机 GPU 仪表盘 4014） |
| `command.allowPrograms` / `command.allowPaths` | `[]` / `[]` | 只读命令白名单（默认全禁止） |
| `writes.enabled` | `true` | 全局写入开关 |
| `writes.minIntervalMs` | `1500` | 写入冷却；**不得低于 1000**（配置成更低 → `E_CONFIG`） |
| `limits.*` | `{}` | 把硬包线**收窄**（见下） |
| `audit.path` | `null`（= `<DSH_HOME>/perf-tune/audit.jsonl`） | 审计文件路径 |
| `audit.maxBytes` | `1048576` | 审计单文件上限，超限单次轮转 `audit.jsonl.1` |

### MQTT 凭据（必须自行配置）

插件**不内置、不附带**任何 MQTT 凭据：broker 的凭据可能因机型、控制台版本而异，照抄别人的值大概率连不上。把下面两段填成**你本机** OEM 控制台 broker 实际接受的身份：

```json
{
  "mqtt": {
    "read":  { "clientId": "<只读 clientId>", "username": "<只读 username>", "password": "<只读 password>" },
    "write": { "clientId": "<控制面 clientId>", "username": "<控制面 username>", "password": "<控制面 password>" }
  }
}
```

- 未配置（或 `clientId` 为空）时，MQTT 读写会报 `E_CONFIG` 并提示缺哪个字段；其它通道照常工作。
- 凭据只存在本机配置文件（`%USERPROFILE%\.dsh\perf-tune\config.json` 等），不要提交进任何仓库。

### 收窄包线（只能收窄，不能放宽）

`limits` 是唯一合法的「按你的习惯收紧安全区」入口；写超过硬包线 → 启动/调用时报 `E_CONFIG`：

```json
{
  "limits": {
    "nvidiaSmi": {
      "coreMhz": { "min": 300, "max": 2100 },
      "memMhz": { "min": 500, "max": 8000 },
      "powerW": { "min": 60, "max": 140 }
    },
    "mqtt": {
      "numeric": {
        "ConfigurableTGPTarget": { "min": 60, "max": 140 },
        "TargetTemperature": { "min": 60, "max": 87 }
      }
    },
    "writes": { "minIntervalMs": 2000 }
  }
}
```

- 只写 `min` 或只写 `max` 也可以（另一侧继承硬包线）；区间必须 `min < max`。
- `limits.mqtt.numeric` 的 key 是硬包线规则名（可用 `perf_limits` 查看全部规则名）。
- MQTT 的 topic 白名单与 payload 字节上限是**硬包线**，不可配置。

---

## 4. 用法示例

### 4.1 读 GPU 指标

```json
{ "source": "nvidia-smi",
  "fields": ["power.draw","temperature.gpu","clocks.gr","clocks.mem","clocks.max.gr","clocks.max.mem","utilization.gpu","pstate","fan.speed","power.limit"] }
```

返回示例（本机 RTX 4070 Laptop 实测）：

```json
{ "kind": "nvidia-smi", "fields": [
  { "name": "power.draw", "raw": "139.14", "value": 139.14 },
  { "name": "temperature.gpu", "raw": "86", "value": 86 },
  { "name": "clocks.gr", "raw": "2415", "value": 2415 },
  { "name": "clocks.mem", "raw": "8501", "value": 8501 },
  { "name": "fan.speed", "raw": "[N/A]", "value": null }
] }
```

字段名直接透传 `nvidia-smi --query-gpu`，插件**不内置字段清单**；`[N/A]` / `[Not Supported]` → `null`，字符串原样保留。

### 4.2 读 OEM 控制台 MQTT 总线

```json
{ "source": "mqtt", "topics": ["#"], "waitMs": 1500 }
```

本机实测会收到 6 条 retained 状态消息：`Keyboard/Status`、`HidLightbar_Logo/Status`、`HidLightbar_Hinge/Status`、`HidLightbar_Sync/Status`、`Settings/DeviceSwitchItemStatus`、`Customize/SupportInfo`。

### 4.3 读本机 HTTP 端点（例如本机 GPU 仪表盘）

```json
{ "source": "http", "url": "http://127.0.0.1:4014/api/gpus", "path": "gpus.0.power_w" }
```

`path` 支持 `gpus.0.power_w` 与 `gpus[0].power_w` 两种写法；host 必须在 `http.allowHosts` 内。

### 4.4 调频：先 dry-run，再 apply

```json
// 1) dry-run：只校验、不写硬件
{ "channel": "nvidia-smi", "op": "lock-core", "mhz": 1600 }

// 2) 确认 request/limits 后真正写入
{ "channel": "nvidia-smi", "op": "lock-core", "mhz": 1600, "apply": true }
```

支持的操作：`lock-core`（`-lgc`，`mhz` 可为数字或 `{min,max}`）、`reset-core`（`-rgc`）、
`lock-mem`（`-lmc`）、`reset-mem`（`-rmc`）、`reset-all`（`-rgc` + `-rmc`）、
`power-limit`（`-pl`，需 `watts`；**本机驱动不支持，会如实报错**，见 §6）。

### 4.5 切性能模式（OEM 控制台 MQTT 控制面）

```json
// dry-run：校验 topic 白名单与 payload 结构
{ "channel": "mqtt", "topic": "Fan/Control", "payload": "{\"Action\":\"OPERATING_TURBO_MODE\"}" }

// 真正发布（需 apply:true）
{ "channel": "mqtt", "topic": "Fan/Control", "payload": "{\"Action\":\"OPERATING_TURBO_MODE\"}", "apply": true }
```

模式取值（托盘程序反编译）：`OPERATING_OFFICE_MODE`（办公，115W）、
`OPERATING_GAMING_MODE`（游戏，115W）、`OPERATING_TURBO_MODE`（狂暴，140W）、`OPERATING_CUSTOM_MODE`（自定义）。

`Customize/Control`（TGP 数值、DynamicBoost、目标温度等）payload 与 `ModeX_ProfileY.json` 同构，
但**实际报文尚未抓包确认**（待抓包确认）——插件允许发，但数值字段会先过硬包线，
发错结构不会崩但也不会生效，建议先用 `perf_read` 订阅观察再发布。

### 4.6 查看边界与状态

```json
{ }
```

返回硬包线、配置收窄后的生效包线、写入开关/冷却、最近审计。**写硬件前先调这个。**

---

## 5. 安全模型明细

| 边界 | 值 |
| --- | --- |
| 核心锁频 | 300–2500 MHz |
| 显存锁频 | 500–9000 MHz |
| 整卡功耗上限 | 60–140 W（本机 OEM 上限 140W，`power.max_limit` 实测 140.00 W） |
| MQTT 控制面 topic | 精确白名单：`Fan/Control`、`Customize/Control`（不做前缀匹配） |
| TGP 目标 | 60–140 W |
| DynamicBoost | 0–25 W（开关 0/1） |
| 目标温度 | 60–87 °C |
| 核心偏移 | 0–250 MHz；显存偏移 −2000–2000 MHz |
| 风扇占空比 | 0–100 |
| PL1/PL2 / PL4 | 60–150 W / 60–220 W（EC 语义） |
| MQTT payload | ≤ 2048 字节、嵌套深度 ≤ 8、单字符串 ≤ 256 字符；含未知数值字段 → 拒绝 |
| 写入冷却 | 硬下限 1000ms，默认 1500ms |

其它安全行为：

- **不静默 clamp**：越界会报 `E_SAFETY` 并给出实际值与允许区间，而不是悄悄改成一个「差不多」的值。
- **不引入 shell**：所有子进程用 argv 数组 + `shell:false`；MQTT 是手写 MQTT 3.1.1 报文（零第三方依赖）。
- **HTTP 不跟重定向**（`redirect:'manual'`）：防本机端点 30x 到外部 host 绕过 `allowHosts`。
- **命令通道默认全禁**：`command.allowPrograms` / `allowPaths` 为空时必须显式配置才能跑。
- **审计先于写入**：`intent` 落盘失败 → 拒绝本次写入（不产生无痕迹的硬件改动）。
- **写后回读**：`lock-core` 回读 `clocks.gr`，`lock-mem` 回读 `clocks.mem`，`power-limit` 回读 `power.limit`（±2W）。回读失败只产生 warning，不改变「已执行」的事实。

### 审计

- 路径：`%USERPROFILE%\.dsh\perf-tune\audit.jsonl`（`config.audit.path` 可覆盖）
- 格式：一行一条 JSON，字段 `{ts, tool, decision, channel, request, ...}`；`decision ∈ dry-run/intent/applied/failed`
- 轮转：写前若超过 `audit.maxBytes`（默认 1 MiB）→ 改名为 `audit.jsonl.1`（旧 `.1` 被覆盖）
- 单条 >8 KiB 自动截断 `request/result` 并标 `_truncated: true`（保证单行有界）
- 查看：`perf_limits` 返回最近 5 条；或直接 `Get-Content ...\audit.jsonl -Tail 5`

---

## 6. 已知限制（本机实测）

1. **`nvidia-smi -pl` 改功耗在本机被驱动拒绝**：`power.limit` 查询返回 `[N/A]`，
   `nvidia-smi -pl` 返回 `Changing power management limit is not supported in current scope`。
   该功能保留了（`power-limit` op 会如实报 `E_UNSUPPORTED`/`E_CHANNEL`），但**改 TGP 实际只能走 OEM 控制台的
   MQTT 控制面**（`Customize/Control` payload 待抓包）或 EC 直写（本插件未实现）。
2. **`Customize/Control` 的 TGP payload 尚未实测确认**：字段按 `ModeX_ProfileY.json` 同构推测，
   需要用户在 UI 拖一次 TGP 滑块并抓包后固化（待办）。
3. **EC 直写未实现**：`\\.\ACPIDriver` 的 ECRead/ECWrite 会绕过控制台保护逻辑（风扇表联动/异常保护），
   风险高，本插件明确不做；需要时另行评估。
4. **MQTT 是明文本地连接**：仅连 `127.0.0.1`，无 TLS；broker 凭据不随插件提供，需在本机配置文件中自行填写（不同机型/控制台版本可能不同）。
5. **`perf_read` 的 `fields` 不做白名单**：nvidia-smi 不认识的字段会返回 `E_CHANNEL`（stderr 原样带回）。
6. **写入是进程级串行**：冷却按进程内状态算，不跨 DSH 重启持久化（重启后第一次写入立即允许）。

---

## 7. 验证

```powershell
cd <仓库绝对路径>
node --test test/            # 160 个测试，全绿（无需真实硬件/网络）
node scripts/live-read.mjs   # 真机只读冒烟：只读硬件 + 一条无害自建 topic 的 MQTT 回环
```

`live-read.mjs` 会做 12 项检查并逐项打印 PASS/FAIL：配置加载、包线逻辑（越界拒绝）、
nvidia-smi 真实读写解析、MQTT `#` 读取（本机 6 条 retained）、MQTT 发布→订阅回环
（`PerfTune/SelfTest`，OEM 不订阅）、本机 HTTP 仪表盘、临时文件可写性。**它不会写硬件、
不会向控制面 topic 发布任何消息。**

插件激活验证（在隔离 profile 里做过）：`dsh plugin --profile perfcheck add link:<仓库绝对路径>`
后 `--dump-config` 出现插件行；用真实 cordis + `@deepseek-ai/dsh-tools` 注册表加载本插件，
三个工具成功注册，`perf_limits`/`perf_read`/`perf_tune` 在真实 registry 下返回正确结果。

---

## 8. 目录结构

```
dsh-perf-tune/
├── index.js                 # 插件入口：3 个工具 + 参数校验 + 写入四道闸（Lead）
├── cordis.patch.yml         # bundle 插桩：把本插件插入 profile 层
├── package.json             # 零依赖；dsh.bundle.patch 指向 cordis.patch.yml
├── config/perf.example.json # 配置示例
├── lib/
│   ├── errors.js            # PerfError + 固定错误码表
│   ├── config.js            # 配置加载/校验/默认值（每次重读，不缓存）
│   ├── envelope.js          # 硬包线、配置收窄、nvidia/MQTT 写校验
│   ├── audit.js             # JSONL 审计（轮转/截断/尾部读取）
│   ├── run.js               # 子进程封装（shell:false、超时杀进程、截断）
│   ├── mqtt-client.js       # 手写 MQTT 3.1.1（node:net，零依赖）
│   ├── channel-mqtt.js      # MQTT 通道（读/写身份分离）
│   ├── channel-nvidia.js    # nvidia-smi 读写通道（泛化查询 + 回读校验）
│   ├── channel-http.js      # HTTP 只读通道（allowHosts 白名单）
│   └── channel-command.js   # 白名单只读命令通道
├── scripts/live-read.mjs    # 真机只读冒烟
├── test/                    # 160 个 node:test 用例
└── CONTRACT.md              # 实现契约（模块边界/包线/审计/测试要求/实现偏差）
```

---

## 9. 错误码

| code | 含义 |
| --- | --- |
| `E_ARGS` | 参数不合法（缺失/类型错/互斥字段冲突） |
| `E_CONFIG` | 配置文件缺失/JSON 坏/字段非法/试图放宽硬包线 |
| `E_CHANNEL` | 通道执行失败（外部程序非零退出、HTTP 非 2xx、MQTT CONNACK 拒绝等） |
| `E_NOT_FOUND` | 目标不存在（nvidia-smi 不在、JSON path 无值、topic 无 retained） |
| `E_TIMEOUT` | 超时 |
| `E_SAFETY` | 写入值越界或被硬包线拒绝 |
| `E_WRITE_DISABLED` | `writes.enabled=false` |
| `E_COOLDOWN` | 距上次写入太近 |
| `E_ADMIN_REQUIRED` | 需要管理员权限（nvidia-smi 写操作典型） |
| `E_UNSUPPORTED` | 当前环境不支持该操作/字段/能力 |
| `E_IO` | 本地 I/O 失败（审计/配置读写），或调用被取消 |

工具层抛错前统一格式化为 `Error('[<code>] <message>')`——模型只看 `message`，所以 message 自解释。

