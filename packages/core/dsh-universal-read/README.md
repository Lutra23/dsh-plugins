# dsh-universal-read

把 VCP FileOperator 的**只读三命令**（ReadFile / WebReadFile / DownloadFile）移植为 DSH 常驻工具 **`universal_read`**。
其余 17 个命令不搬：写系列已有 `project_forge`（还带账本回退）；WriteEscapedFile / UpdateHistory / CreateCanvas 是寄生在 VCP 宿主上的死命令；SearchFiles 已被 `everything_search` 取代。

```
universal_read filePath="D:\\报告.pdf" lines="head:80"
universal_read filePath="D:\\表.xlsx" lines="1-20"
universal_read url="https://example.com/doc.pdf"
universal_read url="https://example.com/pkg.zip" mode="download" downloadDir="D:\\dl"
```

## 为什么是桥接（和 dsh-local-search 那次结论相反，同一条原则）

上次做 Everything 时选了原生直连、没走 stdio 桥，这次反过来 —— 听证据不听惯性：

1. 价值在解析器，不在传输。pdf-parse / mammoth / exceljs 加上编码嗅探，已经装在
   `VCPToolBox\node_modules` 里且版本与原版锁死。桥接 = 零安装、零复刻；重写 = 把 1963 行
   里的坑（OOXML 行尾、CSV 流、图片 dataURI……）再踩一遍。
2. 安全门复用。`isPathAllowed` / `MAX_FILE_SIZE` / 白名单语义全部留在原版里，
   本包不重写半吊子护栏 —— 读能力越强，越不能自己造门。
3. 桥接层不设自由 `command` 参数：调用方连 command 字段都摸不到，写操作在协议层就不可达。
   想调 WriteFile？此路不通，去用 `project_forge`。

## 三个实测才知道的细节

- **相对路径在本层直接拒绝。** 原版会把裸相对路径默默解析到 VCPToolBox 根下（`BASE_PATH`
  默认上两级），极易误读。`buildRequest` 里 `isAbsolute` 不过就拦 —— 这是本包唯一加在原版
  之上的安全规则。
- **`DEBUG_MODE=false` 是显式压住的。** VCP 侧 config.env 写着 `DEBUG_MODE=true`，不压的话每次
  调用 stderr 刷几屏。dotenv 不覆盖已有环境变量，所以 wrapper 环境里直接钉死。
- **DownloadFile 的语义变了（变好）。** 原版它是 fire-and-forget：命令立即返回、下载在后台继续，
  AI 还得自己去确认。本包走"一次调用一个短命进程"：wrapper 内 `spawnSync` 等原版进程退出才返回，
  而原版进程要等 stdin 关闭 + 事件循环排空 —— 实测返回即落盘完成。`落盘路径` 直接可信，无需二次确认。
  代价是给了 300s 上限；超时杀掉的下载可能留半截文件，diagnose 里写明了先确认大小再读。

## 行为契约

| 项 | 值 |
|---|---|
| 允许 | 任意**绝对**路径读（原版 `isPathAllowed` 对 ReadFile/FileInfo 开只读旁路）；http/https 取文、下载 |
| 拒绝 | 相对路径（本层拦）；非 http/https 的 url；DownloadFile 目标目录受 ALLOWED_DIRECTORIES 约束 |
| 上限 | 单文件约 20MB（VCP 侧 MAX_FILE_SIZE）；返回文本超 4 万字符截断并指路 `lines` 分页 |
| 图片/音视频 | 不贴 base64 进上下文 —— 转指引去 `read_image` 按路径看 |
| 超时 | 本地读 60s；URL 两条路 300s（均为 wrapper 内 spawnSync 层，code-tools 同款） |

## 安装

```powershell
# 1) 建 node_modules junction —— @deepseek-ai/dsh-tools 靠它解析
New-Item -ItemType Junction -Path "<this-dir>\node_modules" -Target "$env:USERPROFILE\.dsh\profiles\node_modules"

# 2) 注册进 profile（新增 bundle 即时生效，不必重启 App；浏览器半刷新页面）
dsh plugin --profile desktop add <this-directory>

# 3) 自检（打真实 FileOperator 进程 + 真实 PDF/docx/xlsx，不 mock）
node test/smoke.mjs
```

WebReadFile 的默认落盘在 `VCPToolBox\file`（原版 `WEB_FILE_DIR` 默认）；smoke 用 `envExtra`
把它隔离到临时目录，不污染 VCP 侧。

## 文件

| 路径 | 职责 |
|---|---|
| `lib/universal.js` | 纯逻辑：参数→原版请求、stdio 桥、信封解析、输出整形、诊断 |
| `lib/index.js` | cordis 宿主外壳：注册 `universal_read` |
| `test/smoke.mjs` | 单元（参数校验/整形）+ 端到端（真进程真文件；本地 HTTP 服务器覆盖 URL 两条路） |
| `cordis.patch.yml` | bundle 自带的装载 patch |
