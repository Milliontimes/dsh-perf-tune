# 安全模型

## 写入四道闸（缺一不写）

1. **配置开关**：`config.writes.enabled`（默认 `true`；置 `false` 后所有写入被 `E_WRITE_DISABLED` 拒绝）。
2. **显式 apply**：每次调用必须 `apply: true` 才动硬件；缺省是 dry-run，只做包线校验并返回将要执行的规范化请求。
3. **硬包线**：`lib/envelope.js` 里的数值边界**不可被配置放宽**，只允许配置收窄；越界直接 `E_SAFETY`，**绝不静默 clamp**。
4. **冷却 + 审计 + 回读**：进程级写入冷却（默认 1500ms，硬下限 1000ms）；写入前先落 `intent` 审计（审计写失败则拒绝执行）；写后回读校验（nvidia-smi 回读频率、功耗上限回读同比）并落 `applied` / `failed`。

## 硬包线

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

## 其它安全行为

- **不静默 clamp**：越界会报 `E_SAFETY` 并给出实际值与允许区间，而不是悄悄改成一个「差不多」的值。
- **不引入 shell**：所有子进程用 argv 数组 + `shell:false`；MQTT 是手写 MQTT 3.1.1 报文（零第三方依赖）。
- **HTTP 不跟重定向**（`redirect:'manual'`）：防本机端点 30x 到外部 host 绕过 `allowHosts`。
- **命令通道默认全禁**：`command.allowPrograms` / `allowPaths` 为空时必须显式配置才能跑。
- **审计先于写入**：`intent` 落盘失败 → 拒绝本次写入（不产生无痕迹的硬件改动）。
- **写后回读**：`lock-core` 回读 `clocks.gr`，`lock-mem` 回读 `clocks.mem`，`power-limit` 回读 `power.limit`（±2W）。回读失败只产生 warning，不改变「已执行」的事实。

## 审计

- 路径：`%USERPROFILE%\.dsh\perf-tune\audit.jsonl`（`config.audit.path` 可覆盖）
- 格式：一行一条 JSON，字段 `{ts, tool, decision, channel, request, ...}`；`decision ∈ dry-run/intent/applied/failed`
- 轮转：写前若超过 `audit.maxBytes`（默认 1 MiB）→ 改名为 `audit.jsonl.1`（旧 `.1` 被覆盖）
- 单条 >8 KiB 自动截断 `request/result` 并标 `_truncated: true`（保证单行有界）
- 查看：`perf_limits` 返回最近 5 条；或直接 `Get-Content ...\audit.jsonl -Tail 5`

## 已知限制

1. **`nvidia-smi -pl` 改功耗在本机被驱动拒绝**：`power.limit` 查询返回 `[N/A]`，`nvidia-smi -pl` 返回 `Changing power management limit is not supported in current scope`。该功能保留了（`power-limit` op 会如实报 `E_UNSUPPORTED` / `E_CHANNEL`），但**改 TGP 实际只能走 OEM 控制台的 MQTT 控制面**（`Customize/Control` payload 待抓包）或 EC 直写（本插件未实现）。
2. **`Customize/Control` 的 TGP payload 尚未实测确认**：字段按 `ModeX_ProfileY.json` 同构推测，需要在 UI 拖一次 TGP 滑块并抓包后固化。
3. **EC 直写未实现**：`\\.\ACPIDriver` 的 ECRead/ECWrite 会绕过控制台保护逻辑（风扇表联动/异常保护），风险高，本插件明确不做。
4. **MQTT 是明文本地连接**：仅连 `127.0.0.1`，无 TLS；broker 凭据不随插件提供，需在本机配置文件中自行填写（不同机型/控制台版本可能不同）。
5. **`perf_read` 的 `fields` 不做白名单**：nvidia-smi 不认识的字段会返回 `E_CHANNEL`（stderr 原样带回）。
6. **写入是进程级串行**：冷却按进程内状态算，不跨 DSH 重启持久化（重启后第一次写入立即允许）。
7. **PATH / 当前目录存在同名可执行文件的风险**：`nvidiaSmi.path` 未配置时，`nvidia-smi` 按 PATH 解析；Windows 创建进程时当前目录也会参与搜索，因此 PATH 靠前或工作目录里被投放的 `nvidia-smi.exe` 可能被调用。`command` 通道的 `allowPrograms` 按 **basename** 匹配，同样依赖 PATH 解析，无法区分同名不同来源的程序。缓解：在配置里把 `nvidiaSmi.path` 设为**绝对路径**；命令通道优先用 `command.allowPaths` 配**绝对路径**（program 携带路径分隔符时只匹配 `allowPaths`）；并只在可信工作目录下运行 DSH。
