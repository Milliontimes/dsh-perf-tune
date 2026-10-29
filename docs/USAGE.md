# 用法

## 工具参数概要

| 工具 | 主要参数 |
| --- | --- |
| `perf_read` | `source`: `nvidia-smi` / `mqtt` / `http` / `command`；另有 `fields`、`gpuIndex`、`topics`、`waitMs`、`url`、`path`、`program`、`args`、`timeoutMs` |
| `perf_tune` | `channel`: `nvidia-smi` / `mqtt`；`apply`（默认 `false`）；`op`、`mhz`、`watts`、`gpuIndex`、`topic`、`payload`、`qos` |
| `perf_limits` | 无参数，返回硬包线/生效包线/写入开关/审计摘要 |

## 读 GPU 指标

```json
{ "source": "nvidia-smi",
  "fields": ["power.draw","temperature.gpu","clocks.gr","clocks.mem","clocks.max.gr","clocks.max.mem","utilization.gpu","pstate","fan.speed","power.limit"] }
```

返回示例（RTX 4070 Laptop 实测）：

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

## 读 OEM 控制台 MQTT 总线

```json
{ "source": "mqtt", "topics": ["#"], "waitMs": 1500 }
```

本机实测会收到 6 条 retained 状态消息：`Keyboard/Status`、`HidLightbar_Logo/Status`、`HidLightbar_Hinge/Status`、`HidLightbar_Sync/Status`、`Settings/DeviceSwitchItemStatus`、`Customize/SupportInfo`。

## 读本机 HTTP 端点（例如本机 GPU 仪表盘）

```json
{ "source": "http", "url": "http://127.0.0.1:4014/api/gpus", "path": "gpus.0.power_w" }
```

`path` 支持 `gpus.0.power_w` 与 `gpus[0].power_w` 两种写法；host 必须在 `http.allowHosts` 内。

## 调频：先 dry-run，再 apply

```json
// 1) dry-run：只校验、不写硬件
{ "channel": "nvidia-smi", "op": "lock-core", "mhz": 1600 }

// 2) 确认 request/limits 后真正写入
{ "channel": "nvidia-smi", "op": "lock-core", "mhz": 1600, "apply": true }
```

支持的操作：

| op | 说明 |
| --- | --- |
| `lock-core` | `-lgc`，`mhz` 可为数字或 `{min,max}` |
| `reset-core` | `-rgc` |
| `lock-mem` | `-lmc` |
| `reset-mem` | `-rmc` |
| `reset-all` | `-rgc` + `-rmc` |
| `power-limit` | `-pl`，需 `watts`；本机驱动不支持，会如实报错（见 [SECURITY.md](SECURITY.md#已知限制)） |

## 切性能模式（OEM 控制台 MQTT 控制面）

```json
// dry-run：校验 topic 白名单与 payload 结构
{ "channel": "mqtt", "topic": "Fan/Control", "payload": "{\"Action\":\"OPERATING_TURBO_MODE\"}" }

// 真正发布（需 apply:true）
{ "channel": "mqtt", "topic": "Fan/Control", "payload": "{\"Action\":\"OPERATING_TURBO_MODE\"}", "apply": true }
```

模式取值（托盘程序反编译）：`OPERATING_OFFICE_MODE`（办公，115W）、`OPERATING_GAMING_MODE`（游戏，115W）、`OPERATING_TURBO_MODE`（狂暴，140W）、`OPERATING_CUSTOM_MODE`（自定义）。

`Customize/Control`（TGP 数值、DynamicBoost、目标温度等）payload 与 `ModeX_ProfileY.json` 同构，但**实际报文尚未抓包确认**。插件允许发，数值字段会先过硬包线；发错结构不会崩但也不会生效，建议先用 `perf_read` 订阅观察再发布。

## 查看边界与状态

```json
{ }
```

返回硬包线、配置收窄后的生效包线、写入开关/冷却、最近审计。**写硬件前先调这个。**

## 错误码

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
