# dsh-workspace-docs

给 DSH agent 装上「项目地图」：把当前工作区的**顶层文件夹名与各文件夹内的文档文件清单**注入模型可见的运行时上下文，让 agent 接任务时先读 README、更新日志与工程记录，而不是上来就 `glob` / `grep` 盲搜。

## 解决什么问题

新会话的上下文里只有规则、工具说明和工作目录路径，agent 对工作区里有什么文件**一无所知**。它不知道有没有 README、更新日志、设计笔记，于是只能边搜边猜，费轮次又容易漏掉真正该读的文档。

这个插件只列文件名（不读内容、不递归），把「去哪找文档」直接摆到模型面前。

## 注入形式

通过 `ctx.systemPrompt.context()` 注册为**运行时上下文快照**——和官方 `working-directory` 注入当前目录走同一条通道，模型会当作上下文读，界面上不显示为聊天气泡。

```
当前工作区文件概览（由 dsh-workspace-docs 自动生成，只列文件名，未读内容）：
工作目录：<工作区路径>

顶层文件夹（3 个）：
- app/
- packages/
- scripts/

顶层文档（优先读）：
- CHANGELOG.md
- CONTRIBUTING.md

各文件夹内的文档文件（优先读）：
  - packages/api/：README.md、CHANGELOG.md
  - packages/web/：README.md
  - app/legacy/：README.md、ARCHITECTURE.md

接项目任务时，先按上面的文档清单读 README、更新日志与工程记录，再决定是否搜索代码；
清单没覆盖到目标时再用 glob/grep 定位。
```

## 扫描规则

- **只列文件名，不读内容。** 读什么由模型自己用 `read` 决定，插件不替它判断哪个重要。
- **顶层列一层**；若某个目录本身是「容器」（内部还有子目录），再下探第二层找文档，覆盖「工作区顶层放着多个项目文件夹」的常见布局。最深两层，不递归。
- **噪音目录自动排除**：`node_modules`、`.git`、`dist`、`build`、`coverage` 等固定名单，加上 `_` 开头与 `.` 开头的目录（临时/工具目录常见形态）。
- **文档识别**：扩展名 `.md` / `.txt` / `.markdown` / `.rst` / `.adoc`，或文件名含 `readme`、`changelog`、`changes`、`history`、`notes`、`todo`、`license`、`contributing`。
- **文档排序**：README 优先，其次 CHANGELOG，再次 ARCHITECTURE / DESIGN，最后其余 `.md`，避免零散日志挤掉主力文档。
- **超出上限时明确告知**：顶层超过 `maxTopLevel` 条会输出「还有 N 项未列出，需要时自行查看」，把补看动作交回模型，插件不猜项目结构。
- **每次请求检测目录变化**：记录所有被列目录的 mtime，未变直接复用（约 0.5ms），有增删改名才重扫（约 8-10ms），清单不会在会话中途变旧。
- **拿不到会话工作目录时不注入**，避免把无关目录清单塞进别的 agent 的 prompt；读取失败也不阻断会话。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTopLevel` | `50` | 顶层最多列出多少条（目录优先占名额，剩余给文件）；超出部分只报数量 |
| `maxDocsPerDir` | `12` | 每个子目录最多列多少份文档；同时限制容器目录下最多扫多少个子目录 |
| `maxBytes` | `4000` | 渲染后注入文本的字节上限，超出按 UTF-8 边界截断 |
| `order` | `130` | 运行时上下文的排序位置；官方 `WORKING_DIRECTORY` 是 `100`，本插件排在它之后 |
| `ignored` | 见源码 `DEFAULT_IGNORED` | 额外排除的目录名（不区分大小写）；`_` 与 `.` 前缀规则始终生效 |

```yaml
- id: workspace-docs
  name: dsh-workspace-docs
  config:
    maxTopLevel: 50
    maxDocsPerDir: 12
    maxBytes: 4000
    order: 130
```

## 依赖

零外部依赖，只用 Node 内置模块（`node:fs`、`node:path`、`node:os`）。**不 import 任何 `@deepseek-ai/*` 包**：插件由 bundle patch 以相对路径加载，若 import DSH 内部包会在解析阶段失败。

插件声明的服务：`systemPrompt`（注册运行时上下文）、`workingDirectory`（取会话工作目录）。

## 安装

1. 把本目录放到 DSH profile 能解析到的位置，例如 `~/.dsh/plugins/dsh-workspace-docs`。
2. 在 profile 的 `package.json` 中加入依赖与 bundle：

```json
{
  "dependencies": {
    "dsh-workspace-docs": "link:<插件目录绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-workspace-docs"]
    }
  }
}
```

3. **不需要**手改 profile 的 `cordis.patch.yml`：插件自带 `dsh.bundle.patch`，加载器会自动读取它的 `cordis.patch.yml` 并插入插件行。
4. 重启 DSH，新会话生效。

## 已知限制

- 只扫两层，更深的嵌套（如 `packages/a/src/docs`）不会自动列出，需要模型自己用 `glob` 补。
- 容器目录下最多扫 `maxDocsPerDir` 个子目录，项目极多时会截断，此时依赖「未列出」提示让模型自行补看。
- 变更检测看的是**目录条目**（新增/删除/改名）；只改某个文档的内容不影响清单，因此不会触发重扫。
- 注入内容在会话历史中的快照由 DSH 管理，压缩（compaction）后是否保留取决于上下文的保留策略。

## 版本历史

### 0.3.1 — 2026-10-26 14:34
- README 全篇校准：修正与当前实现不符的说明（注入通道、依赖模块、注入服务、已知限制），示例输出统一改为占位符。

### 0.3.0 — 2026-10-26 10:37
- 注入通道由 system prompt section 改为**运行时上下文**（`ctx.systemPrompt.context()`）：部分第三方/代理模型不依据 system prompt 正文行动，运行时快照才是它们真正读取的通道。
- 回调参数修正为 `context.agent`（此前误用 `context.session`，导致始终取不到会话目录）。
- 缓存策略改为**按请求做变更检测**：记录所有被列目录的 mtime，未变则复用（约 0.5ms），有增删改名才重扫（约 8-10ms），会话中途新建的目录与文档能立即反映到清单里。
- 移除固定 TTL 方案，避免「改了但还没到刷新时间」的空窗。
- 拿不到会话工作目录时不再回落到进程目录，宁可不注入，避免污染其他 agent 的 prompt。

### 0.2.0 — 2026-10-25 23:54
- 注入通道从 `agent/pre-step` 的 user 消息改为 `ctx.systemPrompt.section()`，清单进入 system prompt，不再占用对话历史。
- 通过 `inject: ['systemPrompt', 'workingDirectory']` 获取 prompt 注册表与工作目录服务。
- section 的 `text` 为同步求值：`systemPrompt.assemble()` 同步调用 `text`，返回 Promise 会被当成文本，因此扫描改为同步 `readdirSync` 并按目录缓存。

### 0.1.0 — 2026-10-25 21:34
- 首个版本：会话首轮自动扫描工作区，注入顶层文件夹清单与文档文件列表。
- 支持两层下探，识别「工作区顶层放多个项目文件夹」的布局。
- 自动排除 `_` / `.` 前缀与常见构建、依赖目录。
- 文档按 README → CHANGELOG → ARCHITECTURE → 其余优先级排序。
- 顶层超出 `maxTopLevel` 时输出剩余数量提示，引导模型自行补看。
- 注入体积受 `maxBytes` 限制并按 UTF-8 边界截断。
