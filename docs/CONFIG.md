# 配置

## 配置文件位置

- 默认：`%USERPROFILE%\.dsh\perf-tune\config.json`（`DSH_HOME` 生效时为 `$DSH_HOME\perf-tune\config.json`）
- 可用环境变量 `DSH_PERF_TUNE_CONFIG=<绝对路径>` 指向别处
- 每次工具调用都重新读文件、**不缓存**，改配置不需要重启插件

不建配置文件也能用 `nvidia-smi` / HTTP / command 通道；**MQTT 通道必须先填本机 OEM 控制台 broker 凭据**（仓库不附带任何凭据，获取途径见 [MQTT-CREDENTIALS.md](MQTT-CREDENTIALS.md)）。

从示例开始：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\perf-tune" | Out-Null
Copy-Item <仓库绝对路径>\config\perf.example.json "$env:USERPROFILE\.dsh\perf-tune\config.json"
```

## 配置字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mqtt.host` / `mqtt.port` | `127.0.0.1` / `13688` | OEM 控制台本地 MQTT 总线（GCUBridge） |
| `mqtt.read.{clientId,username,password}` | `null`（未配置） | 只读订阅身份；**必须自行填写**，仓库不提供 |
| `mqtt.write.{clientId,username,password}` | `null`（未配置） | 控制面发布身份；**必须自行填写**，仓库不提供 |
| `nvidiaSmi.path` | `null`（= PATH 里的 nvidia-smi） | 自定义 nvidia-smi 路径 |
| `nvidiaSmi.gpuIndex` | `0` | 默认 GPU 序号 |
| `http.allowHosts` | `["127.0.0.1","localhost","::1"]` | HTTP 通道 host 白名单 |
| `command.allowPrograms` / `command.allowPaths` | `[]` / `[]` | 只读命令白名单（默认全禁止） |
| `writes.enabled` | `true` | 全局写入开关 |
| `writes.minIntervalMs` | `1500` | 写入冷却；**不得低于 1000**（更低 → `E_CONFIG`） |
| `limits.*` | `{}` | 把硬包线**收窄**（见下） |
| `audit.path` | `null`（= `<DSH_HOME>/perf-tune/audit.jsonl`） | 审计文件路径 |
| `audit.maxBytes` | `1048576` | 审计单文件上限，超限单次轮转 `audit.jsonl.1` |

## MQTT 凭据（必须自行配置）

插件**不内置、不附带**任何 MQTT 凭据：broker 的凭据可能因机型、控制台版本而异，照抄别人的值大概率连不上。**如何在本机取得凭据**见 [MQTT-CREDENTIALS.md](MQTT-CREDENTIALS.md)；取得后把下面两段填成**你本机** OEM 控制台 broker 实际接受的身份：

```json
{
  "mqtt": {
    "read":  { "clientId": "<只读 clientId>", "username": "<只读 username>", "password": "<只读 password>" },
    "write": { "clientId": "<控制面 clientId>", "username": "<控制面 username>", "password": "<控制面 password>" }
  }
}
```

- 未配置（或 `clientId` 为空）时，MQTT 读写会报 `E_CONFIG` 并提示缺哪个字段；其它通道照常工作。
- 凭据只存在本机配置文件，不要提交进任何仓库。

## 收窄包线（只能收窄，不能放宽）

`limits` 是唯一合法的「按你的习惯收紧安全区」入口；试图放宽硬包线 → `E_CONFIG`：

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

完整示例见仓库 [`config/perf.example.json`](../config/perf.example.json)。
