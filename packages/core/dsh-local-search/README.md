# dsh-local-search

把 VCP 的 **LocalSearchController**（本地文件秒搜 / Everything）移植为 DSH 常驻工具 **`everything_search`**。

在整台电脑的 NTFS 索引上做毫秒级文件搜索，跨全部本地盘，返回文件路径 + 大小 + 修改时间。
实测热查询端到端 **56ms**（Everything 索引本身是内存级）。

```
everything_search query="plugin-manifest.json path:\VCPToolBox\Plugin"
everything_search query="ext:mp4 size:>1gb"  maxResults=50
everything_search query="dm:thisweek ext:log" 
everything_search query="folder:日记"
```

## 安装

```powershell
# 1) 建 node_modules junction —— @deepseek-ai/dsh-tools 靠它解析，删了会静默装载失败
New-Item -ItemType Junction -Path "<this-dir>\node_modules" -Target "$env:USERPROFILE\.dsh\profiles\node_modules"

# 2) 注册进 profile（二选一）
dsh plugin --profile desktop add <this-dir>     # 官方 CLI
#   或手工三处齐：profile 的 package.json 加 link: 依赖 + dsh.profile.bundles 加一行，
#   再建 profiles\<profile>\node_modules\@dsh-external\dsh-local-search junction 指向本目录

# 3) 自检
node test/smoke.mjs
```

实测（2026-10-03）**证伪**了「装完要重启」的想当然：宿主进程 PID 51652 自 13:36:06 起从未重启，
15:22 用 `dsh plugin add` 装载后**当场**就能调用 `everything_search` —— **新增 bundle 是即时生效的，不必重启 App**。

要与另一件事区分清楚：修改**已装载**插件的模块代码不会热重载（ESM 模块实例已缓存），那种情况才需要重启。
换句话说，`add` 走的是插件管理器的主动 mount，而改文件走的是 ESM 缓存 —— 两条路，别混。

## 与 VCP 原版的三处刻意差异

**1. 不走 stdio 桥接，直接 HTTP 直连 Everything。**
`dsh-code-tools` 的做法是 spawn 原版插件进程。这里没跟，理由三条实证：

- 本工具的全部价值就是「秒」。桥接要先 spawn 一个 node，再 `spawnSync` 插件进程，Windows 上
  平白多 200–400ms；而 Everything 热查询实测 56ms —— 桥接会让「秒搜」名实不符。
- code-tools 选桥接的核心理由是「凭证/代理实时读 VCP 侧原位文件」。原插件**零凭证**，纯 40 行 HTTP，
  这条理由在这里不存在。
- VCP 两份副本端口自相矛盾：`VCPToolBox\Plugin\VCPEverything` 无 `.env` → 代码里默认 8025（本机无人监听）；
  `VCPChat\VCPDistributedServer\Plugin\VCPEverything` 的 `.env` 指 80（本机活着）。桥接哪一份都不确定。

代价是这段适配逻辑住在本包里；换来的是**不依赖 VCPToolBox 目录存在**，可独立装卸与回退。

**2. 端口不写死。** 读 `%APPDATA%\Everything\Everything.ini` 的 `http_server_port`；连接被拒时清缓存
重读一次，所以主人在 Everything 里换了端口**不必重启 DSH** 即自愈。可用环境变量
`DSH_EVERYTHING_PORT` 钉死。

**3. 多取两列。** 原版只回路径列表，Agent 拿不到「该读哪一个」的判据。这里带 `size_column` 与
`date_modified_column`，大小与修改时间正是分诊依据。

## 落地时才发现的坑（都固化进了 smoke）

- **`es.exe` 是 manifest 里的谎话。** 两份 `plugin-manifest.json` 都写 `EVERYTHING_ES_PATH` 指向
  `es.exe`，但 `local-search-controller.js` 全程走 HTTP —— `es.exe` 根本没装，也不需要装。
- **`date_modified` 是 FILETIME**（1601 纪元的 100ns 计数，形如 `134067152700000000`），
  不是 Unix 毫秒也不是 ISO 串。纪元常量或除数写错会**静默**给出偏移数年的时间。
  smoke 里拿 `fs.statSync().mtimeMs` 对撞 + 逐字比对格式化串，这是全项目最关键的一条护栏。
- **`n` 参数不被 `http_server_items_per_page` 截断。** Everything 网页默认每页 32，但 JSON API 的
  `n=500` 实测确实回 500 条。smoke 里有一条专门守这个，免得日后误以为要分页。
- **中文不是问题。** Everything 回的是标准 UTF-8（`Content-Type: application/json`，无 charset）。
  用 PowerShell `Invoke-WebRequest` 看会乱码（它按 Latin-1 解），那是**观察工具的毛病**，不是服务的毛病 ——
  Node 侧 `toString('utf8')` 直接就对，所以本包一行编码修复代码都没有。
- **`defineTool` 的 required/类型校验跑在业务分发之前。** 缺失或类型不对会直接抛 `ToolArgsError`，
  进不到 `execute`。所以「缺失」归框架兜，「空串 / 纯空白」才是本工具该管的 —— 后者必须自己拦，
  否则空关键词会让 Everything 命中全盘。

## 排查

| 症状 | 处置 |
|---|---|
| `ECONNREFUSED` | Everything 没运行，或「工具→选项→HTTP服务器」没勾选启用 |
| 端口不对 | 本工具会自动重读 `Everything.ini`；也可 `DSH_EVERYTHING_PORT=8025` 钉死 |
| 查询超时 | 关键词过宽（空关键词命中全盘）；收窄或调大 `DSH_EVERYTHING_TIMEOUT_MS` |
| 工具表里没有 | 查 `dsh plugin --profile desktop add` 的三处落位（deps 行 / bundles 行 / junction）齐不齐；新增 bundle 即时生效，不必重启 |

## 文件

| 路径 | 职责 |
|---|---|
| `lib/everything.js` | 纯逻辑：端口发现、HTTP 查询、FILETIME 换算、结果格式化、错误诊断 |
| `lib/index.js` | cordis 宿主外壳：注册 `everything_search` |
| `test/smoke.mjs` | 24 项端到端冒烟，打真实 Everything，不 mock |
| `cordis.patch.yml` | bundle 自带的装载 patch |
