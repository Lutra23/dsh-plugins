# dsh-design-symposium 改造蓝图

> fork 自 [HSM266/dsh-roundtable-harness](https://github.com/HSM266/dsh-roundtable-harness) v0.3.14（MIT）。
> 哲学指导：VCPToolBox `MagiAgent`（立场贤者多轮辩论、可见修正、综合结论）+ `AgentAssistant`（异步委托查询）+ VCPChat 群聊（发言编排/话题总结）。
> 定位转型：**多模型辩论赛（娱乐评测）→ 设计研讨会（立场碰撞出设计决策）**。

## 一、源码考古结论

### 保留的骨架（价值已验证）

| 机制 | 位置 | 保留理由 |
|---|---|---|
| 共享上下文结构性强制 | `symposium.ts buildContext`（L516-551） | 整 transcript 塞单条 user message，"人人可见"是结构不是约定——研讨会同一需求 |
| 三级上下文护栏 | `compress`（L562-621）+ `keepRecentRounds` + 硬截断 | 摘要 fold-forward、压缩失败降级保标题、预算回复自动解除截断——设计讨论轮次更长，更需要 |
| 成本精确归因 | `speak`（L403-427）+ `cost.ts` | before/after 快照 + `waitForModelCost` 防批写串号 + unmatched 整席声明剔除——"缺数据≠零成本"原则照搬 |
| 停止语义与崩溃保发言 | `execute`（L265-319） | 7 种 StopReason；异常路径也写报告，"保留已完成部分"对设计纪要同样成立 |
| persona 磁盘镜像 | `config.ts resolvePersona/ensurePersonaFiles` | 直接编辑 `personas/<id>.md` 即生效，改造成贤者立场文件同机制 |
| 敏感词护栏 | `sensitive.ts` + 预检/阈值终止 | 内容安全底线，低成本保留 |
| env 覆盖免重启 | `readEnvironmentOverrides` | JUDGE_MODEL 等运行时可换主席 |

### 砍除的娱乐设施

| 砍除物 | 位置 | 理由 |
|---|---|---|
| docx 导出 | `docx-export.ts`(32KB) + `docx` 依赖 | 战报封面/头像/分轮章节是辩论赛包装；纪要 Markdown 足够，砍后**运行时零依赖** |
| 设置页 UI | `client.tsx`(107KB) + `widget-image.ts` + `exports./client` + `dsh.client` | 107KB 全是辩论赛 UI；V1 走配置文件 + agent 工具驱动 |
| Typert Remote | `markRemoteMethods`/`REMOTE_METHODS`/`typertRemote` + peerDeps `dsh-typert-protocol` | 只有设置页经 `ctx.remote.symposium.*` 调用；工具面直达服务 |
| 六维评分体系 | `dimensions.ts` + `scoreWeights` + `computeValueScores` + 性价比榜 | 攻击性/趣味度是竞技维度，与设计决策无关 |
| 头像/选手/战报文案 | `avatar` 字段、providerAliases | 随 UI 与 docx 一并退役 |

## 二、MagiAgent 哲学 → 改造设计

### 席位：选手 → 贤者（Sage）

```
ParticipantConfig          →   SageConfig
  id/name                      id/name
  provider/model（核心身份）     provider/model（可选差异，可全场同模型）
  persona（娱乐人设）            stance（立场声明，必填：这个席位守护什么价值）
  avatar（砍）                  duties（评审职责清单 string[]：这个席位必查什么）
  cheap                        persona（人格补充，可选）
                               cheap（保留，摘要仍偏好低成本模型）
```

关键语义转变：身份锚点从「绑什么模型」移到「持什么立场」。模型绑定降级为可调参数。

### 讨论协议（T4）

1. **议题包 brief**：`topic: string` → `brief: { topic, background?, materials?: string[] }`。
   `symposium_start` 工具参数扩展；materials 注入首轮上下文开头（设计文档/代码摘要等工程材料——会前由调用方（溟月）用 project_forge 采集打包）。
2. **首轮盲评（firstRoundBlind，默认 true）**：第一轮各席只见议题包不见彼此（防锚定/从众），
   第二轮起共享 transcript 全量可见。MagiAgent 是全程可见；我们加这一档是因为设计评审
   的独立意见书价值高于接龙——可配置回退到全程明辩（false）。
3. **立场修正轨迹**：发言规则要求每轮末尾输出结构化立场行
   `【立场】坚持|修正|让步：一句话理由`，chair 解析进纪要的 stanceTrajectory。
   这是 MagiAgent「每一轮贤者都能看到其他贤者的观点并进行回应和修正」的落地形式。
4. 发言身份注入 stance/duties；BOUNDARY_CLAUSE 改贤者版（去「攻击性」表述，保留敏感拒绝、不伪造发言）。

### 主席：裁判 → Chair（T5）

`judge.ts` → `chair.ts`，`buildJudgePrompt` → `buildChairPrompt`。评分 JSON schema → 设计纪要 schema：

```json
{
  "agreements":  [{ "point", "holders", "rationale" }],
  "disputes":    [{ "point", "positions": [{ "sage", "stance", "argument" }], "suggestion" }],
  "rejections":  [{ "proposal", "reason", "by" }],
  "decisions":   [{ "recommendation", "confidence", "prerequisites" }],
  "glossary":    [{ "term", "definition" }],
  "stanceTrajectory": [{ "sage", "rounds": [{ "round", "stance", "shift" }] }],
  "summary": ""
}
```

- 免责声明保留（AI 生成可能出错，不构成权威结论）。
- transcript 尾部保留策略保留（后轮权重高）。
- 主席失败降级：六维的 fallback 启发式没有对等物——降级为「纪要标记 unchaired + 完整 transcript 保留」，不伪造结论。
- `rejudge` → `rechair`（重跑主席）。
- 成本从「性价比排名」降为纪要附录一段（总花费/口径/归因覆盖），`participantCosts` 机制不动。

### 身份重构（T2）

- 包名 `dsh-roundtable-harness` → `dsh-design-symposium`；loader 行 id `roundtable-harness` → `design-symposium`
- 服务 `ctx.roundtable` → `ctx.symposium`；工具 `roundtable_start/status/export` → `symposium_start/status/report`（后来又加了 config）
- system prompt 段 `roundtable:personas` → `symposium:sages`；中文全量换词：辩论→研讨、选手→贤者、裁判→主席、战报→纪要
- 版本 0.3.14 → 0.4.0；README 重写；CHANGELOG 起新篇声明衍生关系
- MIT 合规：保留 LICENSE 与 HSM266 署名，package.json author 注明原著+改造，NOTICE 说明 fork 来源与改造范围

### 报告：战报 → 纪要（report.ts 改写）

结构：议题包摘要 → 贤者名单（立场/职责/模型） → 逐轮发言记录（保留） → **设计纪要**（一致/分歧/否决/建议/术语/立场轨迹） → 异常与成本附录。

## 三、施工顺序与依赖

```
T2 身份重构（机械改名，先做避免双重 grep）
 └─> T3 席位语义（config 结构 + buildContext 身份注入）
      └─> T4 讨论协议（brief/盲评/立场行——buildContext 与 speak 协同改）
           └─> T5 chair（judge.ts 重写 + evaluate 接线）
                └─> T6 砍除（docx/client/Remote/dimensions——大量是删除，放 T5 后避免中间态编译错误）
                     └─> T7 测试 ─> T8 构建装机 ─> T9 冒烟
```

## 四、风险与边界

1. **peerDeps 变更**：删 `dsh-typert-protocol`；其余（cordis/dsh-llm/dsh-tools/schemastery）保留。
2. **compatibility**：`>=0.2.0-rc.1 <0.3.0-0` 覆盖本机 0.2.1-rc.3，不动。
3. **lib/ 是装机物**：TS 改完必须 `npm run build`（scripts/build.mjs），装机验 lib 不验 src。
4. **desktop profile 注册**：走手动配方（dependencies link: + dsh.profile.bundles + junction + 重启 App），`dsh plugin add` 被 Electron 独占拒绝。
5. **冒烟议题**：待主人给真实设计议题，或用「本插件自己的设计取舍」自指议题。
