# dsh-perf-tune

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 的本机性能插件：让 agent 能**读**本机性能指标、能**调**频/调功耗，同时把所有写入关进一个**不可放宽的安全包线**里，并留下审计。

- **机制在插件里**：通道（`nvidia-smi` / OEM 控制台本地 MQTT 总线 / HTTP / 白名单命令）、安全包线、写入冷却、审计、写后回读校验。
- **清单不内置**：读哪些指标、调哪些值属于调用方知识；插件只负责「你说读什么我读什么、你说写什么我先检查再写」。

## 特性

| 工具 | 作用 | 写硬件？ |
| --- | --- | --- |
| `perf_read` | 读 `nvidia-smi` 字段、MQTT 主题、HTTP JSON、白名单只读命令 | 否 |
| `perf_tune` | 锁核心/显存频率、复位、功耗上限、OEM 性能模式 | **默认 dry-run**，`apply:true` 才写 |
| `perf_limits` | 查看硬包线、生效包线、写入开关/冷却、审计摘要 | 否 |

写入必须同时通过：`writes.enabled` 开关 → 显式 `apply:true` → 硬包线校验（不可放宽，越界直接拒绝，**不静默 clamp**）→ 冷却 + `intent` 先落审计 + 写后回读。细节见 [docs/SECURITY.md](docs/SECURITY.md)。

## 适配机型与声明

- **适配机型**：机械革命 极光X 2024（MECHREVO 极光X，RTX 4070 Laptop，Windows 11）。OEM 控制台的 MQTT 端点与安全包线按该机型实测/逆向得到，其它机型不一定通用。
- **凭据**：仓库**不包含**任何 MQTT/设备凭据。OEM 控制台 broker 凭据可能因机型、控制台版本而异，必须在**本机**配置文件中自行填写；未配置时只有 MQTT 通道报 `E_CONFIG`。获取途径见 [docs/MQTT-CREDENTIALS.md](docs/MQTT-CREDENTIALS.md)。
- **AIGC 声明**：代码、测试与文档由 AI（DeepSeek Harness / DeepSeek 模型）辅助生成，并经过人工审阅与实机验证。真机写入硬件前请先用 `perf_limits` 与 dry-run 确认。
- **License**：MIT，欢迎 fork / issue / PR。适配新机型时建议把差异做成配置或独立包线，而不是放宽硬包线。

## 快速开始

### 1. 安装

插件零第三方依赖、纯 ESM，源码目录即安装源。普通 profile：

```powershell
dsh plugin --profile web add "link:<仓库绝对路径>"
```

桌面版 DSH（desktop profile）需用应用内插件管理器或手工 junction，详见 [docs/INSTALL.md](docs/INSTALL.md)。

### 2. 配置

不建配置文件也能用 `nvidia-smi` / HTTP / command 通道；**MQTT 通道必须先填本机 OEM 控制台 broker 凭据**。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\perf-tune" | Out-Null
Copy-Item <仓库绝对路径>\config\perf.example.json "$env:USERPROFILE\.dsh\perf-tune\config.json"
```

然后按 [docs/CONFIG.md](docs/CONFIG.md) 填 `mqtt.read` / `mqtt.write`；**凭据如何获取**（从本机 OEM 控制台提取 / loopback 抓包）见 [docs/MQTT-CREDENTIALS.md](docs/MQTT-CREDENTIALS.md)。配置文件默认路径 `%USERPROFILE%\.dsh\perf-tune\config.json`，每次工具调用都重新读取、不缓存。

### 3. 用法

```json
// 读 GPU
{ "source": "nvidia-smi", "fields": ["power.draw","temperature.gpu","clocks.gr","fan.speed"] }

// 调频：先 dry-run，确认后加 apply:true
{ "channel": "nvidia-smi", "op": "lock-core", "mhz": 1600, "apply": true }

// 看边界与状态（写硬件前先调这个）
{ }
```

完整参数、返回示例、OEM 性能模式与错误码见 [docs/USAGE.md](docs/USAGE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | 普通/桌面版安装、HMR 热重载、卸载 |
| [docs/CONFIG.md](docs/CONFIG.md) | 配置字段、MQTT 凭据、包线收窄 |
| [docs/MQTT-CREDENTIALS.md](docs/MQTT-CREDENTIALS.md) | 如何获取本机 OEM 控制台 MQTT 凭据 |
| [docs/USAGE.md](docs/USAGE.md) | 三个工具的用法、示例与错误码 |
| [docs/SECURITY.md](docs/SECURITY.md) | 安全模型、硬包线、审计、已知限制 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 测试、真机只读冒烟、目录结构 |
| [CONTRACT.md](CONTRACT.md) | 实现契约（模块边界/包线/审计/测试要求） |

## 验证

```powershell
cd <仓库绝对路径>
node --test test/            # 160 个测试，全绿（无需真实硬件/网络）
node scripts/live-read.mjs   # 真机只读冒烟（不会写硬件、不向控制面 topic 发布）
```

## License

[MIT](LICENSE)
