# DSH 工程施工台 · 0.4.0-local.1

本机 Forge 插件，适配官方 DSH 桌面内核 0.2.0-rc.2。含工程快照、代码编辑与搜索、操作回执，以及施工图管理小窗口。无需 VCPChat 常驻，Tavern 独立保留。

## 打开窗口

新设计（待施工）：[工程上下文压缩施工图](docs/context-compaction-blueprint.md)，接手 Agent 可先读[精简执行页](docs/context-compaction-execution.md)。

- 点击 DSH 左侧栏的 **施工图**，与“任务看板”并列。
- 在 DSH 中调用 `forge_panel`，参数 `action: open`。

面板通过官方 `sidebar.panellist` 和 `main` 插槽显示在 DSH 主区域，随 DSH 主题切换。切换页面不会取消工程操作；工具和面板共享常驻引擎、工程数据库。原桌面快捷方式及独立浏览器启动脚本已移除。没有修改 DSH 安装包，也没有增加第二套 Web/CLI 内核。

默认打开“AI 工程”，直接列出当前可访问的既有 Forge 工程（包括 AI 创建的工程），支持按名称、工程 ID 和路径搜索。点击工程即可看概览、待办、变动脉络、验收报告和操作记录，无需先登记 Markdown 或关联文档。新建工程在刷新时自动出现，重新打开会恢复上次选择。

“文档”标签用于独立 Markdown 施工图。三份配套说明自动登记，也可添加授权工作区内的其他 `.md` 并按需关联工程。文档正文直接读取原文件；阅读不会创建工程。仅存在聊天正文、没有保存为工程或文件的计划，不会被当成已登记施工图。

找以前的改动请看“变动脉络”；“操作记录”只包含启用操作回执后的请求。前端升级后，切到“任务看板”再返回“施工图”即可加载新页面，不必重启引擎。

窗口支持：章节目录、工程选择、选择工作包导入待办、待办状态和备注、验收报告与旧版本、历史前后内容对照、取消请求、操作核对，以及带原因的单文件回退。回退前读取真实磁盘，预检 60 秒有效，提交再次检查文件与工程版本；回退本身产生新历史。

## Todo 与心流锁

### 跨会话接力（0.4.0）

新会话继续同一施工图时先 GetProject 读取原工程，不复制清单、不新建同名工程。需要显式切换会话视图时用 `BindProject + projectId`：同步原生 Todo 并提供简短接力上下文，但不自动认领任务。

任务仍由旧会话持有时，当前会话可用 `TaskAction handoff + taskId + expectedRevision + expectedOwner + reason` 一次接手，无需先进入旧聊天暂停。`expectedOwner` 来自 GetProject 的 owner；`reason` 说明接力原因和下一步。原会话主动交出时再加 `targetSessionId`。待办／已暂停任务直接 start/resume，已完成任务不能交接。接手会话若已有其他进行中任务会拒绝，revision 或归属变化也会拒绝。

交接保留 taskId、进度、依赖、验收条件及证据；只变更执行归属和激活。旧焦点失效，接手会话绑定原工程并产生新记忆边界。旧会话后续 Forge 写入无法沿用被交出的任务，旧心流暂停；新会话不继承自动续跑授权或预算。

面板“待办 → 交给其他会话”可选择／粘贴目标会话 ID，确认原因后执行相同事务。原生 Todo 显示其他执行会话，成功操作后刷新已知会话，空闲会话约每 3 秒同步；离线会话下次活动时更新。迟到旧快照按持久修订丢弃，不覆盖新进度。同步和交接本身不请求模型。

Agent 在下一步得到一份简短的工程状态：归属、已有进度、下一项、验收和关联文档路径。此插件专属块更新时替换，不复制旧聊天或累积旧记忆；用户新输入仍优先。任务交接与完成验收是两个不同操作，`advance` 指完成当前项并开始下一项。详细约定见 [跨会话接力说明](docs/session-handoff.md)。

工程任务现在由共享后端校验。先 GetProject 读取 taskId/revision，再用 TaskAction start（已有进行中任务可 resume），施工时明确 todo 序号。complete 需要 evidence；advance 在一个事务里完成当前项并开始下一项。不能从 pending 跳到 done，不能整表覆盖抹除历史。调整计划用 replan；暂停、受阻、取消需原因。旧工程状态原样保留，标为历史记录；历史 done 不会自动视为有证据的验收。

面板“待办”提供上述动作，选择执行会话后与 AI 共用校验。心流锁位于当前工程上方：先在对应 DSH 聊天中 GetProject/创建工程，再选会话，点击“启动”。默认预算 40 步、6 次续跑、20 分钟；可暂停、继续或停止。新用户输入、范围新增、受阻、连续无进展、预算耗尽会暂停。重启保留运行记录并暂停，不自动请求模型。模型输出 Complete 不会自动勾选任务或把工程设为 accepted。

心流启动会在该会话使用其既有模型；本次回归测试未调用真实模型。关闭面板不终止运行。临时非工程 Todo 保留官方 todo_write，完成前通过 todo_checkpoint 提交依据；明确结束旧清单使用 action=reset 并给 summary 原因。

文件/节点引用由后端检查存在性、归属和当前内容 hash；检查结果及语义结论仍是提交者声明，调查 URL 只核验格式，不自动联网验证真实性。外部终端改动只能通过产物对账，无法保证所有操作已关联任务。恢复类回退仍可从面板独立执行，避免工程受阻时无法恢复。

## 工具与参数

| 工具 | 用途 |
| --- | --- |
| `project_forge` | 30 个命令，包括 BindProject 和 TaskAction 的任务转换；每次操作返回 operationId 和状态 |
| `forge_panel` | 打开窗口；按 operationId 查询状态或请求取消 |
| `code_searcher` | 原生文本/正则搜索 |
| `read_image` | 在宿主附件服务和模型支持时读取图像 |

```
ListWorkspaces CreateProject ListProjects GetProject BindProject UpdateTodos TaskAction SubmitReport
DeleteProjects RestoreProjects PurgeProjects
ReadCode Outline FindSymbol Trace References Memory
EditCode ResolveEdit CreateFile RemoveFile MoveFile MoveCode CopyCode
Rollback SearchHistory GetNodeDiff
```

命令级校验保留实际引擎别名，包括 `project`/`id`、`filePath`、编辑串及 `edits`。
`traceTarget → target`、`outlineDepth → depth`、`opFilter → op`；冲突参数会报错。
EditCode/CreateFile/MoveCode/CopyCode 默认开启语法错误拦截，编码与换行保持原语义。

Trace 明确提供 `traceMode: static`（不执行工程代码）与 `registry-assisted`（会在子进程加载工程 registry）。省略保持旧声明增强行为。输出含扫描范围、时间、截断、跳过项与覆盖说明；它只分析支持的模块/页面/IPC/全局关系，不是通用函数调用图。优先用静态模式。

`References` 按符号名查引用，输出四档置信度：`import-bound`（能解析到声明文件的导入）、`code-lexical`（仅同名代码）、`dispatch-key`（分发表键）、`non-code`（字符串/注释，只计数）。裸说明符按 tsconfig/jsconfig 的 `baseUrl` + `paths` 解析，相对说明符按引用文件所在目录解析，所以 `@core/fs` 这类不含 basename 的别名不会被漏判。`limit`（默认 50）、`maxPerFile`（默认 5，超出折叠为 `+N more in this file`）、`budgetMs`（默认 4000）；`degraded=true` 表示预算耗尽、结果不完整。

`Memory` 管理工程记忆（Markdown，落在 `<root>/.forge/memories/`）：`mode=list` 列 id，`mode=read` 读（默认 `00-architecture`），`mode=write` 写正文并校验 `mem:<id>` 引用断链，`mode=bootstrap` 给老工程补建架构记忆（已存在不覆盖），`mode=rebuild` 强制重建。CreateProject 会自动生成 `00-architecture`（顶层目录、package.json、scripts）。读写不启进程，写入走路径守卫。

## 工作区和权限

工程服务实时读取 DSH 的 `~/.dsh/storages/workspace.json`。引擎合并宿主登记工作区与 `data/workspaces.json` 中的补充目录，宿主同名项优先。停用补充工作区会转只读；被移除的授权根不再用于新请求。若同一路径同时由两个来源授权，需要在相应来源分别移除。

路径检查解析真实目录，阻止通过符号链接、目录联接跳出工程；写入前再次核对请求开始时的范围和当前权限。工程管理按钮不会扩大工作区授权。此插件继续沿用原有裸文件系统适配方式，不能把它等同于 DSH 的审批或沙箱栈。

`DSH_VCP_ROOT` 可配置 code-tools 使用的 VCPToolBox 位置，默认当前用户桌面的 VCPToolBox。

## 回执与异常处理

| 状态 | 含义 |
| --- | --- |
| running | 排队或执行中 |
| completed | 完成，未记录文件或业务数据库变动 |
| committed | 本次效果和最终回执已记录 |
| cancelled-before-commit | 在任何已知业务效果前取消 |
| failed-before-commit | 在任何已知业务效果前失败 |
| needs-reconciliation | 已有或可能有部分效果，需要核对 |
| unknown | 尚未查到结果，不能当成没执行 |

同一 operationId 对同一请求去重，对不同请求报冲突。超时或关闭等待不会盲目重试；取消是协作式，原生索引工作可能需要到下一个检查点才结束。

遇到待核对状态，在窗口“操作记录 → 核对详情”查看每个文件的前后 hash、磁盘现状和关联账本节点。保留回执与数据库；不要换新 operationId 自动重试，也不要手工删除日志表。引擎保守阻止继续写入涉及文件。当前版本不自动修复模糊的文件/数据库跨系统故障，需根据快照作针对性恢复。

## 验证和维护

```
npm run doctor                 # 离线分层检查，不执行工程 registry 或调用模型
node scripts/doctor.cjs --selftest   # 加上临时隔离目录的可靠性测试
node --test test/*.test.cjs          # 隔离可靠性/接力/任务/桥接/边界/面板测试
node test/selftest.cjs               # 29 项原功能/编码回归
npm run schema-report          # 离线候选目录比较，结果不代表 token 节省率
```

真实桌面模块审计用 `scripts/desktop-audit.cjs`，由已安装 DSH 可执行文件在 `ELECTRON_RUN_AS_NODE=1`、`--expose-internals` 下运行。它检查所有配置插件的导入、真实 defineTool 注册及官方 HostConnectionService 路由和 Cordis 生命周期。引擎使用隔离替身，不启动模型会话或改动工程。

关键依赖：better-sqlite3、glob、ESLint、diff-match-patch、chardet、iconv-lite，及随包原生索引器/搜索器。PDF/Word/Excel 提取依赖未安装时，仅对应 Forge 读取格式不可用；可使用已有 universal_read，不会阻止工程编辑或面板启动。

目录结构：`lib/` 协议/持久化/鉴权，`ui/` 实际前端，`vendor/` 上游移植代码及明确本地补丁，`scripts/` 诊断/入口/审计，`test/` 隔离测试，`data/` 正式工程账本与运行发现文件。

`data/engine.json` 含本机 RPC 凭据，不应复制到报告或发给其他人。服务只监听 127.0.0.1；DSH 内嵌页面通过官方 Connection 的同源鉴权路由通信，写操作另有 CSRF 校验；引擎凭据不发送给页面。Markdown 正文 HTML 不执行。

详见 [实施记录](docs/implementation-report.md)、[维护与恢复](docs/operations-runbook.md)。

## 0.3 回退与恢复

修改前源码与一致性数据库快照：`~/.dsh/backups/forge-flowlock-20261007-202211`（历史部署机）。先退出 DSH，确认工程服务无运行操作，再通过现有引擎 RPC shutdown 关闭服务。将备份中的两个插件源码恢复到原目录；node_modules 和 data 不在源码恢复范围。旧代码会忽略新增 pf_task_* / pf_flow_* / pf_session_bindings 表，可保留这些表以保存审计。仅在确认没有需要保留的新工作时使用 database/projectforge.db 做完整恢复，并先另备份当前库；不要覆盖仍在运行的 WAL 数据库。

当前 todo_write 兼容入口可以提交已有工程条目的开始或交接，完成前先 todo_checkpoint；新增/重排通过工程工具保留 taskId。心流与任务历史都在现有施工图面板，不创建桌面图标。
