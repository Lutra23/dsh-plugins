# dsh-code-tools

VCP 代码工具箱移植为 DSH 常驻 host 插件（与 dsh-vcp-tools / dsh-project-forge 并列）。

| 工具 | VCP 源插件 | 形态 |
|---|---|---|
| `deepwiki` | DeepWikiVCP 2.1 | stdio 直连原版进程（MCP over HTTP，零依赖） |
| `git_search` | GitSearch 1.0 | stdio 直连（GitHub/GitLab/Gitee 14 命令 + 后缀批量协议） |
| `git_operator` | GitOperator 1.1 | stdio 直连（repos.json Profile、token 脱敏、危险操作验证码门保留，工具层绝不代填 requireAdmin） |
| `firecrawl_dev_search` | FirecrawlDevSearch | stdio 直连（开发者索引语义检索，API key 走 VCP 侧 config.env） |

## 关键设计

- **不复制插件源码**：适配器只组装请求 JSON 喂给 `<VCPToolBox 根目录>\Plugin\*\*.js` 的原版进程（路径经 `DSH_VCP_ROOT` 环境变量重定向，默认 `~/Desktop/VCPToolBox`），凭证/代理/`repos.json` 全部实时读 VCP 侧文件——VCP 改配置，两边同时生效。本包不落盘任何密钥。
- **依赖 VCP 插件目录存在但不要求 VCP 服务器运行**：与 vcp-tools 的 admin_api 桥不同，这里 spawn 的是插件子进程本体。VCP 卸载后需把 Plugin 目录随包迁走。
- **peer 宽口径**：`cordis ^4.0.1` / `dsh-tools *`，不触发 0.2.0-rc.2 的兼容门。
- **装载依赖解析**：本包若以源码目录 link 进 profile，Node 从 `lib/index.js` 上溯解析 `@deepseek-ai/dsh-tools` 需要祖先链上有 `node_modules`（通常就是 profile 自身的 `node_modules`）；以 tgz 安装时由 profile 依赖树自动满足。

## 安装

```
dsh plugin --profile desktop add ./dsh-external-dsh-code-tools-0.1.0.tgz
dsh plugin --profile web add ./dsh-external-dsh-code-tools-0.1.0.tgz
```

desktop profile 若未被运行中管理器即时激活，重启 App 生效。

## 验证

`node test\smoke.mjs` —— 15 项端到端断言（stub ctx 复刻 subprocess/fs/tools 注入面，真实调用插件子进程），2026-10-02 全绿。
