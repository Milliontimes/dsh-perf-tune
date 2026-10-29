# 获取 OEM 控制台 MQTT 凭据

插件**不内置、不附带**任何凭据。OEM 控制台 broker 的凭据通常由厂商编译进控制台程序，或按机器/版本生成，**没有通用默认值** —— 同型号的不同控制台版本也可能不同。本文说明在**你自己的机器**上取得这组凭据的常见途径。

> 仅用于你拥有或有权使用的设备。遵守厂商许可与当地法律；**不要把提取出的凭据提交进仓库、issue 或公开文档**。

## 先确认目标

- 端点：`127.0.0.1:13688`（本机 OEM 控制台 `GCUBridge.exe` 的 MQTT broker）
- 需要两组身份：
  - `mqtt.read`：只读订阅（读状态主题）
  - `mqtt.write`：控制面发布（切性能模式、调 TGP）
- 每组包含 `clientId`、`username`、`password` 三个字段。

## 方法 A：从 OEM 控制台二进制中读取（推荐）

本机（机械革命 极光X 2024）实测路径：

```text
C:\Program Files\OEM\机械革命电竞控制台\AiStoneService\GCUBridge.exe
```

先定位实际进程路径（版本不同可能不同）：

```powershell
Get-Process GCUBridge | Select-Object -ExpandProperty Path
```

该程序是 .NET 程序，broker 的客户端校验表和监听配置在程序集内。用 ILSpy 命令行反编译：

```powershell
dotnet tool install --global ilspycmd
ilspycmd -p -o .\gcu-src "<GCUBridge.exe 实际路径>"
```

然后在反编译输出中查找 MQTT broker 初始化相关代码（不同版本命名可能不同），重点看：

- MQTT 服务配置（端口、持久会话等）
- 客户端校验逻辑（`clientId` → `username` → `password` 的映射/表）
- 与 `service.ini` 相关的非本机校验分支（注意：这部分通常是加密后的配置，**不是**本机凭据来源）

取出读、写两组身份，填入插件配置。

注意：

- 程序可能用 Costura 等工具打包，必要时先解包再反编译。
- 部分版本会混淆方法体，常量/签名仍可能可读；若代码不可读，改用方法 B。
- 提取出的值只用于本机，不要公开。

## 方法 B：抓本机 loopback 流量（控制台在跑时）

broker 只监听本机，控制台与它之间是明文 MQTT，因此可以直接抓 CONNECT 报文读取身份。

1. 安装 Wireshark（安装时勾选 Npcap 的 loopback 支持）。
2. 选择 **Adapter for loopback traffic capture**（Npcap Loopback Adapter），开始抓包。
3. 过滤 `tcp.port == 13688`。
4. 重启 OEM 控制台，或在控制台里切换一次性能模式/打开状态页，触发客户端重连。
5. 在 MQTT `CONNECT` 报文里查看：
   - Client Identifier → `clientId`
   - User Name → `username`
   - Password → `password`
6. 控制台通常有多个 MQTT 客户端；按报文来源/用途区分只读身份与控制面身份（可分别对应 `mqtt.read` / `mqtt.write`）。

如果控制台版本对本地流量做了加密，则抓包看不到明文，回到方法 A。

## 方法 C：厂商资料 / 技术支持

部分厂商会随控制台提供接口文档，或在服务配置目录提供可读的凭据模板。可先查控制台安装目录、服务配置和厂商支持渠道；没有的话再用方法 A/B。

## 填入配置并验证

在 `%USERPROFILE%\.dsh\perf-tune\config.json`（或 `DSH_PERF_TUNE_CONFIG` 指向的文件）中填写：

```json
{
  "mqtt": {
    "read":  { "clientId": "...", "username": "...", "password": "..." },
    "write": { "clientId": "...", "username": "...", "password": "..." }
  }
}
```

只读验证（不会发布任何控制指令）：

```json
{ "source": "mqtt", "topics": ["Customize/SupportInfo"], "waitMs": 600 }
```

- 成功：返回至少一条 retained 消息。
- `E_CONFIG`：凭据没填，或 `clientId` 为空。
- `E_CHANNEL` 且 message 里 `rc=2`：`clientId` / `username` 不匹配。
- `E_CHANNEL` 且 message 里 `rc=4`：密码不匹配。

确认只读通过后，再按 [USAGE.md](USAGE.md) 用 `perf_tune` 做 dry-run，最后才考虑 `apply: true`。

## 安全提醒

- 这组凭据是**本机本地总线**的凭据，不是账号密码；但仍然不要公开。
- 不同机器/控制台版本的凭据可能不同，不能互相照抄。
- 不要为了“方便”把凭据写进仓库、脚本或日志；只放本机配置文件。
- 本插件只连接 `127.0.0.1`，但 broker 自身可能监听 `0.0.0.0`，请勿在不可信网络中暴露该端口。
