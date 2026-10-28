/**
 * The chair: reads the full transcript and writes the design minutes.
 *
 * A symposium has no winners — its deliverable is a decision record. The chair
 * writes that record as free Markdown and the program keeps it verbatim: the
 * readers are the main model and the owner, not a parser. An earlier version
 * forced the chair through a tagged-line DSL so the engine could rebuild a
 * structured verdict matrix; that layer only ever produced failure modes (one
 * missing `｜` dropped a whole point) and flattened multi-dimensional review
 * into a three-way slot. When the chair call fails or returns nothing, the
 * outcome is `chaired: false`: the transcript is kept whole and no verdict is
 * fabricated.
 *
 * @module dsh-design-symposium/chair
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { callModel, userMessage } from './providers.js';
import { resolvePersona, type Brief, type SageConfig } from './config.js';
import type { Speech } from './symposium.js';

/** Whether a participant's spend was measured, failed attribution, or no ledger. */
export type CostStatus = 'measured' | 'unmeasured' | 'no-ledger';

/** Per-sage cost data, including which sages have none. */
export interface ParticipantCost {
  cost: number;
  measured: boolean;
  /** Speaking turns this sage actually took. */
  turns: number;
  /** Turns whose spend was matched to a ledger key. */
  measuredTurns: number;
  /** Why the spend could not be attributed, when it could not. */
  reason?: string;
  /** Ledger keys seen during this sage's turns that matched no model. */
  unattributedKeys: string[];
}

/**
 * The minutes, exactly as the chair wrote them.
 *
 * `raw` is the deliverable. Nothing downstream re-parses it: the report embeds
 * it, the panel renders it, the main model reads it. Sections, headings and
 * emphasis are the chair's editorial call, not a contract.
 */
export interface ChairOutcome {
  /** `false` → the chair produced nothing usable; transcript kept, nothing fabricated. */
  chaired: boolean;
  /** Why the chair did not produce minutes, when it did not. */
  note?: string;
  provider: string;
  model: string;
  /** When the chair ran; 0 when it never ran. */
  at: number;
  /** The chair's Markdown minutes, verbatim. Empty when unchaired. */
  raw: string;
  /** Unanswered 【求证】 questions, deduped — the one marker that drives state. */
  openQuestions: string[];
  /** Cost kept as an appendix; never a ranking. */
  costSource: 'ledger' | 'partial' | 'unavailable';
  unmeasured: { participantId: string; name: string; reason: string }[];
  transcriptDroppedChars: number;
  elapsedMs: number;
}

export const AI_CHAIR_DISCLAIMER = '本纪要由 AI 主席自动收敛，可能存在错误，不构成权威结论。';

/** Longest transcript (chars) handed to the chair; the tail is kept preferentially. */
const CHAIR_TRANSCRIPT_MAX_CHARS = 60_000;
/** Longest single speech (chars) inside that transcript. */
const CHAIR_SPEECH_MAX_CHARS = 4_000;

export const DEFAULT_CHAIR_PERSONA = [
  '你是设计研讨会的主席。你的职责不是评判谁讲得好，而是把一场多立场研讨收敛成可执行的决策记录：',
  '- 一致点：哪些结论得到了多方认同，凭什么；',
  '- 分歧：哪些问题仍无共识，双方各自的论点是什么，你建议怎么解；',
  '- 否决：哪些方案被明确否决，理由与提出者；',
  '- 建议决策：下一步做什么，依据与前置条件；',
  '- 术语：讨论中被赋予特定含义的词，给出定义。',
  '你必须忠于发言记录：不虚构没人说过的观点，不替贤者弥合分歧。宁可如实呈现分歧，不可假装收敛。',
  '直接写 Markdown 正文，不要机器标记行、不要 JSON、不要用代码块包住全文。',
].join('\n');

/**
 * Build the chair's prompt: the brief, the roster with stances and duties, and
 * the transcript (tail-preferred).
 */
export function buildChairPrompt(options: {
  brief: Brief;
  sages: readonly SageConfig[];
  speeches: readonly Speech[];
}): { prompt: string; droppedChars: number } {
  const roster = options.sages.map((sage) => {
    // The chair must read the persona/立场 the speaker actually performed:
    // resolvePersona prefers the mirrored file over inline text, same as speak().
    const performed = resolvePersona(sage).trim();
    const stance = performed.length > 0 ? performed : sage.stance.trim();
    const duties = sage.duties.length > 0 ? sage.duties.join('；') : '（未指定）';
    return `- ${sage.name}（${sage.provider}/${sage.model}）\n  立场：${stance.length > 0 ? stance.replace(/\s+/g, ' ').slice(0, 300) : '（未声明）'}\n  职责：${duties}`;
  }).join('\n');

  const rendered = options.speeches.map((speech) => {
    const label = speech.status === 'ok' ? '' : `（${speech.status}${speech.note !== undefined ? `：${speech.note}` : ''}）`;
    const body = speech.text.length > CHAIR_SPEECH_MAX_CHARS
      ? `${speech.text.slice(0, CHAIR_SPEECH_MAX_CHARS)}\n…（本条超长，已截断）`
      : speech.text;
    return `[第 ${speech.round} 轮 · ${speech.name}]${label}\n${body}`;
  });
  const kept: string[] = [];
  let used = 0;
  let droppedChars = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index] ?? '';
    if (used + block.length > CHAIR_TRANSCRIPT_MAX_CHARS) {
      droppedChars += block.length;
      continue;
    }
    kept.unshift(block);
    used += block.length + 2;
  }
  const transcript = kept.join('\n\n');

  const prompt = [
    `【议题包】`,
    `议题：${options.brief.topic}`,
    ...(options.brief.background !== undefined && options.brief.background.trim().length > 0
      ? ['背景：', options.brief.background.trim()]
      : []),
    ...(options.brief.decisionPoints !== undefined && options.brief.decisionPoints.length > 0
      ? ['决策点：', ...options.brief.decisionPoints.map((point) => `- ${point.id} ${point.title}`)]
      : []),
    '',
    '贤者名单（立场与职责）：',
    roster,
    '',
    '完整发言记录（按发言顺序）：',
    droppedChars > 0 ? `（较早的 ${droppedChars} 字因超出预算未附上，请基于可见部分收敛）` : '',
    transcript.length > 0 ? transcript : '（无有效发言）',
    '',
    '任务：根据上面全部贤者的发言，撰写本场设计研讨会的纪要。',
    '要求：',
    '- 直接输出 Markdown 正文，不要写任何机器标记行、竖线字段或 JSON；不要用代码块包裹全文。',
    '- 按你的判断组织结构，把真正有信息量的东西写清楚。通常需要覆盖：达成了哪些一致、关键分歧在哪几方之间（逐方列论点）、哪些方案被否决及其理由、术语在讨论中被赋予了什么含义、建议的决策及其依据、哪些点必须由主人拍板（附可选项）、以及一段收尾总结。',
    '- 如果议题包里有决策点，逐点给出你的判断；意见确实分裂的地方如实说明分裂在哪，不要为了整齐而假装收敛。',
    '- 这是草案评审纪要，不是判决书：保留争议的层次，不要把多维的分条意见压成一个结论。',
    '- 贤者名必须来自上面的名单，不许虚构。',
  ].filter((line) => line !== '').join('\n');
  return { prompt, droppedChars };
}

/**
 * Run the chair and keep its minutes verbatim.
 * @returns the outcome; a failed or empty chair yields `chaired: false` with an
 *   empty `raw` — never fabricated minutes.
 */
export async function runChair(
  llm: LlmRuntime,
  options: {
    brief: Brief;
    provider: string;
    model: string;
    persona: string;
    sages: readonly SageConfig[];
    speeches: readonly Speech[];
    /** Cost data per sage id, appendix only. */
    costByParticipant: Record<string, ParticipantCost>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ChairOutcome> {
  const elapsed = { value: 0 };
  let raw = '';
  let note: string | undefined;
  let chairedAt = 0;
  let promptDroppedChars = 0;
  if (options.signal?.aborted !== true) {
    const built = buildChairPrompt({
      brief: options.brief,
      sages: options.sages,
      speeches: options.speeches,
    });
    promptDroppedChars = built.droppedChars;
    chairedAt = Date.now();
    const outcome = await callModel(llm, {
      provider: options.provider,
      model: options.model,
      system: options.persona.trim().length > 0 ? options.persona : DEFAULT_CHAIR_PERSONA,
      messages: [userMessage(built.prompt)],
      maxTokens: 24_000,
      temperature: 0.2,
      ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
      ...options.signal !== undefined ? { signal: options.signal } : {},
    });
    elapsed.value = outcome.elapsedMs;
    if (outcome.ok) {
      raw = outcome.text.trim();
      if (raw.length === 0) {
        note = '主席返回空内容，本场按未收敛处理';
      }
    } else {
      note = `主席调用失败（${outcome.kind}）：${outcome.message}`;
    }
  } else {
    note = '研讨已被终止，未运行主席';
  }

  const knownPoints = new Set((options.brief.decisionPoints ?? []).map((point) => point.id));
  const openQuestions = [...new Set([
    ...options.speeches.flatMap((speech) => speech.questions ?? []),
  ])].filter((question) => question.trim().length > 0);

  const unmeasured = options.sages
    .filter((sage) => options.costByParticipant[sage.id]?.measured !== true)
    .map((sage) => ({
      participantId: sage.id,
      name: sage.name,
      reason: options.costByParticipant[sage.id]?.reason ?? '账本不可读或未安装 dsh-cost-meter',
    }));
  const measuredCount = options.sages.length - unmeasured.length;
  const costSource: ChairOutcome['costSource'] = measuredCount === 0
    ? 'unavailable'
    : measuredCount === options.sages.length ? 'ledger' : 'partial';

  const chaired = raw.length > 0;
  return {
    chaired,
    ...note !== undefined ? { note } : {},
    provider: options.provider,
    model: options.model,
    at: chairedAt,
    raw: chaired ? raw : '',
    openQuestions,
    costSource,
    unmeasured,
    transcriptDroppedChars: promptDroppedChars,
    elapsedMs: elapsed.value,
  };
}
