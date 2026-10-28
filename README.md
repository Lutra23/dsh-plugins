# MingYue DSH Plugins

溟月工作坊的 DeepSeek Harness 插件集合：自研工具链 + 少量衍生改造件，按三层收录。
每个包都能独立 `npm pack` 成 tgz 安装，源码里不写死任何本机绝对路径。

- 内核基线：DSH `0.2.x`（`>=0.2.0-rc.1 <0.3.0-0`）
- 运行环境：Node `>= 20`，Windows / macOS / Linux（个别包平台限定，见下表）
- 仓库形态：**不是可 `npm install` 的 workspace**。`@deepseek-ai/*` 由 DSH 宿主提供，
  在仓库根跑 `npm install` 只会得到 404；打包与校验都用 `npm run` 脚本。

## 快速开始

```bash
git clone <this-repo> && cd dsh-plugins
npm run check     # 硬编码路径守卫（CI 同款）
npm run pack      # 每个包 -> dist/<layer>/*.tgz
```

安装到 DSH profile（三选一）：

```powershell
# A. 有 dsh CLI（推荐）
dsh plugin --profile desktop add ./dist/core/dsh-lens-0.1.0.tgz

# B. 无 dsh CLI：用仓库自带脚本（默认只打印步骤，-Apply 才执行）
pwsh -File scripts/install.ps1 -ProfileName desktop

# C. 开发期：源码目录直接 link 进 profile
#    在 profile 的 package.json 里加 "dsh-lens": "link:<本仓库>/packages/core/dsh-lens"
#    并把包名追加到 dsh.profile.bundles，然后重启 DSH
```

装完**必须重启 DSH**（宿主半在组装期 import 一次）；纯 UI 半的 `client.js` 改动可热重载。
详见 [INSTALL.md](INSTALL.md)。

## 目录

```text
packages/
  core/        13 个自研件（工具、记忆、施工台、桥接、界面）
  forks/        2 个衍生改造件（上游 fork，许可与差异见 NOTICE.md）
  vcp-side/     2 个 VCP 侧件（不装进 DSH profile）
scripts/       打包 / 路径守卫 / 安装脚本
dist/          npm pack 产物（git 忽略）
```

## 清单

### core — 自研

| 包 | 版本 | 提供 | 平台 / 依赖 |
|---|---|---|---|
| `dsh-lens` | 0.1.0 | `kernel_list` / `kernel_file` / `kernel_grep` / `kernel_versions`：直接读 app.asar 内核 | 跨平台 |
| `dsh-workspace-docs` | 0.3.1 | 工作区文档清单注入运行时上下文 | 跨平台 |
| `dsh-design-symposium` | 0.5.0 | 多贤者设计研讨 + 主席收敛纪要（UI 面板） | 跨平台 |
| `dsh-project-forge` | 0.4.1-local.5 | 工程施工台：账本、AST 检索、任务/回退 | win32-x64；二进制从 [Releases](docs/BINARIES.md) 下载；`better-sqlite3` |
| `dsh-forge-context` | 0.0.9 | 上下文压缩 / 整理（引擎半，宿主半在 project-forge 内） | 跨平台 |
| `dsh-memo-recall` | 0.4.13 | 被动记忆召回（边界触发 + 熔断） | 跨平台；召回半需 VCP |
| `dsh-vcp-tools` | 0.2.0 | `dailynote_write` / `lightmemo` / `doubao_search` / `chrome_bridge` | 跨平台；需 VCP 服务端 |
| `dsh-code-tools` | 0.1.0 | 外部代码检索四件套（GitHub/GitLab/Gitee/DeepWiki 等） | 跨平台；需 VCP 插件载荷 |
| `dsh-local-search` | 0.1.0 | Everything 本地文件秒搜 | Windows + Everything |
| `dsh-universal-read` | 0.1.1 | 任意路径 / PDF / Word / 表格读取与下载 | 跨平台；需 VCP 插件载荷 |
| `dsh-local-skills` | 1.1.0 | 本地 skill provider + `ctx_meter` | 跨平台 |
| `dsh-emoji` | 0.1.0 | 表情包库与设置页 | 跨平台；`jpeg-js` / `pngjs` |
| `dsh-github-sync` | 0.5.0 | 把插件目录同步成 GitHub 仓库 | 跨平台；需 git |

### forks — 衍生改造

| 包 | 版本 | 上游 | 说明 |
|---|---|---|---|
| `dsh-token-optimizer` | 2.2.3 | `@zoria-lind/dsh-token-optimizer` | 本地 fork：toolTrim / 压缩驱动 / 输出阶梯；已参数化调试日志路径 |
| `dsh-chat-rewind` | 0.2.0 | `JochenYang/dsh-rewind-plugin` | 早期本地版，已被上游 0.4.x 取代，保留作历史对照 |

### vcp-side — VCP 侧

| 件 | 版本 | 说明 |
|---|---|---|
| `dsh-vcp-bridge` | 0.11.0 | DSH ⇄ VCP 双向桥（agent 同步 / 反向桥 / omni 控制台） |
| `LightMemoAssoc` | 1.0.1 | VCP 插件：LightMemo 之上的共现联想检索（配合 memo-recall） |

## 环境变量（替代硬编码路径）

| 变量 | 用于 | 默认 |
|---|---|---|
| `DSH_KERNEL_ROOT` | 内核测试 / asar 定位 | 无（测试会跳过） |
| `DSH_HOME` | profile 与数据根 | `~/.dsh` |
| `DSH_VCP_ROOT` | VCP 插件载荷根 | `~/Desktop/VCPToolBox` |
| `VCP_HOST` / `VCP_PORT` / `VCP_HOME` / `VCP_ADMIN_USER` / `VCP_ADMIN_PASSWORD` | vcp-tools / memo-recall 远端 VCP | `127.0.0.1:6005` |
| `DSH_TOKEN_OPTIMIZER_DEBUG` | token-optimizer 调试日志（写临时目录） | 关闭 |

## 许可

根仓库 MIT。第三方件、上游 fork 与例外条款见 [NOTICE.md](NOTICE.md)：
`dsh-project-forge` 内含的 Rust 索引器二进制源 crate 声明 **CC-BY-NC-SA-4.0（禁商用）**，
商用前请自行替换或取得授权。
