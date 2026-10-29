# 开发与验证

## 环境

- ESM：`package.json` 里 `"type": "module"`；`lib/*.js` 直接用 `export`。
- Node ≥ 22（Electron host 内运行）。
- 零第三方运行时依赖：只能 `import` `node:` 内置模块与包内相对路径。
- 实现契约见根目录 [`CONTRACT.md`](../CONTRACT.md)（模块边界、包线、审计、测试要求、实现偏差）。

## 测试

```powershell
cd <仓库绝对路径>
node --test                  # 162 个测试，全绿（无需真实硬件/网络）
```

测试覆盖：错误码、配置加载/校验/深合并、硬包线收窄与拒绝、MQTT 数值字段的字符串绕过拒绝、nvidia-smi 解析与写参数拼装、MQTT 3.1.1 报文（含粘包/拆包/retained/QoS1/超时）、HTTP 白名单、命令白名单、审计轮转、工具层参数校验、未配置 MQTT 凭据 → `E_CONFIG`。

## 真机只读冒烟

```powershell
node scripts/live-read.mjs
```

`live-read.mjs` 会做 12 项检查并逐项打印 PASS/FAIL：配置加载、包线逻辑（越界拒绝）、nvidia-smi 真实读写解析、MQTT `#` 读取、MQTT 发布→订阅回环（`PerfTune/SelfTest`，OEM 不订阅）、本机 HTTP 仪表盘、临时文件可写性。

**它不会写硬件、不会向控制面 topic 发布任何消息。**

## 目录结构

```
dsh-perf-tune/
├── index.js                 # 插件入口：3 个工具 + 参数校验 + 写入四道闸
├── cordis.patch.yml         # bundle 插桩：把本插件插入 profile 层
├── package.json             # 零依赖；dsh.bundle.patch 指向 cordis.patch.yml
├── config/perf.example.json # 配置示例（不含任何凭据）
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
├── test/                    # 162 个 node:test 用例
├── .github/workflows/test.yml # CI：push/PR 跑 node --test
├── docs/                    # 安装/配置/用法/安全/开发文档
└── CONTRACT.md              # 实现契约
```

## 设计约束

- 插件是 `link:` 安装，插件目录解析不到 profile 的 `node_modules`，因此**零第三方依赖**，只能 import `node:` 内置模块与包内相对路径。
- 所有 I/O 函数接受可选 `AbortSignal`（参数名 `signal`），取消抛 `PerfError('E_IO', '已取消')`。
- 执行外部程序一律 `child_process.spawn` / `execFile`（`shell: false`），**绝不**拼 shell 字符串。
- 不 `console.log`（会污染 host 输出）；诊断信息走返回值的 `warnings: string[]`。
