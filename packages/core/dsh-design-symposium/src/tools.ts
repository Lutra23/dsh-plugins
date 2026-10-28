/**
 * Agent tools.
 *
 * The tools are thin: every one of them calls the same
 * {@link SymposiumEndpoints} service methods, so the tool surface is the
 * single code path to the engine — nothing else reaches it.
 *
 * Note the parameter DSL: an optional field **omits** `required`, it never says
 * `required: false` — the schema compiler rejects the latter outright.
 *
 * @module dsh-design-symposium/tools
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { Assumption, Brief, DecisionPoint } from './config.js';
import type { SymposiumEndpoints } from './service.js';
import type { RunState, Speech, Verification } from './symposium.js';

/** Longest a `symposium_start` tool call blocks before reporting progress instead. */
const START_WAIT_MS = 120_000;

/** Parse a JSON-string tool argument; a bad payload names the argument. */
function parseJsonArg<T>(raw: string | undefined, label: string): T | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${(error as Error).message}`);
  }
}

/** Split a multi-line tool argument into trimmed, non-empty lines. */
function splitLines(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Render one speech as a compact transcript row. */
function speechLine(speech: Speech): string {
  const head = `[R${speech.round}] ${speech.name} (${speech.provider}/${speech.model})`;
  const spend = speech.costStatus === 'measured'
    ? `$${speech.cost.toFixed(6)}`
    : `花费口径不可用(${speech.costStatus})`;
  const stats = `${speech.usage.outputTokens} out · ${spend} · ${speech.elapsedMs} ms`;
  if (speech.status !== 'ok') return `${head} — ${speech.status.toUpperCase()}: ${speech.note ?? '无响应'} (${stats})`;
  return `${head} — ${stats}\n${speech.text}`;
}

/** Human-readable cost coverage for the header line. */
function costSourceLabel(state: RunState): string {
  switch (state.costSource) {
    case 'ledger': return 'dsh-cost-meter 真实账本，全员已归因';
    case 'partial': return 'dsh-cost-meter 真实账本，部分贤者归因失败（如实标注）';
    default: return '口径不可用：未读到账本（token 用量见各发言行）';
  }
}

/**
 * Render a run for the model: state header, the transcript of the most recent
 * round, the design minutes, and where the report went.
 * @param state - the run to summarize.
 * @returns a Markdown-ish summary.
 */
export function renderRunSummary(state: RunState): string {
  const lines: string[] = [];
  lines.push(`状态：${state.status}${state.stopReason !== undefined ? `（${state.stopReason}）` : ''}`);
  lines.push(`话题：${state.brief.topic}`);
  lines.push(`轮数：${state.rounds}/${state.plannedRounds} · 发言 ${state.speeches.length} 条`
    + ` · 总花费 $${state.totalCost.toFixed(6)}（${costSourceLabel(state)}）`);
  if (state.continuedFrom !== undefined) lines.push(`续接自：${state.continuedFrom}`);
  if (state.status === 'awaiting-verification') {
    lines.push('', '等待回答的求证问题（用 symposium_answer 提交，qid 原样引用）：');
    for (const item of state.pendingQuestions ?? []) {
      lines.push(`- ${item.qid}（${item.sageName}）：${item.text}`);
    }
    lines.push('答不出来也要提交 status=unverifiable 并说明查了什么。');
  }
  if (state.reportPath !== undefined) lines.push(`Markdown 纪要：${state.reportPath}`);
  if (state.error !== undefined) lines.push(`错误：${state.error}`);

  if (state.minutes !== undefined) {
    const m = state.minutes;
    lines.push('', m.chaired ? `设计纪要（主席 ${m.provider}/${m.model}）：` : '设计纪要：主席未产出');
    if (!m.chaired) {
      lines.push(`⚠️ 主席未产出纪要（${m.note ?? '未返回内容'}），完整发言记录见下，请人工研判。`);
    } else {
      lines.push('', m.raw);
    }
    if (m.openQuestions.length > 0) {
      lines.push('', '未答求证：');
      for (const question of m.openQuestions) lines.push(`- ${question}`);
    }
    if (m.unmeasured.length > 0) {
      lines.push('', '成本口径不可用（无数据 ≠ 零成本）：');
      for (const entry of m.unmeasured) lines.push(`- ${entry.name}：${entry.reason}`);
    }
  } else if (state.status !== 'running') {
    lines.push('', '本场没有纪要（主席未配置、研讨被终止，或主席未运行）。');
  }

  if (state.speeches.length > 0) {
    lines.push('', '发言记录：');
    for (const speech of state.speeches) lines.push('', speechLine(speech));
  }
  if (state.anomalies.length > 0) {
    lines.push('', '异常记录：');
    for (const anomaly of state.anomalies) {
      lines.push(`- [R${anomaly.round || '—'}] ${anomaly.kind}：${anomaly.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Register the three symposium tools on the calling context.
 * @param ctx - the context that owns the registrations.
 * @param service - the shared operations object.
 * @param tools - the tool registry, injected optionally by the caller.
 * @returns the disposers, so the caller can keep them in its own effect.
 */
export function registerSymposiumTools(
  ctx: Context,
  service: SymposiumEndpoints,
  tools: ToolRuntime,
): (() => void)[] {
  const disposers: (() => void)[] = [];
  void ctx;

  disposers.push(tools.register(defineTool({
    name: 'symposium_start',
    description: [
      '发起一场设计研讨会：多位持不同设计立场的贤者围绕议题多轮研讨，',
      '首轮盲评（各席独立意见书，互不可见），第二轮起共享全部发言，',
      '每轮发言末尾输出立场声明（坚持/修正/让步），结束后由主席收敛为设计纪要',
      '（一致点/分歧/否决方案/建议决策/术语定名）并写出 Markdown 纪要。',
      '贤者席位（立场/职责/模型绑定）在 symposium.json 的 sages 中配置。',
    ].join(''),
    parameters: {
      topic: { type: 'string', description: '研讨议题；留空则使用 symposium.json 保存的议题包' },
      background: { type: 'string', description: '可选背景：设计文档摘要、约束、决策上下文，与 topic 一起构成议题包' },
      materials: { type: 'array', items: { type: 'string' }, description: '可选工程材料（代码摘要、接口清单等），逐条注入首轮上下文' },
      rounds: { type: 'number', description: '研讨轮数 1-20；留空或 0 则使用 symposium.json 保存的轮数' },
      tier: { type: 'string', description: '档位 quick|standard|deep（默认 quick）；standard/deep 要求议题包完整声明 proposal/locked/invariants/assumptions/rejected' },
      mode: { type: 'string', description: 'design（默认，设计评审）| plan（施工图复审：审施工顺序/回滚路径/验证手段/依赖遗漏，决策点用工作包 id 如 W1）' },
      proposal: { type: 'string', description: '被评审的设计草案正文（standard/deep 必填）' },
      decisionPoints: { type: 'string', description: '决策点 JSON 数组：[{"id":"D1","title":"…","options":["…"],"lean":"…"}]，至少一个（所有档位必填）' },
      locked: { type: 'string', description: '已锁定、不许翻案的条目，换行分隔（standard/deep 必填，无内容给空串）' },
      invariants: { type: 'string', description: '必须成立的不变量，换行分隔（standard/deep 必填，无内容给空串）' },
      assumptions: { type: 'string', description: '假设 JSON 数组：[{"text":"…","verified":true|false}]（standard/deep 必填，无内容给 []）' },
      rejected: { type: 'string', description: '已否决方案 JSON 数组：[{"proposal":"…","reason":"…"}]（standard/deep 必填，无内容给 []）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      topic?: string; background?: string; materials?: string[]; rounds?: number;
      tier?: string; mode?: string; proposal?: string; decisionPoints?: string; locked?: string;
      invariants?: string; assumptions?: string; rejected?: string;
    }) {
      // Any of the brief fields switches the call from "stored brief" to an
      // explicit one; a bare topic keeps working as before.
      if (args.topic === undefined && (args.background !== undefined || args.materials !== undefined)) {
        throw new Error('议题包缺少 topic：background/materials 必须与 topic 一起给出');
      }
      const decisionPoints = parseJsonArg<DecisionPoint[]>(args.decisionPoints, 'decisionPoints');
      const assumptions = parseJsonArg<Assumption[]>(args.assumptions, 'assumptions');
      const rejectedOptions = parseJsonArg<{ proposal: string; reason: string }[]>(args.rejected, 'rejected');
      const brief: Brief | '' = args.topic === undefined
        ? ''
        : {
          topic: args.topic,
          ...(args.background !== undefined ? { background: args.background } : {}),
          ...(args.materials !== undefined ? { materials: args.materials } : {}),
          ...(args.proposal !== undefined ? { proposal: args.proposal } : {}),
          ...(decisionPoints !== undefined ? { decisionPoints } : {}),
          ...(args.locked !== undefined ? { locked: splitLines(args.locked) ?? [] } : {}),
          ...(args.invariants !== undefined ? { invariants: splitLines(args.invariants) ?? [] } : {}),
          ...(assumptions !== undefined ? { assumptions } : {}),
          ...(rejectedOptions !== undefined ? { rejected: rejectedOptions } : {}),
        };
      const tier = args.tier === 'standard' || args.tier === 'deep' ? args.tier : 'quick';
      await service.startRun(brief, args.rounds ?? 0, tier, args.mode === 'plan' ? 'plan' : 'design');
      // The run continues in the background; block only long enough to answer
      // most discussions inline, then hand back progress instead of hanging.
      const settled = await Promise.race([
        service.whenRunSettles(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), START_WAIT_MS)),
      ]);
      if (settled === undefined) {
        const state = await service.getState();
        return `讨论已开始并在后台继续（超过 ${Math.round(START_WAIT_MS / 1000)} 秒仍未结束）。\n`
          + `当前进度：第 ${state.run?.rounds ?? 0}/${state.run?.plannedRounds ?? 0} 轮，`
          + `已有 ${state.run?.speeches.length ?? 0} 条发言。稍后用 symposium_status 查询，`
          + `结束用 symposium_report 读取纪要。`;
      }
      return renderRunSummary(settled);
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'symposium_status',
    description: '查询当前或最近一场研讨的状态：轮次进度、全部发言、主席纪要与异常记录。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const state = await service.getState();
      if (state.run === undefined) {
        return `还没有任何讨论记录。已配置 ${state.config.sages.length} 位贤者，`
          + `主席 ${state.resolvedChair !== undefined ? `${state.resolvedChair.provider}/${state.resolvedChair.model}` : '未配置'}。`;
      }
      return renderRunSummary(state.run);
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'symposium_report',
    description: '读取最近一场研讨的设计纪要 Markdown（一致点/分歧/否决方案/建议决策/术语定名/立场轨迹+发言记录）。纪要在研讨结束时自动写盘，本工具直接返回全文。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return service.getReport();
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'symposium_answer',
    description: [
      '回答研讨暂停时提出的【求证】问题，然后让讨论继续。',
      '研讨会遇到需要核实的事实时会暂停并给出 Q1/Q2 编号；主模型查证后用本工具提交结论，',
      '结论会以「已核实事实」注入后续每一轮。答不出来的问题提交 status=unverifiable，',
      '不要留空——「没人查」和「查了查不到」必须区分。',
      'finish=true 表示放弃剩余轮次，直接让主席按已有发言收敛出纪要。',
    ].join(''),
    parameters: {
      answers: {
        type: 'string',
        description: 'JSON 数组：[{"qid":"Q1","status":"verified|unverifiable","finding":"结论","evidence":"证据出处（可选）"}]',
      },
      finish: { type: 'boolean', description: '放弃剩余轮次直接收敛纪要（缺省 false）' },
      run_id: { type: 'string', description: '可选：目标场次 id（多场并存时防投错；与当前暂停场不一致会被拒绝）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { answers?: string; finish?: boolean; run_id?: string }) {
      const parsed = parseJsonArg<{ qid?: string; status?: string; finding?: string; evidence?: string }[]>(
        args.answers,
        'answers',
      ) ?? [];
      const pending = service.pendingQuestions();
      if (pending.length === 0 && args.finish !== true) {
        throw new Error('当前没有等待求证答案的研讨。');
      }
      const known = new Set(pending.map((item) => item.qid));
      const answers: Verification[] = [];
      for (const entry of parsed) {
        const qid = (entry.qid ?? '').trim();
        if (!known.has(qid)) throw new Error(`未知的求证编号 ${qid}；当前待答：${[...known].join('、') || '（无）'}`);
        const finding = (entry.finding ?? '').trim();
        if (finding.length === 0) throw new Error(`${qid} 缺少 finding：答不出来请写 status=unverifiable 并说明查了什么`);
        answers.push({
          qid,
          status: entry.status === 'unverifiable' ? 'unverifiable' : 'verified',
          finding,
          ...(entry.evidence !== undefined && entry.evidence.trim().length > 0 ? { evidence: entry.evidence.trim() } : {}),
          at: Date.now(),
        });
      }
      const state = await service.answerRun(answers, args.finish === true, args.run_id);
      return renderRunSummary(state);
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'symposium_config',
    description: [
      '查看或快速修改设计研讨会配置。action=list 列出席位与模型绑定（含主席与配置文件路径）；',
      'action=set 一句话改某个贤者或主席的 provider/model，写入 symposium.json 后立即生效，',
      '下一场讨论即用——不必手编 JSON。',
    ].join(''),
    parameters: {
      action: { type: 'string', description: 'list=查看配置；set=修改。缺省 list' },
      target: { type: 'string', description: 'set 时的目标：sage=某个贤者，chair=主席。缺省 sage' },
      id: { type: 'string', description: 'target=sage 时的贤者 id（如 pragma/purist/adversary/scribe）' },
      provider: { type: 'string', description: '新的 provider 路由，如 deepseek-official' },
      model: { type: 'string', description: '新的模型 id，如 deepseek-flash 或 deepseek-v4-pro' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { action?: string; target?: string; id?: string; provider?: string; model?: string }) {
      const config = await service.reloadConfig();
      if (args.action !== 'set') {
        const rows = config.sages.map((sage, index) => {
          const binding = sage.provider === '' || sage.model === ''
            ? '未绑定（引擎逐场跳过）'
            : `${sage.provider}/${sage.model}`;
          return `${index + 1}. ${sage.id}（${sage.name}） ${binding} — 应验 ${service.fulfillmentOf(sage.id)} — ${sage.stance.slice(0, 50)}`;
        });
        const chair = config.chair.provider === '' || config.chair.model === ''
          ? '未绑定（主席将降级为未收敛）'
          : `${config.chair.provider}/${config.chair.model}`;
        return [
          `配置文件：${service.configPathSnapshot()}`,
          `贤者 ${config.sages.length} 位：`,
          ...rows,
          `主席：${chair}${config.chair.enabled ? '' : '（已禁用）'}`,
          `轮数上限 ${config.maxRounds} · 首轮盲评 ${config.firstRoundBlind ? '开' : '关'}`,
          '',
          '改模型：action=set target=sage id=<贤者id> provider=deepseek-official model=deepseek-v4-pro',
        ].join('\n');
      }
      const provider = args.provider?.trim() ?? '';
      const model = args.model?.trim() ?? '';
      if (provider === '' && model === '') throw new Error('set 需要至少一个 provider 或 model');
      if (args.target === 'chair') {
        await service.saveConfig({ chair: { ...(provider !== '' ? { provider } : {}), ...(model !== '' ? { model } : {}) } });
        const fresh = await service.reloadConfig();
        return `主席已更新：${fresh.chair.provider}/${fresh.chair.model}（已写入 ${service.configPathSnapshot()}，下一场讨论生效）`;
      }
      const id = args.id?.trim() ?? '';
      if (id === '') throw new Error('target=sage 时需要 id');
      const index = config.sages.findIndex((sage) => sage.id === id);
      if (index < 0) throw new Error(`没有 id=${id} 的贤者；现有：${config.sages.map((sage) => sage.id).join('、')}`);
      const sages = config.sages.map((sage, cur) => cur !== index ? sage : {
        ...sage,
        ...(provider !== '' ? { provider } : {}),
        ...(model !== '' ? { model } : {}),
      });
      await service.saveConfig({ sages });
      const fresh = await service.reloadConfig();
      const tuned = fresh.sages.find((sage) => sage.id === id);
      return `贤者 ${id} 已更新：${tuned?.provider}/${tuned?.model}（已写入 ${service.configPathSnapshot()}，下一场讨论生效）`;
    },
  })));

  disposers.push(tools.register(defineTool({
    name: 'symposium_journal',
    description: [
      '决策日记与应验率（P3）。',
      'action=objection 登记一条值得跟踪的反对意见（主模型在与主人对齐后调用；返回 oid，后续用它对账）；',
      'action=ruling 记录主人对齐后的裁决（主模型代为调用）；',
      'action=reconcile 施工后逐条对账（oid 不存在会被拒绝，同一 oid 多次对账以最后一条为准）；',
      'action=stats 按贤者聚合应验率（只认 materialized/not-materialized，样本 <5 标注样本不足）；',
      'action=list 列出最近场次及其未对账 oid 数，便于施工收尾时补账。',
    ].join(''),
    parameters: {
      action: { type: 'string', description: 'objection=登记反对；ruling=记裁决；reconcile=对账；stats=应验率；list=最近场次（缺省 stats）' },
      run_id: { type: 'string', description: 'objection/ruling 的目标场次；缺省用日记里最新一场' },
      sage: { type: 'string', description: 'action=objection 必填：贤者 id 或名单里的名字' },
      dp: { type: 'string', description: 'action=objection 必填：决策点 id（D1 / W1）' },
      verdict: { type: 'string', description: 'action=objection 必填：否决 | 修改' },
      reason: { type: 'string', description: 'action=objection 必填：一句话说明反对什么，删掉就丢对账依据' },
      decisions: { type: 'string', description: 'action=ruling 必填：JSON 数组 [{"dp":"D1","choice":"…","adopted":["oid"],"note":"…"}]' },
      oid: { type: 'string', description: 'action=reconcile 必填：反对条目 id，形如 runId前8位:sageId:dp' },
      outcome: { type: 'string', description: 'action=reconcile 必填：materialized|not-materialized|untested' },
      evidence: { type: 'string', description: 'reconcile 可选证据指针（文件:行 / 测试名 / 提交号）' },
      limit: { type: 'number', description: 'action=list 返回场次数，缺省 10' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: {
      action?: string; run_id?: string; decisions?: string; oid?: string;
      outcome?: string; evidence?: string; limit?: number;
      sage?: string; dp?: string; verdict?: string; reason?: string;
    }) {
      const action = args.action ?? 'stats';
      if (action === 'objection') {
        const verdict = (args.verdict ?? '').trim();
        if (verdict !== '否决' && verdict !== '修改') {
          throw new Error('objection 的 verdict 必须是 否决 或 修改');
        }
        const oid = await service.journalObjection({
          ...(args.run_id !== undefined ? { runId: args.run_id } : {}),
          sage: args.sage ?? '',
          dp: args.dp ?? '',
          verdict,
          reason: args.reason ?? '',
        });
        return `已登记反对 ${oid}。施工完成后用 symposium_journal action=reconcile oid=${oid} outcome=materialized|not-materialized 对账。`;
      }
      if (action === 'ruling') {
        const decisions = parseJsonArg<{ dp: string; choice: string; adopted?: string[]; note?: string }[]>(
          args.decisions,
          'decisions',
        );
        if (decisions === undefined || decisions.length === 0) {
          throw new Error('ruling 需要 decisions JSON 数组，例如 [{"dp":"D1","choice":"采纳方案 A","adopted":["abc12345:adversary:D1"]}]');
        }
        return service.journalRuling(decisions, args.run_id);
      }
      if (action === 'reconcile') {
        const oid = (args.oid ?? '').trim();
        if (oid === '') throw new Error('reconcile 需要 oid');
        const outcome = (args.outcome ?? '').trim();
        if (outcome !== 'materialized' && outcome !== 'not-materialized' && outcome !== 'untested') {
          throw new Error('reconcile 的 outcome 必须是 materialized | not-materialized | untested');
        }
        return service.journalReconcile(oid, outcome, args.evidence);
      }
      if (action === 'list') {
        const rows = service.journalList(args.limit ?? 10);
        if (rows.length === 0) return `决策日记还没有 run 行（${service.journalPath()}）`;
        return [
          `决策日记：${service.journalPath()}`,
          ...rows.map((row) => {
            const when = new Date(row.at).toLocaleString();
            return `- ${row.runId.slice(0, 8)} ${when} [${row.tier}] ${row.topic.slice(0, 40)}`
              + `｜反对 ${row.objections} 未对账 ${row.unreconciled}${row.closed ? ' 已归档' : ''}`;
          }),
        ].join('\n');
      }
      const stats = service.journalStats();
      const lines = [`决策日记：${service.journalPath()}（${stats.totalLines} 行，坏行 ${stats.badLines}）`];
      if (stats.sages.length === 0) {
        lines.push('还没有可统计的应验数据：先跑一场研讨产生反对条目，施工后再用 action=reconcile 对账。');
      }
      for (const row of stats.sages) {
        lines.push(`- ${row.sageName}（${row.sage}）应验 ${row.ratio}｜已证伪 ${row.notMaterialized}｜未验证 ${row.untested}｜${row.sample}`);
      }
      if (stats.orphanOids.length > 0) lines.push(`孤儿 oid（无对应 run 行）：${stats.orphanOids.join('、')}`);
      return lines.join('\n');
    },
  })));

  return disposers;
}
