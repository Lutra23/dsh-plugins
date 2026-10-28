# dsh-memo-recall 0.4.2

DSH 被动记忆召回插件。通过 VCP LightMemo 检索本地记忆，在当前用户消息／活跃 Todo 边界内固定一份召回块，无需 AI 主动调用 lightmemo。

## 正文格式兼容（0.3.2）

LightMemo 命中块内的日记、Markdown 和普通文本都可作为正文，不再要求以 `[HH:MM]` 开头。时间戳出现在中途也不会丢弃前文；Markdown 空行、缩进及闭合围栏代码在解析结果中保留，最终注入仍按既有规则合并空白并受 `maxHitChars`／`maxChars` 限制。

只移除块首路径、RiverMemo／TagMemo 排名元信息和可选日期头，以及块尾不在代码中的 `Tag:` 标签行。正文中途的同名字段与围栏代码内的协议示例保留。没有分数的 `N/A` 命中也单独分块，按 0 分参与原阈值过滤。

正文为空的命中在 topN 截断前排除，渲染层也会跳过；全空时不注入仅有标题／分数的召回块。这属于空结果，不计作网络失败或触发失败冷却。开启既有 `debug`／`debugLog` 后，每次实际解析输出 `parse-result`，只记录 `parsedHits`、`emptyBodyHits`、`selectedHits` 计数，不记录原文、路径或查询。

兼容的是**命中块内的正文格式**，仍依赖 LightMemo 的来源／相关性等外层协议来区分结果，不会把裸错误响应当成记忆。尾部纯 `Tag:` 行与标签元信息、未转义的外层协议与正文可能有歧义；协议示例宜使用闭合代码围栏。已有同边界缓存照常复用，新用户消息或新任务激活后才重新解析本次检索结果。

## 留存规则

| 事件 | 行为 |
|---|---|
| 开始处理新用户消息 | 新边界；按消息 ID 区分，同文本的新消息也重新召回 |
| 同一消息后续工具步骤 | 复用召回结果、消息位置和文本，不按时间刷新 |
| todo/write 成功写入后活跃项改变 | 新边界，替换上一边界的记忆 |
| 更新其它待办，活跃项不变 | 不刷新，也不抢回较新的用户消息边界 |
| Todo A → B → A | 三个边界，最后的 A 重新检索 |
| 全部完成／清空列表 | 清除召回块，不回退到更早的用户消息 |
| 图片消息／空文本消息 | 新边界，暂不做文本召回，清除旧记忆 |
| 仅提出工具调用／失败／拒绝 | 不视为 Todo 已切换 |
| 官方 turn/start 重置 Todo | 同步重置活跃 Todo；无新用户输入时不复活旧查询 |

未绑定工程时活跃项仅取 in_progress；只有 pending 的清单保持用户消息记忆。绑定工程后以已提交的 forge/task-boundary（projectId/taskId/activationId/revision）为准；Todo 镜像、进度及 forge-flowlock 心跳不触发换记忆。新用户插话优先，显式 resume 才重回任务记忆。比较完整内容及可选 ID，再截断发送给检索器的查询。官方无 ID 的同名条目无法凭标题区分，应写成有区别的任务描述。

## 注入与替换

挂接 agent/pre-step，从本步已认领的原始用户消息确定边界，因此第一条消息的第一步就能正确召回。session/event 只跟踪已提交事实，不在观察回调里追加事件。

召回文本作为专属 user/message 写入，source.kind = memo-recall，独立于其它插件的动态上下文。边界内不重复追加；时钟等其它 context 更新不会顺带复制这块记忆。

切换边界使用官方 Session surface 逐节点 replace：旧专属块替换为非空的插件专属 user/message，source.kind = memo-recall-retired，文本为“此处的旧记忆快照已失效。”；新块在本步输入后追加。这与 pre-step 尚未进入 step/start 的官方会话格式兼容。只处理插件拥有的块。旧版混合 runtime-context 中，只移除名为 memo-recall 的 section，其余 section 保留。

**移除指退出后续模型输入，不是从磁盘删除历史。** 原始召回、用户消息和工具轨迹保留在追加式审计日志。已被压缩进其它插件摘要或被助手引用的文字不做猜测性删除。

## 缓存的实际边界

同一边界固定本地检索结果，包括无命中和失败结果；不再因为 TTL 到期或其它会话过多而淘汰活跃块。使用 WeakMap 跟随 Session 对象生命周期回收。

首次调用最多等 timeoutMs。超时后本步可不带记忆继续；同边界迟到结果可在下一步首次加入，此后固定。边界已改变或处理已取消的迟到结果丢弃。连续失败触发全局冷却，但不清空其它会话固定的成功结果；冷却中跳过的边界保持空结果，下一边界才再尝试。

恢复会话时，若仍保留当前边界的专属块，直接复用。活进程内压缩移除块后可用内存固定结果补回；重启且无块可恢复时重新检索一次。旧版混合快照无法确认边界身份，迁移时清理旧贡献并重新召回。

日志 boundary-hit 只表示**本地召回复用**，不是供应商 KV 缓存命中。边界内稳定记忆有利于维持公共前缀；边界替换会改变旧块所在位置之后的前缀。其它系统提示词、工具声明、压缩和供应商缓存策略也影响命中率；不保证全命中或固定节省比例。

## 联想分段与元思考透镜

两类额外线索各有独立来源与呈现位，都不与直接命中抢席。

**联想共现（LightMemoAssoc）**：命中块首行的 `[🌟 联想共现: N/M 个种子共同命中]` 在解析层被剥离为结构化来源而不是正文——只认「联想共现: N/M」字样，不绑定 emoji，上游换装饰不会丢来源；正文中途出现的同名文字仍按原文保留。选席时两拨分池：联想最多占 `round(topN × associateRatio)` 席，主检索条数不足 topN 时联想才补位，联想池内按共现次数降序、同次数按相关性降序。渲染时联想独立成段（`【联想共现记忆 (N条, 多条记忆交叉关联)】`），meta 行带 `联想N/M`，段落被 `maxChars` 截断也能看出该条来自联想及其关联强度。

**元思考透镜（直觉卡）**：标题含「直觉卡」即透镜身份，识别只看标题、来源库不限。透镜按相关性取前 `lensMax` 枚**追加在 topN 之外**，不占席位——它管「怎么想」，与管「想什么」的事实记忆抢位置是语义错位；同时带联想标记与透镜身份的命中归透镜区，不吃联想配额。渲染时独立成段（`【元思考直觉 (N枚, 注意力扳手而非事实)】`）并带引导语，且**豁免主段的总截断**：`maxChars` 先切主段，透镜段整段拼在后，避免注意力扳手被事实记忆挤掉；透镜段自身仍以 `maxChars` 封顶，不会无限膨胀。

没有联想也没有透镜时，选席与渲染与旧版逐字节一致。分区呈现对齐 VCP 侧 `RAGResultFormatter` 的既有语义（主检索区 + 联想段），这两条只改变线索的来路与排放位置，不动检索范围、阈值与边界语义；`associateRatio`／`lensMax` 是 profile 层可调的饥饿度旋钮。

## Rerank+（通道 A 可选同步精排，0.4.1）

`rerank` 是 VCP 占位符 `[[X日记本::Rerank]]` / `[[X日记本::Rerank+]]` 的 API 等价配置：VCP 1.6.0 的 LightMemo 用 `_parseRerankOptions` 吃掉同一个键，`rrf` 走 RRF 融合（α=0.5），`rrf0.7` 把 Reranker 排名权重提到 0.7，`true` 是纯精排、不做融合。关闭时 `buildRecallArgs` 根本不写 `rerank` 键，请求体与 0.4.0 逐字节一致；无法识别的值同样按关闭处理，错配置不会变成付费调用。

实测代价（2026-10-22，VCP 1.6.0 + LightMemoAssoc，k=10，associate_depth=5，范围 `Kerr的知识|DSH工程档案|溟月的知识`）：纯检索 6.3s／26 条（主检索 10 + 联想 16）；`rerank=rrf` 14.7s／28 条；`rerank=rrf0.7` 14.1s／28 条。精排把首屏相关性从 60~68%（混合）拉到 81~99.8%（Rerank），代价是**每个用户消息多等约 8 秒**。所以：

- 启用时边界等待改用 `rerankTimeoutMs`（默认 20000），`timeoutMs` 仍只服务纯检索——否则 5s 预算下每个边界都会 `timeout-skip`，等于「开了但永远不注入」。
- 脉冲通道（B）显式关闭 rerank：它是异步两拍、`pulseTimeoutMs=5000`，精排会把每条透镜都拖成超时。
- 要不要开是质量/时延的取舍，不是缺省正确项；profile 里改一行即可，改完必须重启 App（宿主插件组装期 import 一次）。

### 0.4.2：两把尺（真机踩到的坑）

开 Rerank+ 之后，**同一个返回列表里混着两种分**：直锚是 `Rerank` 分（实测 0–49%），联想是 `混合` 分（80–96%）。0.4.1 拿单一 `minScore=58` 去过滤，结果**直锚整段被筛空、只剩联想**——真机边界 `parsedHits 13 / selectedHits 3 / 1420 字符`，而同一会话开 rerank 前是 `parsedHits 13 / 9 席 / 4434 字符`。表面看是"开了精排反而变差"，根子是量纲混用。

0.4.2 的处置：

- 解析层保留 `scoreType`（混合 / Rerank / 拓扑…）；
- Rerank 命中用 `rerankMinScore`（默认 0＝不按绝对分截断），混合命中仍用 `minScore=58`；
- rerank 开启时 `preserveOrder`：主检索保留 VCP 侧的 RRF 名次，不再按分数重排（重排等于把融合结果抹掉）；
- 头部口径改为「Rerank+ 融合名次取席；联想/透镜另按相关度≥58% 过滤」，不再谎称单一阈值。

觉得名次带进来的噪声多，就把 `rerankMinScore` 收紧到 10–25；想回到"单一分数排序"的口径，把 `rerank` 设成 `true`（纯精排、无 RRF）。退役触发：VCP 侧若改为在格式化层直接输出单调的融合分（0–100），这套双量纲分支即可删除。

## 与 VCP 1.6.0 的兼容（2026-10-22）

VCP 2026-10-22 更新把 SQLite 所有权交给 `NativeKnowledgeRuntime`（Rust），`KnowledgeBaseManager` 的 `db` 属性消失（服务日志：`[KnowledgeBaseProbe] Central SQLite ownership is delegated to NativeKnowledgeRuntime`）。原版 LightMemo 1.6.0 已重写为原生检索、不受影响；本插件依赖的 `LightMemoAssoc` 分支仍在 JS 侧枚举 chunk，于是在 08:48 更新后所有召回返回空（debug 日志 `fetched chars:0`，服务日志 `Database not initialized in KnowledgeBaseManager`）。

修法是在 `LightMemoAssoc` 里补一条只读 SQLite 桥（`_readonlyDb()`，`better-sqlite3` readonly + WAL 快照读）：写所有权仍归 Rust，JS 只读 `chunks`/`files` 做候选枚举与共现种子取样。修后实测 search 5.3s／associate_search 3.9s 恢复（联想共现照旧）。退役触发：上游原生 ABI 暴露批量 chunk 向量读取后改调原生接口。

## 脉冲透镜（通道 B，0.4.0）

通道 A（边界召回）按「用户消息／Todo 边界」换挡，是**海图**；通道 B 按「撞墙的那一拍」闪现，是**扳手**。两者各自计数、各自换挡，互不干扰。

**物理时机**：挂同一个 agent/pre-step，只看最近一对已完结的工具步（tool/call ↔ tool/result 按 callId 配对，读会话日志尾窗——宿主把 tool/call 作为纯日志事件追加、不入 surface，按 surface 取窗口永远配不上对）。**查询全异步、下一拍取用**：本拍只把查询发出去就返回，结果落定后留在 per-session 槽位，由下一拍 pre-step 取用注入。这样关键路径零额外时延（实测发射拍 4ms），代价是透镜晚约一拍到达。每会话至多一处在途，防子进程堆积。

**三道门**（全部通过才发查询、才注入）：

1. **步类型分类**：纯读步（ReadCode/Outline/FindSymbol 等）免查——读步不产生无声错误，也不撞红灯。
2. **语义共振**：把「工具名 + 命中的字面坏味道标签 + 参数摘要」拼成 ≤200 字符查询撞透镜库，按模式取阈值——坏味道 75%、报错 65%、姿态 70%、胶水意图 60%。分数不过线不注入。
3. **四重节流**：基础配额 3 枚／边界（报错破格 +1，每边界一次）；两次注入之间至少隔 `pulseStepGap` 个合格步；时间地板 `pulseFloorMs`；同一张卡每 Todo 只给一次、全会话最多 `pulseMaxCardPerSession` 次。

**取用窗口与死线**：`pulsePendingTtlMs` 只管**语义陈旧**（边界已换、防悬挂），不管物理等待——相邻两拍的真实间隔是「模型思考 + 命令执行」，实测 24–30s，取用频率由 `pulseStepGap` / `pulseFloorMs` 控制。边界变了或超死线的在途结果直接丢弃（相位 `pulse-dropped` / `pulse-expired`）。

**注入与隔离**：作为独立 `source.kind = memo-recall-pulse` 的新消息追加在消息末尾，**永不 replace、永不回收**——与通道 A 的可变槽位物理隔离，边界替换与旧块清理都扫不到它。文本自带防压缩引导语「【直觉闪现·非事实·勿引用·勿保留】」，避免被摘要器收编成事实或约束。整条通道用 `pulseEnabled: false` 关闭（唯一回退开关）。

**阶段闸门（0.4.11，默认关）**：通道 B 之上的写步预算治理（HarnessPro 三段闸门移植）。开启后按边界内**合格写步数**分档注入本地合成的「收敛令」（`source.form = stage-gate`，与透镜类型隔离；不查 LightMemo、不吃透镜配额）：越过 `pulseStageEconomyAt`（默认 14）单次止损提醒；越过 `pulseStageStrictAt`（26）进场一次 + 每 `pulseStageEveryN`（8）步重申「停止探索、专注验证」；越过 `pulseStageFinalizeAt`（44）升级为「基于现有证据交卷」。收敛令与已落定透镜撞拍时让位顺延一拍（不浪费查询成果）；收敛令拍不再发新查询。相位 `stage-gate`（stage / kind / steps / remindNo）。

**PSJD 两级熔断（0.4.12，默认 off）**：`psjdShadow` 的确定性规则（surpriseFlag + stallScore）从纯观测升级为执行臂（`psjdEnforce`，生效前提 `psjdShadow: true`）。**L1 行为引导卡**（`psjd-l1`）：shouldFire 时按 mode 当拍注入本地合成卡（意外红灯＝证据链核对令 / 意外绿灯＝复跑验证令 / 停滞＝换方向令），每边界 `psjdL1PerBoundary` 枚、同 mode 只发一次。**L2 强制熔断卡**（`psjd-l2`）：**独立停机判据**——`stall ≥ psjdHaltStall`（0.85）或同签名报错连续 `psjdHaltAfter`（4）拍即停机，不等综合分过观察阈值（HarnessPro「连续 deny 即 halt」同语义）；每边界一次，发出后本边界 psjd 干预全静默。**逃生闭环**：熔断不锁透镜与收敛令通道，边界切换自然复位——停滞观测状态（errStreak/files）跨边界连续，干预配额随边界刷新。异常拍优先级最高（先于收敛令与透镜，接受丢弃在途卡）。相位 `psjd-l1` / `psjd-l2` / `psjd-shadow`（含 `enforceSuppressed` 区分「没触发」与「触发但被静默」）。

开启 debug 后可观察相位链（每行均带 `ts` / `sessionId`，ΔW 统计按 `sessionId + ts` 与会话日志 join，以干预事件为分组锚取前后窗口对比）：

| 通道 | 相位 | 关键字段 |
|---|---|---|
| A 边界召回 | `fetched` / `injected` | key / chars |
| | `boundary-hit` / `cache-hit` | key / kind / seq |
| | `cooldown` / `timeout-skip` / `fetch-error` / `stale-discard` | key |
| B 透镜 | `pulse-issued` | mode / key / query（≤600 字，准确率与一致率分母） |
| | `pulse-ready` | mode / score / card |
| | `pulse-carried` / `pulse-carried-across` | mode / score / card / chars（+fromKey） |
| | `pulse-miss` / `pulse-card-throttled` / `pulse-throttled` / `pulse-timeout` / `pulse-fetch-error` / `pulse-dropped` / `pulse-expired` | mode / key / governor snapshot |
| 干预·阶段闸门 | `stage-gate` | stage / kind（enter/remind）/ steps / remindNo / chars / key |
| 干预·两级熔断 | `psjd-l1` / `psjd-l2` | mode / flagReason（certain_but_failed 等）/ stall / errStreak / fileRepeat / chars / key |
| 观测 | `psjd-shadow` | 全 verdict + legacyMode / diverge / enforceSuppressed（区分「没触发」与「触发但被静默」） |
| | `flow-entropy-shadow` | regime / omega / selfLoop / revisit / steps |

## WP1 工具输出折叠评估结论（0.4.12 批次 · 不移植）

HarnessPro `_compact_text`（连续重复行折叠为 `[previous line repeated N more times]`）在本机**负收益，不移植**。实测（`test/wp1-audit.cjs`，可复跑：`node test/wp1-audit.cjs <sessions根> <会话数>`）：最近 20 个会话 6,162 个 tool/result、15.9M chars，按连续重复行折叠语义统计总收益 **-0.1%**（折叠提示语比省下的行还长）——工具返回大头（ops_bash 6.1M / ops_inspect 3.3M / forge_context 2.2M / project_forge 1.9M）均为结构化输出，无一命中 HarnessPro 编译日志 dump 的连续重复行场景；且 max=49,933 齐卡宿主 50K 截断线，体量已由宿主 spill 机制治理。零收益优化不做。顺带发现的真实候选（另行评估）：`forge_context` candidates 与 `ops_grep` 大结果输出瘦身（TOP 大头均卡 50K 截断线）。

## 配置

继续使用现有 profile 中的 memo-recall 条目，不新增工具、侧栏或桌面图标。

| 配置 | 默认值 | 说明 |
|---|---|---|
| enabled | true | 关闭时，下次进入步骤清除插件专属块 |
| folders | Kerr的知识\|DSH工程档案 | 检索范围 |
| k / topN | 5 / 3 | 拉取条数／最多注入条数 |
| minScore | 58 | 相关性百分比门槛 |
| pluginName / associate / associateDepth | LightMemo / false / 空 | 桥目标插件；后两项走 LightMemoAssoc 时开启共现联想与其二次检索深度 |
| associateRatio | 0.4 | 联想最多占 topN 席位的比例（0~1），主检索不足时联想才补位 |
| rerank | 空（关闭） | 通道 A 的同步精排：`rrf`＝`::Rerank+`（RRF，α=0.5）、`rrf0.7`／0~1 数字＝自定义 α、`true`＝纯精排；空／false／off＝不下发 |
| rerankTimeoutMs | 20000 | 启用 rerank 时的边界等待预算；沿用 timeoutMs=5000 会让每个边界 timeout-skip |
| rerankMinScore | 0 | 只作用于 Rerank 命中的绝对下限；0=不按分数截断，按 RRF 名次取席（Rerank 分与混合分不同量纲） |
| lensMax | 2 | 元思考透镜（直觉卡）追加上限；不占 topN 席位，渲染豁免主段总截断 |
| maxChars / maxHitChars | 1600 / 420 | 总字符／单条正文上限 |
| queryMaxChars | 200 | 查询截断，不参与边界身份比较 |
| timeoutMs | 5000 | 首次召回等待预算 |
| cooldownMs / maxFailures | 300000 / 3 | 连续失败冷却 |
| vcpHost / vcpPort | 127.0.0.1 / 6005 | VCP admin_api 地址 |
| vcpHome | 空 | VCPToolBox 目录，用于 config.env 和桥进程 cwd |
| adminUser / adminPass | 空 | 显式凭证；也支持 VCP_ADMIN_USER / VCP_ADMIN_PASSWORD 或 config.env |
| debug / debugLog | false / 空 | JSONL 决策日志 |
| pulseEnabled | true | 通道 B 总开关（唯一回退开关；关闭则零查询零注入，通道 A 照旧） |
| pulseFolders / pulseK | 空 / 5 | 脉冲查询范围与候选条数；范围留空沿用 folders，只查透镜库时填 `溟月的知识` |
| pulseThreshold | 75 | 坏味道（代码字面锚）命中阈值 % |
| pulseErrorThreshold | 65 | 报错步降阈值强制救援（免步冷却，不免时间地板） |
| pulseIntentThreshold | 60 | 自述胶水词（T2 意图通道） |
| pulsePostureThreshold | 70 | 动作姿态（T1 轨迹通道） |
| pulseStepGap / pulseFloorMs | 3 / 5000 | 两次注入之间至少隔几个合格步／最小墙钟间隔 |
| pulseBudgetPerTodo / pulseErrorBonus | 3 / 1 | 每边界基础配额／报错破格额外枚数 |
| pulseMaxCardPerSession | 2 | 同一张卡全会话最多出现几次 |
| pulseTimeoutMs | 5000 | 脉冲查询竞速预算：异步发射不占关键路径，实测 VCP 侧地板≈2s，留足余量 |
| pulsePendingTtlMs | 120000 | 在途结果死线（防悬挂兜底）：只管语义陈旧，不管物理等待——实测单工具步墙钟可达 30s |
| pulseMaxChars | 200 | 单枚脉冲字符上限（≈160 tokens 口径，含防压缩引导语）；0.4.13 起剥 [时间][分类] 检索元数据头、截断回退到句边界不斩半句 |
| pulseReadTools | 空 | 追加的只读工具名（逗号/空格分隔），免受脉冲查询 |
| pulseStageEnabled | false | 阶段闸门（0.4.11，HarnessPro 三段闸门移植）：边界内写步分档治理，本地合成收敛令；不查库、不吃透镜配额 |
| pulseStageEconomyAt / pulseStageStrictAt / pulseStageFinalizeAt | 14 / 26 / 44 | 经济线／收敛线／交卷线（写步）：economy 进场单次止损；strict/finalize 进场一次 + 每 everyN 步重申 |
| pulseStageEveryN / pulseStageMaxChars | 8 / 120 | strict/finalize 重申周期（写步）／收敛令字符上限（下界 60，防截断成废话） |
| psjdShadow / psjdStallThreshold | false / 0.66 | PSJD-C 确定性规则（surpriseFlag + stallScore）：开=true 写 psjd-shadow 观测日志；stall 观察阈值 |
| psjdEnforce | off | 两级熔断转正（0.4.12）：'l1'＝L1 行为引导卡；'l2'＝L1+强制熔断卡；生效前提 psjdShadow:true |
| psjdHaltStall / psjdHaltAfter | 0.85 / 4 | L2 停机线双判据（任一命中即停机，独立于观察阈值）：stall 越过线／同签名报错连续 N 拍 |
| psjdL1PerBoundary | 2 | L1 每边界配额（同 mode 只发一次；意外红灯/绿灯/停滞各计一次） |
| ttlMs / maxSessions / todoTools | 兼容旧配置 | 已停用：不按 TTL/LRU 刷新；Todo 以成功的 todo/write 为准 |

保留原桥协议：/admin_api/plugins/LightMemo/execute，RiverMemo、BM25、指定知识库。凭证、检索范围和现有 profile 配置本次未改动。

## 验证与加载

适配并验证的官方内核为 0.2.0-rc.2。

```powershell
npm test                                    # selftest 16 项 + node --test 116 项
$env:ELECTRON_RUN_AS_NODE='1'               # 官方内核链（用安装版 Electron 当 node）
# Windows: 先设 DSH_KERNEL_ROOT=<DSH 安装目录>/resources/app.asar
& "<DSH 安装目录>/DSH NEXT.exe" --expose-internals test/session-format.cjs
& "<DSH 安装目录>/DSH NEXT.exe" --expose-internals test/desktop-runtime.cjs
```

`npm test` 一档到底：16 项自检（解析／渲染／桥协议／凭证／版本同源）＋ 16 项正文格式回归 ＋ 31 项边界与模型可见消息 ＋ 23 项联想分段与元思考透镜 ＋ 30 项脉冲纯函数 ＋ 16 项脉冲通道接线（node --test 合计 116）。其中脉冲通道用例覆盖两拍时序（发射拍零注入、下一拍取用）、**关键路径零额外时延**（查询永不结算也必须当拍返回）、每会话至多一处在途、边界变更作废在途结果、**真实节拍回归**（落定后隔一个完整工具步 30s 仍须取用）。

test/desktop-runtime.cjs 用真实 desktop profile 模块加载器、已安装 preStep 方法、RuntimeContextProjection 和 Session 检查组合行为，包含无时间戳 Markdown 注入、空正文清除，以及**通道 B 两拍注入与 append-only 前缀完整**（13 项）。test/session-format.cjs 验证官方 v4 会话格式物理往返、pre-step 替换和历史留存（7 项）。两项均以已安装 Electron 加 --expose-internals 通过。所有测试均未调用真实模型或 LightMemo（modelRequests 0 / lightMemoRequests 0）。

**0.4.0 实机证据**（真 VCP 6005 + 真透镜库，非替身）：发射拍 4ms（改造前该拍要等满超时预算）；真查询 2193–2632ms 落定；取用发生在下一拍，落定→取用间隔 24–30s（真实工具步墙钟）。生产 debugLog 相位链实测：`pulse-issued/mode=smell` → `pulse-ready score=85.3 card=直觉卡·报错行是案发现场不是凶手` → `pulse-carried`（注入 100 字符），无 `pulse-expired`。

插件由桌面 profile 的 junction 链接到本目录。更新源码后，**重启 DSH 应用／宿主才加载新版**；单纯刷新页面不足以加载宿主模块。开启 debug 时，加载后出现 plugin-loaded，版本为 0.4.2（该行引用 `lib/index.js` 的 `VERSION` 常量，与 package.json 同源，selftest 有断言；0.4.1 起该行另带 `rerank` 与 `timeoutMs`，可直接核对精排是否真的生效）。之后自然使用时观察 parse-result → fetched → injected → boundary-hit；通道 B 另见 pulse-issued → pulse-ready → pulse-carried。不必额外发付费测试消息。

**回滚**：0.4.0 的回退锚是 `dist\dsh-external-dsh-memo-recall-0.3.3.tgz`（59,230 B 的 0.4.0 包旁留档，哈希见同目录 `SHA256SUMS.txt`）——退出 DSH 后用其内容覆盖本目录对应文件并重启即可。更早的 0.3.2 修改前备份仍在 `~/.dsh/backups/memo-parser-20261008-012432`（历史部署机）。profile、官方内核、VCP 连接和任务边界实现本次未修改，无需恢复其它插件配置。
