# DSH 上下文整理（`dsh-forge-context`）

面向本机 **Standard、PTC、Minimal、Cordis 与锻造（Forge）** 五大预设的上下文可逆压缩与工程账本插件。
插件完全建立在 DSH 官方会话与四步压缩事务（`admit → summarize → exchange → ledger`）之上，**不注册第二个压缩后端，不修改桌面内核**；日常任务无需强制绑定工程、启动心流或创建 goal 即可开箱使用，原生手动 `/compact` 命令同样照常工作。

> **当前版本：`0.0.9`（内部 tgz）**
> - 安装与回滚说明见 `SHARE-0.0.9.md`。
> - **宿主依赖**：需配合支持 `supersededOpenIssues` 的 `dsh-project-forge`（`0.4.1-local.5` 及以上），内核对齐 `0.2.1-rc.2`。

---

## 1. 核心设计铁律

1. **语义与坐标分离（模型/程序分工）**
   - **模型只写语义**：本段干了什么（`summary`）、决策与理由（`decisions`）、未决问题（`openIssues`）、下一步（`nextAction`）及实质用户需求的去留。
   - **程序包办坐标与令牌**：路径、版本号、符号常量、活跃 64 位哈希（`hardTokens`）、`pinned` 原文回填以及 `taskRefs` 状态均由程序从原文自动抽取与核验。模型无需看到令牌清单，更严禁手抄（彻底根除 `0.0.5` 因模型手抄哈希失误导致连拒 8 次熔断的顽疾）。
2. **先拒绝、后写盘（零额外缓存粉碎）**
   - `candidates` 列表、`preview` 干跑与 `compact / compact_batch` 提交共享同一套准入判定函数（`verdict as data`）。空区间、已遮蔽节点、非连续片段及 `NO_GAIN` 均在首个写盘前拦截，绝不制造半截脏账或额外的 KV Prefix Cache 失效。
3. **原文永不销毁（可逆回溯）**
   - 压缩仅替换当前推理表面（Surface），原始事件流永久保留在会话日志中。随时可通过 `read`、`search`、`blocks`、`user_messages` 按游标分页调取原文。
4. **单一真源保护（Producer 溯源）**
   - 严格按消息生产者身份（`source.kind`）判定保护边界。仅锁定真实用户输入（`source.kind === 'user'`）与系统指令（`AGENTS.md` / `skill`）；13 类机器衍生快照（如 `memo-recall-pulse`、时间/运行时上下文、`compact-checkpoint` 等）均标记为可压，不把插件注入误判为用户原话。

---

## 2. Agent 标准工作流与操作契约

推荐执行流：**`status → candidates → (按需 read) → preview → compact_batch / compact`**

### 2.1 状态与候选勘察（`status` / `candidates`）
- **免考古内嵌用户消息**：每个候选段自带区间内的 `userMessages`（含 `seq`、原文开头、字数、附件标记、是否已被遮蔽）。
  - `substantiveUserSeqs`：点名必须体现为 `origin=user` 保留约束（或显式声明丢弃）的 seq；
  - `truncatedUserSeqs`：点名因超长被截断、需调 `read {seq}` 补看全文的 seq；
  - **预算不丢项**：整册 `candidates` 回执共享 24,000 字符内嵌预算（候选多则每项收窄，下限 1,200 字符），超长消息仅截断正文，绝不挤掉其它条目。
- **候选缓存生命周期**：宿主持有最近 128 个候选缓存。普通工具往返不会使已签发候选失效（尾部增长无需重抄旧候选）；唯有**新真实用户输入、任务内容变化、表面发生替换、新增固定内容或宿主重启**时才会触发重检。若包含进行中或未开始阶段，候选统一归类为 `ongoing-stage`（即使混有已完成项亦不误标为 `closed-stage` 或 `stale-output`）。
- **未决目标置顶**：`status` 顶部自动从最新摘要的 `openIssues / nextAction` 及未闭环 Todo 中派生 `openObjectives`，防止长程跨轮次遗忘目标。

### 2.2 零写干跑（`preview`）与机械草稿（`autoDraft`）
- **`preview`**：共享完整摘要、保护与文件哈希校验，返回将被遮蔽的精确 `seq`、预计表面节点数、收益估算、`hardTokens` 计数与闸门结论（`ok` / `code`）。
  - **不回显摘要正文**：避免草稿正文在上下文中二次膨胀；不写日志、不调模型、不占执行许可。
- **`preview {autoDraft: true}`（机械轨道）**：针对 `stale-output`（旧测试/构建输出），零写返回程序生成的机械草稿（自动抽取首尾行、退出码与活跃令牌），模型零 Token 消耗。
- **价值闸门（`NO_GAIN`）**：若 `gate.ok = false` 且 `code = NO_GAIN`（或 `valueVerdict = poor`，净回收不足 256 tokens 或回收率 <15%），程序会给出带数字的精简目标；允许改短摘要重试，但严禁原样重复提交。

### 2.3 批次提交与断点续传（`compact_batch` / `compact`）
- **优先批量提交**：使用 `compact_batch {operationId, items: [{candidateId, summary}, ...]}`（每批 1–8 个不重叠候选），`snapshotId / sourceSeqs` 由宿主从缓存自动补齐。
- **批次事务语义（写前全预检 + 断点续传）**：
  1. **写前全预检**：在首个写盘动作前，对批次内**每一项**完整执行 `preview` 级内存预检（准入 + 摘要契约 + `NO_GAIN`）；
  2. **全坏零写**：若全部不过，整批零写拒绝并逐项点名（坏项标出具体错误字段，好项列出），一轮修完即可；
  3. **好项即落**：若部分通过，好项在同一调用内落盘，坏项点名待修；达到维护目标水位即提前停止余项；
  4. **幂等与续传**：所谓「部分成功不回滚」专指预检通过后在 `exchange` 阶段遭遇宿主中断/用户插话时的断点续传（此时缓存已因合法压缩更新，保留已落盘项旨在避免模型重写多份长摘要）。各项稳定身份为 `operationId-0/-1/...`，同序同参重放幂等跳过，重启后仍可查；若参数变更则报 `OPERATION_CONFLICT`。
- **回执瘦身**：成功的单一/相邻压缩回执自动替换为短状态摘要（防止 11K 长回执在下一轮自身变成最大待压块）；完整账本随时通过 `forge_context receipt {operationId}` 按需调阅。

---

## 3. 摘要 Schema 契约（13 项，严格闭合）

宿主 `summarySchema` 采用 `additionalProperties: false` 严格校验——**任何未声明字段均会导致整条拒收（且底层报错不回显字段名，排查极贵）**。引擎 `draft.*` 必须为宿主 Schema 的严格子集（由 `host-tools-schema.test.cjs` 钉死断言）。

| 字段 | 必填与核验规则 | 编写与兜底说明 |
| :--- | :--- | :--- |
| **`summary`** | **必填**（机械轨道除外） | 自包含叙事正文（上限 64K 字符，建议 `summaryBudgetTokens ≤ 8192`，但不可为凑预算删约束）。首行建议写明 `Open objectives: ...`。 |
| **`requirements`** | **覆盖校验** | 候选内含实质用户消息时，必须保留至少一条 `origin="user"` 约束并附精确 `sourceRefs`（其他来源不可顶替）。连续压缩自动继承上级约束。 |
| **`droppedUserSeqs`**<br>**`droppedReasons`** | **成对条件必填** | 故意不将某条真实用户消息写入 `requirements` 时，必须成对声明 `seq` 与 `reason[{seq, reason}]`（≥2 字）。**ACK 短续句特例**：对 `继续/好/嗯/ok`（≤4 字精确全等）被列入丢弃时，程序自动代填『纯推进指令』并标 `completedByHost`。 |
| **`supersededRequirements`**<br>**`supersededOpenIssues`** | 可选（新陈代谢） | 填入被本轮新指令或新进展正式淘汰的上级 `requirement` / `openIssue` 的 seq，防止多代压缩后过期约束无限堆积钙化。 |
| **`decisions`** | 强烈建议 | 记录已定决策及**背后的理由**（“选 X 因为 Y”，理由比结论更有跨轮次价值）。 |
| **`openIssues`** | 条件必填 | 未决 TODO、风险、待确认项。**当区间包含 paused / blocked 任务时必填**。 |
| **`nextAction`** | 强烈建议 | 一句具体、可执行的下一步动作。 |
| **`files`** | 建议 | 本段真实触碰过的文件路径数组（去重后 `≤ 200` 条，含空串或超限整条拒收）。 |
| **`taskRefs`** | 可选（宿主兜底） | `taskId` + 状态；省略时由宿主从 Forge 账本自动补齐并标 `completedBy: host`。 |
| **`evidenceRefs`** | 可选（宿主核验） | 提供工作区内路径与 64 位 SHA-256 时，宿主实时核验字节：一致为 `current`、不符为 `expired`、不可读为 `unreadable`（单文件 ≤8MiB，单次 ≤32MiB/64文件）。**注：`current` 仅证明核验时字节一致，不等同于通过测试或验收**。维护期可用只读动作 `{action:"evidence", paths:[...]}` 获取真实指纹。 |
| **`pinned`** | 可选（程序回填） | `[{seq, reason, text}]` 将关键原话钉入摘要。`seq` 必须在候选 `sourceSeqs` 内；正文始终由程序按原文强制回填（模型所填 `text` 不符时标 `completedByHost`）。 |

> **⚠️ `sourceRefs` 填写禁区**：只填候选精确 `seq` 或保留上级摘要来源。区间 `1430–1895` 不代表每个数字皆可引用（如 `step/start` 无正文，任务 ID / 工具调用 ID 亦非正文 seq）。无法确认精确 seq 时可省略该可选字段，严禁盲猜相邻编号。
> **⚠️ 语义完备性说明**：预览与回执的 `semanticCompleteness` 区分 `requirements-carried`、`not-verified` 与 `not-applicable`，三者均不代表“语义无损已被数学证明”。

---

## 4. 原文回溯与历史检索工具面

当前上下文中已可见的原文无需重读，仅对遮蔽或截断部分按需提取：

- **`user_messages`（按人枚举）**：`{action: "user_messages", order: "newest"|"oldest", offset, limit, withText: false}`。零关键词直接枚举本会话全部真实用户消息（仅认 `source.kind === 'user'`）。列表仅返回指针与截断开头，全文统一用 `read {seq}` 取回。
- **`read`（分页精读）**：支持 `read {seq}`、`read {blockId, offset}` 或直接传入上一页/搜索返回的 `cursor`。`maxTokens` 限制返回正文估算 token 数（不含 JSON 键名开销），超大附件元数据装不下时返回明确错误防死循环。
- **`search` & `blocks`（全文搜索与块索引）**：`search {query, scope: "all"|"surface"|"candidate", candidateId}` 使用原始正文 **UTF-16 偏移**计算 `start/end/cursor`，免疫 Unicode 大小写转换错位。`onSurface = false` 仅表示已被摘要遮蔽，原文依然可读。
- **维护期放行**：在自动整理锁死普通工具期间，`user_messages / read / search / blocks / evidence` 均同档放行。

---

## 5. 压力水位、自动整理状态机与测量三口径

### 5.1 压力阈值与边际刹车（分母 = 模型窗口）
比例直接作用于模型窗口，再与宿主可用容量（窗口扣除输出预留与安全余量）取较小值，确保小窗口（如 128K 窗口停止线为 `50% × 128K = 64K`）绝不溢出：

| 阶段 | 1M 窗口默认值 | 触发行为与约束 |
| :--- | ---: | :--- |
| **提醒** | `300K` (30%) | 状态栏提示准备整理。 |
| **安排整理** | `350K` (35%) | 空闲即开始；若有进行中任务（仅认宿主 Todo 镜像 `doing/in_progress`，不听口头宣称），给予最多 **3 步 / 2 分钟** 收尾缓冲（`deferred`，不许靠短暂降回 300K 以下反复刷缓冲）。 |
| **必须整理** | `400K` (40%) | 立即中断缓冲，暂停普通任务工具与自主续跑，强制进入维护。 |
| **停止续跑** | `500K` (50%) | 停止自动发起任务或整理；若未达物理极限，仍可在面板手动请求整理。 |
| **及格停止线** | **`≤ 200K`** (20%) | **唯一行动停止线（`targetHigh`）**：宿主完整请求读数压至 `≤ 200K` 即结束维护（`150K targetLow` 仅作参考，不驱动连续压缩）。 |
| **边际收益刹车** | `200K–260K` 带内 | 当已进入 `< 260K` 安全带，且剩余最佳候选预期收益比 `< 35%` 时，触发 `marginal-gain-low` 撤下推荐信号，避免为凑最后额度翻动高价值稳定前缀。 |

### 5.2 自动整理状态机手脚镣（`auto-tidy`）
- **硬性配额**：复用当前会话 Agent，每轮上限 **48 步 / 12 无进展步 / 3 次失败 / 8 次维护续步 / 10 分钟**。
- **权限沙箱**：仅允许上下文查询/压缩与必要只读工程查询；物理拦截写文件、Todo 完成、Shell 执行与子任务委派。
- **进展判据**：唯有**真实 `committed + confirmed` 回执 + 不同 `operationId` + 宿主复测 token 净下降**才算有效进展（口头宣称、重复回执、插件预估均不算）。整理消耗原运行预算，但不计入工程进展。遇到无安全候选、保护内容过多、连续无收益、回执不明、路由/预设切换或用户插话时立即安全停止并记录 `automatic.failureHistory`（最多保留 8 条，脱敏不存 Shell 参数）。

### 5.3 测量三口径（严格隔离，严禁混加）
1. **`hostMeasurement.measuredRequestReductionTokens`（唯一主指标）**：`beforeTokens - afterTokens`（兼容别名 `reclaimedTokens`），即同一路由下宿主完整请求前后实测净减少量（来自官方 `TokenMeter`，不等同于云端精确账单）。
2. **`gain.reclaimedTokens`（提交前预估）**：插件基于正文的启发式估算，仅用于提交前价值闸门评估（`ratio` 非质量分）。
3. **`receipt.shadowedTokenCount`（遮蔽合计）**：被替换可见节点的 `heuristicTokens` 之和（不扣减新摘要体积，不重复遍历祖先）。

---

## 6. 桌面面板与施工图联动

- **施工图 → 上下文**：实时查看压力水位、`budgetAnalysis`（保护正文/总候选/批次收益估算）、固定内容（写入兼容的 `todo/write` 附加字段，宿主 flush 后返 `confirmed`）及手动点击“请求整理”。查看原文零模型开销；点击“请求整理”将在下一个安全步骤使用当前会话模型预算执行。
- **施工图 → 文档 → 版本与回退**：Agent 可用 `forge_blueprint outline/read/revise/versions/restore` 精简文档（须保留工作包 ID 与验收文本）。旧正文独立保存在 Forge 数据库版本表中，支持比对与无损回退，外部哈希冲突时自动拒写保护。

---

## 7. 预设接入、开发验证与宿主重启须知

### 7.1 五大预设覆盖与故障排查
- `dsh-project-forge/context-presets.patch.yml` 已为内核 `0.2.1-rc.2` 的 Standard、PTC、Minimal、Cordis 及 Forge 五大预设完成装配，旁路了旧版 Basic 自动压缩、工具结果盲裁及 `token-optimizer 2.2.2` 的竞争性改写。
- 若遇“没有装配受保护的压缩服务”，请检查 `forge_context status` 中的 `engine.preset` 与 `engine.configured`（以当前实际挂载为准）。第三方优化器升级若覆盖补丁，`verify-deployment.cjs` 会立即报警。

### 7.2 本地验证与发布门禁（零付费模型调用）
```powershell
npm run typecheck
npm run build
node --test tests/*.test.cjs
node scripts/test.cjs
node scripts/verify-deployment.cjs
```
🚨 **发布门禁硬约束**：发布前必须使用 Electron Node 真跑 `scripts/test.cjs`——把 `DSH_KERNEL_ROOT` 指向你的 DSH 安装目录下的 `resources/app.asar`，并显式设置 `DSH_TEST_NODE` 指向 Electron 可执行文件（另支持 `DSH_PROFILE_DIR` 覆盖）。在纯 Node 环境下 reliability 用例会诚实 skip，`1 pass / 1 skipped` 仅用于日常环境兼容，绝不视作发布门禁通过。旧 `probe-cc*` 脚本仅留作考古，不作验收入口。
