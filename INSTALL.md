# 安装指南

目标：把 `dist/<layer>/*.tgz` 装进 DSH profile，并让内核认到它。

## 0. 前置检查

| 项 | 判据 | 不满足的后果 |
|---|---|---|
| DSH 内核 0.2.x | 会话里工具表正常 | peer 窗口不匹配 → 插件被内核**静默跳过**（enabled 但无工具） |
| Node >= 20 | `node -v` | 部分包加载失败 |
| 包对应外部依赖 | 见 README 清单表 | 仅该包能力缺失 |

## 1. 装包

### A. 有 dsh CLI

```bash
dsh plugin --profile desktop add ./dist/core/dsh-lens-0.1.0.tgz
```

`dsh plugin add` 会把包写进 profile 的依赖与 `dsh.profile.bundles`。一次装多个就重复执行。
不同版本的 CLI 参数可能不同，以 `dsh plugin --help` 为准。

### B. 无 dsh CLI（手动注册配方）

1. 解压或复制包到任意稳定目录（建议 `~/.dsh/plugins/<包名>`）：
   ```bash
   mkdir -p ~/.dsh/plugins && tar -xzf dist/core/dsh-lens-0.1.0.tgz -C ~/.dsh/plugins
   ```
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 加一行：`"dsh-lens": "file:<绝对路径>/dsh-lens-0.1.0.tgz"`
     （或 `"dsh-lens": "link:<源码目录>"`）
   - `dsh.profile.bundles` 数组追加包名 `"dsh-lens"`
3. 在 profile 目录装依赖（pnpm 优先，hoisted linker）：
   ```bash
   cd ~/.dsh/profiles/desktop && pnpm install
   ```
   没有 pnpm 时，把包目录直接软链到 `node_modules/<包名>` 也可（Node 解析需要祖先链上有
   `node_modules`，否则 `@deepseek-ai/dsh-tools` 会 ERR_MODULE_NOT_FOUND）。
4. 重启 DSH。

### C. 从 git 装（有远程仓库后）

```bash
dsh plugin --profile desktop add git+https://github.com/<owner>/dsh-plugins.git#path:packages/core/dsh-lens
```

需要该包有 `prepare` 或已提交构建产物；本仓库的 `lib/` 均已提交，可直接用。

## 2. 重启与验证

- 宿主半（`index.js` / 工具注册 / `dsh.client.inject`）：**必须重启 DSH**。
- 浏览器半（`lib/client.js`）：热重载，刷新页面即可。
- 验证：新会话里看工具是否出现；或 `ctx_meter` 看上下文占用是否变化。
- 没生效先查 profile 的 `cordis.patch.yml` 是否有该包的 `- insert:` 行（`dsh.bundle.patch` 声明）。

## 3. 排障

| 症状 | 原因 | 处理 |
|---|---|---|
| 包在 dependencies 里但工具不出现 | `peerDependencies` 缺失/不匹配 → 内核静默跳过 | 确认包声明了 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`；本仓库已统一补齐 |
| `ERR_MODULE_NOT_FOUND @deepseek-ai/dsh-tools` | link 安装时祖先链无 `node_modules` | 用 tgz 装，或在包目录旁建 `node_modules` 链接 |
| `better-sqlite3` 报 ABI 不匹配 | Electron ABI 与预编译产物不一致 | `electron-rebuild`，或换 Node 版本重装 |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 默认阻止构建脚本 | 只为确实需要的包放行（`pnpm approve-builds`），不要全量放行 |
| 装完无报错但界面没变化 | 纯 UI 插件未声明 `./client` 或 inject 清单错 | 对照同槽位官方插件抄声明 |
| `dsh` 命令不存在 | CLI 不在 PATH | 走 B 手动配方，或直接用 DSH 安装目录里的 cli |

## 4. 卸载

从 profile `dependencies` 与 `dsh.profile.bundles` 移除对应条目，`pnpm install` 后重启。
数据目录（如 `~/.dsh/projectforge`、`~/.dsh/token-optimizer`）按需自行清理。
