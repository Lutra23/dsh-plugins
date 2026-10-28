# dsh-design-symposium

> 设计研讨会插件：让多个持**不同设计立场**的贤者围绕同一议题多轮研讨，共享上下文，
> 主席收敛为**设计纪要**（一致点 / 分歧 / 否决方案 / 建议决策 / 术语定名）。
>
> fork 自 [HSM266/dsh-roundtable-harness](https://github.com/HSM266/dsh-roundtable-harness) v0.3.14（MIT），
> 按 VCPToolBox `MagiAgent` 立场辩论哲学大刀阔斧改造。原插件的「多模型辩论赛 + 六维评分 + docx 战报」
> 已转型为「立场研讨会 + 主席纪要」；架构骨架（共享上下文强制、上下文压缩护栏、成本精确归因、崩溃保发言）
> 继承自上游。0.5 起加上**议题包契约 + 三档预算 + 求证暂停 + 决策日记**，当前契约以
> [docs/blueprint-v0.5.md](docs/blueprint-v0.5.md) 为准（0.4 的改造过程留在 [docs/refactor-blueprint.md](docs/refactor-blueprint.md)）。

## 核心概念

- **贤者（Sage）**：研讨席位。身份锚点是**立场（stance）与评审职责（duties）**，不是模型——
  模型绑定只是可调参数，全场同模型也完全成立。立场文件镜像到 `personas/<id>.md`，直接编辑即生效。
- **议题包（brief，v0.5 契约）**：`topic` + `background` / `materials`（首轮逐条注入的工程材料）+
  `proposal`（被评审草案）+ `decisionPoints`（D1/D2…，所有档位必填）+ `locked`（已拍板不许翻案）+
  `invariants`（必须成立的不变量）+ `assumptions`（`verified` 区分事实与推测）+ `rejected`（已否方案与理由）。
  缺项按档位拒启动并逐条点名：`quick` 只要 topic + 决策点，`standard`/`deep` 要求整包声明。
- **首轮盲评（firstRoundBlind，默认开）**：第一轮各席只见议题包不见彼此，防止锚定从众；
  第二轮起共享 transcript 全量可见。可配置关闭，回退 MagiAgent 式全程明辩。
  `visibilityPolicy=previous_rounds`（默认）时同轮互不可见，`incremental` 为同轮增量可见。
- **档位（tier）**：`quick` / `standard` / `deep`，各带轮数、单轮输出上限、整场 token 硬顶、
  求证额度与可选的席位/主席模型覆盖（`seatModel` / `chair`）；未写死的字段回落 `tiers` 块与内置默认。
- **求证暂停（P2）**：贤者遇到事实疑问写【求证】Q1/Q2，额度内研讨会暂停并落盘；
  主模型查证后用 `symposium_answer` 把结论以「已核实事实」注入后续每轮，查不到写 `unverifiable`。
- **立场修正轨迹**：每轮发言末尾要求结构化立场行 `【立场】坚持|修正|让步：一句话理由`，
  主席据此在纪要中还原每位贤者的立场演化。
- **主席（Chair）**：取代上游的六维裁判。读完整发言记录，产出**自由 Markdown 纪要**
  （一致点 / 分歧 / 否决方案 / 建议决策 / 术语定名 / 立场轨迹），原样嵌入报告——不解析结构化字段、
  不做裁决矩阵，模型写什么就留什么。主席失败时纪要标记 unchaired 并保留完整记录，**不伪造结论**。
- **成本账本**：继承上游精确归因——每次调用前后读 dsh-cost-meter 账本，按 provider:model 归因；
  无法归因的贤者整体剔除并声明原因，缺数据绝不读作零成本。
- **决策日记（P3）**：`$DSH_HOME/symposium/journal` 记录每场摘要与反对条目；
  施工后用 `symposium_journal action=reconcile` 逐条对账，按贤者聚合成**应验率**（样本 <5 标注不足）。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `symposium_start` | 发起研讨会：议题包 + 档位 + 模式 + 轮数；超过 120 秒转后台，`symposium_status` 轮询 |
| `symposium_status` | 实时状态：轮次进度、全部发言、主席纪要、异常记录 |
| `symposium_answer` | 回答【求证】暂停的问题并继续；`finish=true` 放弃剩余轮次直接收敛 |
| `symposium_config` | `list` 看席位与模型绑定；`set` 一句话改某席或主席的 provider/model，下一场生效 |
| `symposium_journal` | 决策日记：`objection` 登记反对 / `ruling` 记裁决 / `reconcile` 对账 / `stats` 应验率 / `list` 场次 |
| `symposium_report` | 取/重渲染纪要 Markdown（主席原文原样嵌入） |

## 配置

配置文件 `$DSH_HOME/symposium.json`（persona 镜像目录 `$DSH_HOME/symposium/personas/`，
报告默认写 `$DSH_HOME/symposium/reports/`）。关键字段：

```jsonc
{
  "brief": {
    "topic": "…",
    "background": "…",
    "materials": ["…"],
    "proposal": "…",                        // 被评审草案（standard/deep 必填）
    "decisionPoints": [{ "id": "D1", "title": "…", "options": ["…"], "lean": "…" }],
    "locked": [], "invariants": [],         // 已拍板项 / 必须成立的不变量
    "assumptions": [{ "text": "…", "verified": true }],
    "rejected": [{ "proposal": "…", "reason": "…" }]
  },
  "defaultTier": "standard",                // 未指定档位时用哪档
  "tiers": {                                // 逐档预算；未写的字段回落内置默认
    "quick":    { "rounds": 1, "maxTokensPerTurn": 16384, "maxTokens": 200000, "maxQuestions": 0 },
    "standard": { "rounds": 2, "maxTokensPerTurn": 16384, "maxTokens": 200000, "maxQuestions": 3 },
    "deep":     { "rounds": 4, "maxTokensPerTurn": 16384, "maxTokens": 600000, "maxQuestions": 8 }
  },
  "maxRounds": 3,               // 1–20（显式 rounds 优先于档位）
  "firstRoundBlind": true,      // 首轮盲评（防锚定）
  "visibilityPolicy": "previous_rounds", // 同轮互不可见；incremental 为增量可见
  "maxRunTokens": 0,            // 整场 token 硬顶，0 = 不限
  "maxQuestions": 0,            // 求证额度，0 = 不暂停
  "tokenBudget": 60000,         // 超限触发旧轮压缩
  "keepRecentRounds": 2,
  "sages": [
    {
      "id": "architect",
      "name": "架构贤者",
      "stance": "守护长期可维护性与模块边界……",
      "duties": ["检查模块耦合", "质疑过度设计"],
      "provider": "…", "model": "…",   // 可选差异，可全场同模型
      "cheap": false
    }
  ],
  "chair": { "enabled": true, "provider": "", "model": "", "persona": "" },
  "sensitive": { "builtin": true, "words": [], "patterns": [] }
}
```

环境变量覆盖（免重启）：`CHAIR_MODEL` / `CHAIR_PERSONA` / `SYMPOSIUM_OUTPUT_DIR`。

## 安装（desktop profile，手动注册配方）

desktop profile 由 Electron 独占管理，`dsh plugin add` 会被拒绝，走手动注册：

1. profile `package.json` 的 `dependencies` 加 `"dsh-design-symposium": "link:<本仓库路径>"`；
2. `dsh.profile.bundles` 追加本包；
3. `node_modules/dsh-design-symposium` 建 junction 指向本仓库（hoisted linker，免跑 pnpm）；
4. 重启 App（插件在组装期加载一次）。

## 与上游 roundtable-harness 的差异

| 维度 | 上游 | 本插件 |
|---|---|---|
| 席位身份 | 不同模型竞技 | 不同设计立场 |
| 输入 | 无契约，凭 prompt | 议题包契约（按档位校验，缺项拒启动） |
| 评分 | 六维裁判 + 性价比榜 | 主席自由 Markdown 纪要（不评分、不排名） |
| 产物 | Markdown 战报 + docx | 设计纪要 Markdown + 决策日记 |
| 交互 | 一次性出结果 | 求证暂停可中途注入事实；反对条目施工后对账 |
| UI | 设置页（Typert Remote） | 右栏「研讨现场」面板（client 半）+ 配置文件 + 工具驱动 |
| 运行时依赖 | docx | 零依赖 |

## 许可证

MIT。原作 [HSM266](https://github.com/HSM266)，衍生改造 MingYue workshop。
上游历史完整保留于 git log 与 [CHANGELOG](CHANGELOG.md) 0.3.x 条目。
