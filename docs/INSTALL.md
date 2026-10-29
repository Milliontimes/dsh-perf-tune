# 安装

插件零第三方依赖、纯 ESM，源码目录即安装源。要求：

- Node ≥ 22
- DSH ≥ `0.2.1-rc.2`

## 普通 profile（web / headless / 自建 profile）

```powershell
# 安装（link 方式，改源码后重启该 profile 即生效；适合本机自用插件）
dsh plugin --profile web add "link:<仓库绝对路径>"

# 卸载
dsh plugin --profile web remove dsh-perf-tune

# 查看 profile 组合后的插件层（应出现 `dsh-perf-tune` 行）
dsh --profile web --dump-config | Select-String -Context 0,2 perf-tune
```

## 桌面版 DSH（desktop profile）

**`dsh plugin --profile desktop add` 会被 CLI 拒绝**（`profile "desktop" is managed exclusively by the Electron application`）。两条可用路线：

- **推荐：应用内插件管理器**（`plugin_manager install_bundle`，`dshmarket` / 插件页），填**本地绝对路径** `<仓库绝对路径>`（接受 npm 包名 / 本地绝对路径 / git 仓库 / tgz 直链四类 spec）。
- **手工等价操作**（在本机按此装好并验证；操作前备份 `package.json` / `pnpm-lock.yaml`）：

  1. 在 `C:\Users\<你>\.dsh\profiles\desktop\node_modules\` 下建 junction：
     ```powershell
     New-Item -ItemType Junction -Path '<profile>\node_modules\dsh-perf-tune' -Target '<仓库绝对路径>'
     ```
  2. 编辑 `<profile>\package.json`：`dependencies` 加
     `"dsh-perf-tune": "link:<仓库绝对路径>"`，并在 `dsh.profile.bundles` **末尾**追加
     `"dsh-perf-tune"`。
  3. DSH 的 HMR 监听到 profile 清单/补丁变化后会自动 recompose 热插拔（实测：保存 `package.json` 后当前会话立刻出现三个 `perf_*` 工具，无需重启）。若没热插拔，重启桌面版。
  4. 卸载：从 `dependencies`、`dsh.profile.bundles` 删掉对应项，删除 junction，重启 / 等热重载。

> 本机（`desktop` profile）已验证：三个工具经真实 DSH 工具管线调用通过（`perf_limits`、`perf_read` 的 nvidia-smi / MQTT / HTTP、`perf_tune` 的 nvidia-smi / MQTT dry-run、越界 `E_SAFETY`）。

## 改了插件源码之后

- 安装方式是 **link**（junction）时，改 `index.js` / `lib/*.js` 后需要触发一次 profile recompose 才会重新 import：在 profile 的 `cordis.patch.yml` 里加/删一行注释保存（HMR 监听 profile patch），或直接重启 DSH。
- `package.json` 的**纯内容变化**不会触发模块重载；有意义的触发是 `dsh.profile.bundles` 变化或 profile patch 文件变化。

## 激活验证（隔离 profile）

```powershell
dsh plugin --profile perfcheck add "link:<仓库绝对路径>"
dsh --profile perfcheck --dump-config | Select-String perf-tune
```

也可用真实 cordis + `@deepseek-ai/dsh-tools` 注册表加载本插件，确认 `perf_limits` / `perf_read` / `perf_tune` 成功注册并返回正确结果。
