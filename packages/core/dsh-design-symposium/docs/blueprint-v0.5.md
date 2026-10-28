# dsh-design-symposium v0.5 施工图

> 基线：工作树当前状态（0.4.0，未提交改动 34 文件），`tsc` 0 错、`npm run verify` 30/30（实为 29 项，见 P0-3）。
> 工程账本：project_forge `psryc`（工作区 `MingYue`，路径相对仓库根）。写操作带 `todo` 序号与 `reason`。
> 本文是施工唯一依据；与代码冲突时以**现场代码**为准并在交付说明里点名差异。

## 0. 为什么改

插件在主人流程里的位置是：**主模型做完设计 → 收集意见 → 启动三贤者评审 → 与主人对齐 → 写施工图**。
因此研讨会是「草案评审器」，不是从零设计器。0.4 的三个结构性缺口：

1. **输入无契约**：贤者只看得到主模型压缩后的议题包，漏写的承重信息（已锁定项、不变量、已否方案）直接决定评审上限。
2. **事实无通路**：贤者遇到事实疑问只能猜；主模型手里有工具却插不进研讨中途。
3. **结论无回路**：反对意见施工后有没有应验，没人记，贤者设定永远无法校准。

## 1. 施工总则（硬约束）

- 只改 `workshop/dsh-design-symposium/`。不 push、不 commit（主人另行决定）。
- 每个工作包结束必须：`npm run typecheck` 0 错 → `npm run verify` 全绿（项数只增不减）→ `npm run build` 产出 `lib/index.js`。
- `lib/` 是装机物：desktop profile 经 `link:` 直接指向本目录，改完 build 后**需重启 DSH App** 才生效；施工方不要重启 App，交付时注明即可。
- 不手改 `~/.dsh/symposium.json`；结构变更走 `normalizeConfig`（`src/config.ts:293`）迁移，旧文档必须能读。
- 新持久化文件一律落 `$DSH_HOME/symposium/` 下（`resolveDshHome()`，`src/config.ts:123`），测试时由 verify 设的临时 `DSH_HOME` 隔离。
- 模型调用一律走现有 `callModel`（`src/providers.ts:260`）；成本归因机制（`readCostSnapshot` / `waitForModelCost`，`src/cost.ts`）不改语义。
- 测试全部离线（mock LLM，`test/verify-entry.ts` 的 `makeMockLlm`），新增检查追加到 `runAllChecks` / `runCrashPathChecks`。

## 2. 工作包

### P0 止血（todo #2）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 1 | CI 检查已删产物，必红 | `.github/workflows/ci.yml:37-58` | 删 `lib/client.js`、`__ModuleLoader__`、`REMOTE_METHODS\|typertRemote` 断言与 pack 里的 client 检查；step 名去掉 "+ docx" |
| 2 | 测试设错环境变量，每次发言白等 6s | `scripts/verify.mjs:64` 设 `ROUNDTABLE_LEDGER_SETTLE_MS`，`src/cost.ts:30` 读 `SYMPOSIUM_LEDGER_SETTLE_MS` | 改成 `SYMPOSIUM_LEDGER_SETTLE_MS` |
| 3 | 装配检查重复执行 | `scripts/verify.mjs:68-69` | 删一行 |
| 4 | 根目录 0 字节垃圾文件 `=20` | 仓库根 | 删除 |
| 5 | 残留辩论/设置页文案 | `src/index.ts:2,62`（文件头、合规声明「只做多模型观点辩论」）、`src/index.ts` 「三个工具」注释与 log（实为 4 个）、`src/symposium.ts:619-621` 压缩器提示词「辩论记录压缩器」、`src/service.ts:1-15`、`src/tools.ts:1-8,38`（「设置页」「性价比不排名」）、`scripts/build.mjs:1-30`（Remote/双产物注释与悬空 `/**`）、`cordis.patch.yml:11-14` | 改为研讨会语义；压缩器提示词改「设计研讨记录压缩器」，并要求保留「各贤者对各决策点的最新裁决与未答求证」 |
| 6 | `.gitignore` 仍是 roundtable 名 | `.gitignore` | `roundtable-*` → `symposium-*-纪要.md`，`roundtable.json` → `symposium.json` |
| 7 | 蓝图同义反复 | `docs/refactor-blueprint.md:82-85` | 恢复为 `roundtable → symposium` 的真实映射 |
| 8 | 成本账本缺失 | `~/.dsh/storages/cost-meter/` 不存在 | **只诊断不修**：查 desktop profile（`~/.dsh/profiles/desktop/package.json`、`cordis.patch.yml`）是否装了 `dsh-cost-meter`；结论写进交付说明。代码侧要求：账本缺失时报告与工具摘要仍展示**每席 token 用量**（`speech.usage`），不能只写「口径不可用」 |

验收：CI yaml 本地 `grep` 不再出现 `client.js|typertRemote`；verify 项数 = 原 29 + P0 新增；verify 总耗时显著下降（交付说明给出前后秒数）。

### P1 议题包契约 + 档位 + 自由 Markdown 纪要（todo #3）

#### P1.1 Brief v2（`src/config.ts:73`）

```ts
interface DecisionPoint { id: string; title: string; options?: string[]; lean?: string } // id 形如 D1
interface Assumption { text: string; verified: boolean }
interface Brief {
  topic: string;
  background?: string;
  materials?: string[];
  proposal?: string;            // 主模型草案正文
  decisionPoints?: DecisionPoint[];
  locked?: string[];            // 已拍板，禁止翻案
  invariants?: string[];
  assumptions?: Assumption[];
  rejected?: { proposal: string; reason: string }[];
}
```

校验函数 `validateBrief(brief, tier): string[]`（返回缺陷列表，空 = 通过），在 `startRun`（`src/service.ts:238`）入口调用，有缺陷即抛错并列出全部缺项：

- 所有档：`topic` 非空；`decisionPoints` ≥1，id 唯一且匹配 `^D\d+$`。
- `standard` / `deep`：`proposal`、`locked`、`invariants`、`assumptions`、`rejected` 必须**显式出现**（空数组合法，含义是「声明此类为空」；字段缺失不合法）。
- 旧调用（只给 topic）：报错文案要告诉调用方缺哪些字段、各自含义。

#### P1.2 上下文布局（`buildContext`，`src/symposium.ts:522`）

为前缀缓存重排，**稳定内容在前、逐轮变化在后**：

1. 身份（名字/立场/职责）
2. 议题包：议题 → 草案 → 决策点 → 已锁定（标注「禁止翻案，翻案发言视为无效」）→ 不变量 → 假设（已核实/推测分开）→ 已否方案 → 背景 → 工程材料
3. 发言规则（含协议，见 P1.3）
4. ——以下为变化部分——当前轮次、已核实事实（P2）、前情摘要、发言记录、「现在轮到你」

视野（P4 才实现，P1 先留字段）：`SageConfig.view?: 'full' | 'problem-only'`，`problem-only` 时第 2 段只给议题、决策点与不变量，不给草案与 lean。

#### P1.3 发言协议（只留求证）

> 2026-10-28 修订：原协议要求每人每 D 一行【裁决】并维护引擎矩阵，已整体退役。理由：主席纪要的下游读者是主模型与主人，不是正则；「DSL→解析→再拼回 Markdown」只产生故障点（漏一个竖线丢一整点），而扁平三选一槽位会把分条多维评审判成「漏裁」（plan 场四席全部被判漏裁、矩阵全空）。

规则文本只要求一类标记：

```
【求证】需要核实的事实问题（可选，每人每轮 ≤2 条）
```

- 解析：`/【求证】\s*(.+)/g`，截断 200 字，去重。
- `Speech` 只保留 `questions: string[]`；`rulings` / `stanceLine` 已删除。
- 【裁决】【立场】两类标记不再要求、不再解析；贤者发言里的这类字样原样留在正文里。

`RunState` **没有** `matrix` 字段。不做「相邻两轮裁决一致」的收敛判定：矩阵没了就没有可信的收敛证据，用一个坏判据停止只会让结论看起来比实际更收敛。**固定跑满 `maxRounds` 轮**，`stopReason` 只会是 `max-rounds`、`budget-exhausted`、`user-stop`、`fatal-error`、`sensitive-threshold`、`awaiting-verification` 之一。

#### P1.4 档位与预算

`SymposiumConfig` 新增 `defaultTier` 与 `tiers`（`normalizeConfig` 补默认，用户可覆盖单项）：

| 档 | seats（sage id） | rounds | maxTokensPerTurn | chair | maxQuestions/场 | maxTokens（整场硬顶） | Brief 要求 |
|---|---|---|---|---|---|---|---|
| `quick` | `adversary, pragma` | 1 | 600 | `newapi/AIclaudecode/gemini-3.8-flash` | 0（不暂停，求证进纪要） | 30_000 | lite |
| `standard`（默认） | `pragma, purist, adversary` | 2 | 1024 | 用 `config.chair` | 3 | 100_000 | full |
| `deep` | 全部 | ≤4（固定跑满） | 1400 | 用 `config.chair` | 8 | 400_000 | full |

- seats 里不存在或未绑定模型的 id：跳过并记 anomaly（沿用 `discuss` 现有未绑定逻辑，`src/symposium.ts:330-341`）。
- `symposium_start` 新参数：`tier`、以及覆盖项 `rounds`、`maxTokens`。
- 预算判定：每轮开始前，用 `已用 token（∑speech.usage 输入+输出，缺失时用 estimate）+ 本轮预估（席位数 × (当前上下文估算 + maxTokensPerTurn)）+ 主席预估（transcript 估算 + 3000）` 与 `maxTokens` 比较；超出则不开本轮，`stopReason = 'budget-exhausted'`，**仍运行主席**（与 user-stop 跳过主席不同）。
- `StopReason`（`src/symposium.ts:90`）新增 `'converged' | 'budget-exhausted' | 'awaiting-verification'`（最后一个是暂态，见 P2），`describeStopReason`（`src/report.ts:79`）同步。
- 档位 chair 覆盖不得改写 `config.chair`，只作用于本场。

#### P1.5 主席纪要（`src/chair.ts`）

> 2026-10-28 修订：主席输出的标记行 DSL + `perDecision/needsOwner` JSON schema 已整体退役。

主席输入：议题包（topic/background/decisionPoints）+ 贤者名单与立场 + 完整 transcript（尾部优先，沿用 `CHAIR_TRANSCRIPT_MAX_CHARS`）。**不再输入矩阵、不再输入立场日志**。

输出：**自由 Markdown 正文**，原样保存。

```ts
interface ChairOutcome {
  chaired: boolean;          // raw 非空即为 true
  note?: string;             // 未产出时的原因
  provider: string; model: string; at: number;
  raw: string;               // 主席原文，逐字保留
  openQuestions: string[];   // 从各席【求证】汇总
  costSource: 'ledger' | 'partial' | 'unavailable';
  unmeasured: { participantId: string; name: string; reason: string }[];
  transcriptDroppedChars: number;
  elapsedMs: number;
}
```

- 判据只有一条：`raw` 非空即 `chaired: true`；空串或调用失败即 `chaired: false` 且 `raw = ''`，**不伪造结论**。
- 主席在正文里自由组织小节（一致/分歧/否决/术语/决策/拍板/总结都是建议，不是契约）。
- 需要主人拍板的点由主席写在正文里，不再有 `needsOwner` 字段；主模型读到就转述给主人。

#### P1.6 纪要（`src/report.ts`）

顺序：议题包摘要与元信息 → 贤者名单表 → **设计纪要（主席 Markdown 原样嵌入）** → 未答求证 → 调用耗时 → 逐轮发言 → 异常记录 → 附录。

- 嵌入时只做 `sanitizeText`（剥控制字符），**不转义 Markdown**：主席写了 `## 一、一致点` 就原样是二级标题，引擎不再重排成 `### 一致点`。
- 没有「裁决矩阵表」这一节。`renderRunSummary`（`src/tools.ts`）同步直出 `minutes.raw`。

P1 验收（全部进 verify）：
- Brief：standard 缺 `invariants` 字段被拒且报错列出字段名；给空数组通过；quick 只给 topic+decisionPoints 通过。
- 议题包整包替换：显式 brief 覆盖旧包，旧 `proposal`/`background` 不残留（`replaceBrief`）。
- 协议：mock 发言含 1 条【求证】→ `questions.length === 1`；`【裁决】` 字样原样留在正文、不被解析、不产生 `rulings` 字段。
- 固定轮数：3 轮配置 → 跑满 3 轮 6 条发言，`stopReason === 'max-rounds'`，状态里没有 `matrix`。
- 预算：`maxTokens` 设很小 → `budget-exhausted`，已完成发言保留，主席运行，纪要写盘。
- 档位：`tier:'quick'` 只按 seats 过滤发言席且主席模型为 quick 覆盖值，`config.chair` 未被改写。
- 上下文顺序：同一贤者第 1、2 轮 user 消息在「当前是第」之前的前缀**逐字相同**。
- 主席：`raw` 与主席输出逐字相同；空返回 → `chaired:false`、`raw === ''`；报告里出现主席自己的小标题而非引擎拼装标题。
- 旧 `symposium.json`（无 tiers）能加载，`defaultTier==='standard'`。

### P2 求证暂停/恢复 + 状态持久化（todo #4，依赖 P1）

#### 状态机

```
running ──(轮末 questions>0 且档位允许)──> awaiting-verification ──(symposium_answer)──> running ──> done/stopped/failed
```

- 轮末汇总本轮全部 `questions`，按文本去重，截断到档位 `maxQuestions` 剩余额度，分配 `qid`（`Q1, Q2…` 全场递增）。超额问题直接进 `openQuestions`。
- 进入暂停时：`status = 'awaiting-verification'`，**写盘** `$DSH_HOME/symposium/runs/<runId>.json`（完整 `RunState` + 恢复所需游标：下一轮号、摘要、speechClipChars）。之后每次状态变化（暂停/恢复/结束）都覆盖写一次。
- `SymposiumRun.execute` 改为可重入：拆出 `runRounds(fromRound)`，暂停时 `execute` 正常返回（不是异常），`service.current` 置空但 `service.paused = run` 保留实例。
- 插件启动时（`apply`）扫描 `runs/` 中最新一个 `awaiting-verification` 的文件，恢复为 `paused`（从文件重建 `SymposiumRun`，需要新的 `fromPersisted(state)` 构造路径）。运行中（running）状态的文件启动时一律改判 `failed / internal-error（进程中断）` 并写纪要。
- `runs/` 保留最近 20 个文件，多余的按 mtime 删除（只删本插件生成的 `*.json`）。

#### 新工具 `symposium_answer`

参数（先查 `@deepseek-ai/dsh-tools` 的 `defineTool` 参数 DSL 是否支持 `items: { type: 'object' }`；不支持则用 JSON 字符串参数并在 execute 内解析校验）：

- `answers`: `[{ qid, status: 'verified'|'unverifiable', finding, evidence? }]`
- `finish?: boolean`：放弃剩余轮次，直接进主席。

行为：校验 qid 属于当前暂停场 → 记入 `state.verifications` → 恢复执行并沿用 `symposium_start` 的 120s 阻塞返回语义（`START_WAIT_MS`，`src/tools.ts`）。未答的 qid 视为 `unverifiable`。

下一轮上下文（P1.2 第 4 段）插入：

```
【已核实事实】
Q1（来自 反方刺客）问：…  答：…（证据：…）
Q2 无法核实：…
```

#### 工具面联动

- `symposium_start` 返回暂停态时，输出必须包含全部待答问题的 `qid` + 提问贤者 + 原文，并提示调用 `symposium_answer`。
- `symposium_status` 显示暂停态与待答问题。
- 已有暂停场时再 `symposium_start`：拒绝，提示先 answer 或 `finish`。
- `rechair`（`src/service.ts:350`）当前无入口：新增工具 `symposium_rechair` 或删除该方法，二选一；本施工图选**删除**（无调用方的死代码），如施工方认为需要保留须在交付说明里给理由。

P2 验收：
- mock 第 1 轮产出求证 → 状态 `awaiting-verification`，`runs/<id>.json` 存在且可 JSON.parse。
- answer 后第 2 轮 user 消息含「【已核实事实】」与答案原文。
- 模拟进程重启：新建 service 从 `runs/` 恢复暂停场，answer 后正常跑完并写纪要。
- running 状态文件在启动时被改判 failed 且有纪要。
- quick 档有求证也不暂停，问题出现在纪要 openQuestions。
- 暂停中再次 start 被拒。

### P3 决策日记 + 对账 + 应验率（todo #5，依赖 P1）

存储：`$DSH_HOME/symposium/decisions.jsonl`，**只追加**；每行一个 JSON，`type` 区分：

```jsonc
{ "type": "run", "at": 0, "runId": "", "tier": "", "topic": "", "matrix": {}, "objections": [{ "oid": "", "sage": "", "dp": "", "verdict": "否决|修改", "reason": "" }] }
{ "type": "ruling", "at": 0, "runId": "", "decisions": [{ "dp": "", "choice": "", "adopted": ["oid"], "note": "" }] }
{ "type": "reconcile", "at": 0, "runId": "", "oid": "", "outcome": "materialized|not-materialized|untested", "evidence": "" }
```

- `run` 行在每场结束（主席之后）自动追加；`objections` = 最终轮矩阵里每个 `否决/修改` 格，`oid = <runId前8位>:<sageId>:<dp>`。
- 新工具 `symposium_journal`：
  - `action=ruling`：记录主人对齐后的裁决（主模型代为调用）。
  - `action=reconcile`：施工后逐条对账；`oid` 不存在拒绝。同一 oid 多次对账以最后一条为准。
  - `action=stats`：按贤者聚合 `materialized / (materialized + not-materialized)`，`untested` 单列；附样本数，样本 <5 时标注「样本不足」。
  - `action=list`：最近 N 场及其未对账 oid 数（便于施工收尾时补账）。
- `symposium_config list` 每位贤者后附 `应验 x/y`（无数据显示 `—`）。
- 读取容错：坏行跳过并计数报告，不抛错。

P3 验收：一场 mock 结束后 jsonl 恰好多 1 行 run；reconcile 未知 oid 被拒；stats 数字与手工构造样本一致；坏行不影响统计。

### P4 按模型分组并行 + 施工图复审模式（todo #6，依赖 P2）

- **并行**：一轮内把席位按 `provider/model` 分组，组间 `Promise.all`，组内保持依次（成本归因靠前后快照差额，同模型并发会串账）。第 2 轮起每人只看**上一轮及以前**的发言（同轮不可见），消除发言顺序带来的位置偏差。`firstRoundBlind` 自然成为该规则的特例。
  - 须验证：`waitForModelCost(before, sage.model, …)`（`src/cost.ts:221`）在不同模型并发时仍能各自匹配；verify 加一项 2 模型并发归因测试。
- **视野**：实现 P1.2 预留的 `view: 'problem-only'`；默认配置给 `adversary` 设 `problem-only`（只在首轮生效，第 2 轮起给全量以便对撞）。
- **复审模式**：`symposium_start` 参数 `mode: 'design' | 'plan'`。`plan` 模式发言规则改为审「施工顺序 / 回滚路径 / 验证手段 / 依赖遗漏」，决策点由调用方传工作包 id（如 `W1`，放宽 P1.1 的 `^D\d+$` 为 `^[DW]\d+$`）；主席 ADR 字段换为 `{ risk, mitigation, verifyBy }`。

P4 验收：两模型并发时墙钟 ≈ 单模型时长而非两倍（mock 延迟断言）；同轮发言互不可见；plan 模式纪要含 risk/mitigation。

### 冒烟（todo #7，依赖 P1，主模型执行，非施工方）

用 quick 档对一个真实小议题跑一场，记录每席真实 `usage` 与调用次数，校准下表；有账本时记录金额。

## 3. 预估用量（脚本按当前引擎逻辑模拟，待冒烟校准）

假设：每条发言≈550 tok，固定开销（system+规则+身份）≈700 tok，主席输出≈2.5k，token 按汉字 1、其它 3.5 字符 1 估算（同 `estimateTokens`）。

| 档 | 调用次数 | 单次输入峰值 | 整场 token |
|---|---|---|---|
| quick（2 席×1 轮，议题包 2.5k） | 3 | ≈5k | ≈15k |
| standard（3 席×2 轮，议题包 4k） | 7 | ≈9k | ≈49k |
| deep（4 席×4 轮，议题包 6k） | 17 | ≈16k | ≈198k |
| deep，议题包 15k | 17 | ≈25k | ≈351k |

未计：Claude thinking 的思考 token；P2 每次暂停为下一轮每席增加 0.5–2k 的「已核实事实」。

## 4. 研讨裁决（2026-10-27 两场实测，国模阵容；施工以本节为准）

议题 D1（同轮发言调度）与 D3（反对意见编号粒度）已由四贤评审，结论如下。

### D1 裁决：可见性做成显式策略，不把计费缺陷焊进调度拓扑

- 新增轮级 `visibility_policy: 'previous_rounds' | 'incremental'`，调度器只执行策略。`incremental` = 本轮后者可见前者（现状）；`previous_rounds` = 每人只见上一轮及以前（同时发言语义）。
- 引擎入口校验：禁止任何席位绕过策略注入他人本轮发言（测试断言每席实际收到的上下文）。
- 默认拓扑 = 组间并行、组内串行：不同模型组间并行；同模型席位组内串行（保成本归因）。无同模型席位时等同于同时发言。
- **运行前归因校验**：本轮任一调用无法唯一归属时拒绝并发，自动降级为全串行并记 anomaly。
- 席位顺序轮间轮转（round-robin），防末位系统性主导偏置。
- 约束(1)（快照差值归因）记录为临时架构决策，待账本升级 token 级回执后重评拓扑。
- 反方保留立场：主张先接受「模型级记账」降级；作为备选提交发起人，未纳入默认。

### D3 裁决：引擎编号，主键聚合、子键细化

- 贤者不手写编号；每条反对以结构化条目提交：`{ dp, claim, reason, falsifiable, trigger }`（falsifiable = 可独立证伪的失败预测；trigger = 触发条件）。
- 引擎生成稳定 ID：`S<贤者>-D<决策点>-O<n>`，本贤者×本决策点内递增，禁止跨决策点续编；主席重编号时以纪要编号为对账唯一键。
- 不足可证伪的反对记「立场保留」，不生成 O 编号（不进应验率分母）。
- 对账盲区补偿（刺客提出）：决策日记支持「施工期新发现问题」补登条目（`type=new-finding`），与贤者反对分开统计。
- P3 的 objections 结构扩展 `falsifiable` / `trigger`；P1.3 解析器同步解析结构化反对块。
- 边界情形：多条反对叠加触发（O1+O2 单独都不爆、合起来才崩）由 `trigger` 字段记录组合条件，对账时按 trigger 断言而非单条归因。

### 仍开放

- **D2** 暂停场无人回答时：永久保留直到被 answer/finish/新开场覆盖（本图默认）vs 设超时自动 `finish`。

### P2/P3 定稿条款（2026-10-27 三场实测，四席收敛；施工以本节为准）

P2：
- 快照为唯一恢复权威：tmp+rename，文件 fsync + 父目录 fsync + 回读长度校验 + 内容校验和；tmp 前缀启动清理。
- `pendingQids` 数组化（当前断言 ≤1），协议放开时零迁移。
- 启动扫描把 running 改判 `interrupted`（保留可恢复信息）；扫描必须先于任何 run 创建（断言本进程尚无 runId）。
- fsync/回读失败不承认暂停：保持 running、重试一次、告警。
- stale 是展示层派生量（不落盘、可配置、幂等）；手动 finish 为唯一人工出口；awaiting 磁盘上限只告警不自动清理；late-answer 只记审计不推进执行。
- answer 强制 runId+qid 双键（显式寻址），不做「自动续最近场」。

P3：
- 单 jsonl + type + schemaVersion + ts；整行单次 write + fsync + 回读长度（写前 parse 防不了半行，废除该防护）。
- 坏行：行级跳过并计数上对账报告；close 行损坏 → 该目录硬门禁（不可归档、不可清理，人工处置后解除）。
- 归档前必须先有 close 条目；启动强校验，无 close 阻断归档。
- 应验率只认 `type=ruling` 且 `result ∈ {materialized, not-materialized}`；分母为 0 写「不可用」字符串（不改 null）。
- 纪要分段提交（多条 ruling 行）绕开单次输出上限；截断行标 `truncated` 且不进应验率分母。
- answer 幂等键 `(runId, qid, status)`。

## 5. 交付说明要求（每个工作包）

- 改动文件清单与每处改动一句理由。
- typecheck / verify（项数与耗时）/ build（产物字节）三项输出。
- 与本施工图的偏差及理由；发现施工图与现场代码矛盾时，以代码为准并点名。
- 未验证项：真实模型调用、App 重启后装载均由主模型另行验证，施工方注明「未验证」即可。
