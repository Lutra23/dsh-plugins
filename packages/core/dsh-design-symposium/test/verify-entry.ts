/**
 * Verification entry: everything `scripts/verify.mjs` exercises, bundled with
 * the Harness packages aliased away so it runs offline.
 *
 * Covered:
 *   1. configuration repair (clamping, dropping unusable sages, aliases, weights)
 *   2. `JUDGE_MODEL` / `JUDGE_PERSONA` parsing and precedence
 *   3. sensitive screening: redaction, NFKC folding, empty-matching-rule refusal
 *   4. cost attribution: exact match only, no day-total fallback
 *   5. cost-effectiveness ranking: unmeasured sages are excluded, not scored
 *   6. judge payload extraction from messy model output
 *   7. persona-file containment (no absolute path, no escape)
 *   8. Markdown escaping of model output
 *   9. a full 2-provider × 2-round discussion against mock providers
 *  10. a 429 mid-discussion: immediate stop, anomaly, partial report
 *  11. terminating a run: abort signal honoured, referee skipped, transcript still written
 *  12. continuing a finished run: rounds and transcript carry over
 *  13. chair convergence: unchaired keeps the transcript, nothing fabricated
 *  14. plugin wiring against a mock Cordis context
 *
 * @module dsh-design-symposium/test/verify-entry
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyEnvironmentOverrides,
  applyTier,
  defaultConfig,
  ensureOutputDir,
  normalizeConfig,
  parseChairModel,
  isSafePersonaFile,
  loadConfig,
  replaceBrief,
  resolveDshHome,
  resolveOutputDir,
  resolvePersona,
  resolvePersonaDir,
  resolvePersonaTarget,
  validateBrief,
  type SymposiumConfig,
} from '../src/config.js';
import { compileScanner, screen, foldForScan, analyzePattern, MAX_REJECTED_REPORTED } from '../src/sensitive.js';
import { buildChairPrompt } from '../src/chair.js';
import { SymposiumRun, participantCostsOf, type RunState, type Speech } from '../src/symposium.js';
import { attributeTurnCost, type CostSnapshot } from '../src/cost.js';
import {
  appendJournal,
  buildReconcileLine,
  buildRunLine,
  fulfillmentStats,
  objectionsOf,
  readJournal,
  runSummaries,
  JOURNAL_VERSION,
} from '../src/journal.js';
import { escapeMarkdown, summarizeLatency } from '../src/report.js';
import { apply as applyPlugin, Config as PluginConfig, name as pluginName } from '../src/index.js';

/** One named check result. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the mock provider does for one call. */
type MockBehaviour =
  | { kind: 'text'; text: string; outputTokens?: number }
  | { kind: 'http'; status: number; message?: string }
  | { kind: 'empty' };

/** Build an LLM stand-in driven by a per-call script. */
export function makeMockLlm(
  behaviour: (call: { provider: string; model: string; index: number; system?: string }) => MockBehaviour,
  onCall?: (call: { provider: string; model: string; index: number; system?: string }) => void,
) {
  let index = 0;
  return {
    calls: [] as { provider: string; model: string; system?: string; prompt: string }[],
    listProviders() {
      return [{ id: 'mock-alpha', name: 'Mock Alpha' }, { id: 'mock-beta', name: 'Mock Beta' }];
    },
    async listModels(provider: string) {
      return provider === 'mock-alpha'
        ? [{ provider, id: 'alpha-1', name: 'Alpha One' }]
        : [{ provider, id: 'beta-1', name: 'Beta One' }];
    },
    async resolveModelInfo(provider: string, model: string) {
      return { provider, id: model, name: model };
    },
    stream(options: { provider: string; model: string; system?: string; messages: { content: { text?: string }[] }[] }) {
      const prompt = options.messages
        .flatMap((message) => message.content)
        .map((block) => block.text ?? '')
        .join('\n');
      const call = { provider: options.provider, model: options.model, index: index++, system: options.system };
      this.calls.push({ provider: call.provider, model: call.model, system: options.system, prompt });
      onCall?.(call);
      const plan = behaviour(call);
      return (async function* generate() {
        if (plan.kind === 'http') {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: plan.message ?? `HTTP ${plan.status}`, code: 'PROVIDER_HTTP_ERROR', status: plan.status },
            },
          };
          return;
        }
        const text = plan.kind === 'empty' ? '' : plan.text;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        if (text.length > 0) yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 500, outputTokens: plan.kind === 'empty' ? 0 : (plan.outputTokens ?? 120) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** Configuration used by the engine scenarios. */
function scenarioConfig(outputDir: string): SymposiumConfig {
  const config = defaultConfig();
  config.brief = { topic: 'AI 该不该有情绪', background: '工程背景：这是一次测试研讨。' };
  config.maxRounds = 2;
  config.outputDir = outputDir;
  config.maxTokensPerTurn = 256;
  config.requestTimeoutMs = 5_000;
  config.tokenBudget = 1_000_000;
  config.chair.enabled = false;
  config.sages = [
    { id: 'alpha', name: '阿尔法', stance: '守护长期可维护性', duties: ['检查耦合'], provider: 'mock-alpha', model: 'alpha-1', persona: '你是尖刻的逻辑派。' },
    { id: 'beta', name: '贝塔', stance: '交付速度优先', duties: ['质疑过度设计'], provider: 'mock-beta', model: 'beta-1', persona: '你是暴躁的直觉派。' },
  ];
  return config;
}

/** A ledger snapshot literal. */
function snapshot(byKey: Record<string, number>, available = true): CostSnapshot {
  return { available, path: '/tmp/ledger.json', day: '2026-01-01', totalCost: 0, byKey };
}


/** Count live timer handles, to prove a finished run leaves none behind. */
function activeTimers(): number {
  const resources = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  if (typeof resources !== 'function') return 0;
  return resources().filter((entry) => entry === 'Timeout').length;
}

/**
 * Run every check.
 * @returns one result per check, in order.
 */
export async function runAllChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
  };

  // 1 — configuration repair.
  const repaired = normalizeConfig({
    maxRounds: 99,
    keepRecentRounds: -3,
    sensitiveThreshold: 0,
    sages: [
      { id: 'A B', name: 'A B', stance: 's', duties: ['d'], provider: 'p', model: 'm', persona: 'x' },
      { id: 'A B', name: '重名贤者', stance: 's', duties: [], provider: 'p', model: 'm2', persona: 'y' },
      { name: '没有模型', provider: 'p' },
      'garbage',
    ],
    providerAliases: { qwen: 'dashscope', '': 'x' },
  });
  record(
    '配置修复：轮数/阈值收敛、无模型席位保留、重名 id 自动改名、别名清理',
    repaired.maxRounds === 20 && repaired.keepRecentRounds === 0 && repaired.sensitiveThreshold === 1
      && repaired.sages.length === 4
      && repaired.sages[0]!.id === 'a-b'
      && repaired.sages[1]!.id === 'a-b-2'
      && repaired.sages[1]!.name === '重名贤者'
      && repaired.sages[2]!.model === ''
      && repaired.sages[3]!.name === '贤者 4'
      && Object.keys(repaired.providerAliases).length === 1,
    `maxRounds=${repaired.maxRounds} keep=${repaired.keepRecentRounds} threshold=${repaired.sensitiveThreshold} ids=${repaired.sages.map((entry) => entry.id).join(',')}`,  );

  // 1b — brief: nested pack, legacy topic migration, blind default.
  const briefFromRecord = normalizeConfig({ brief: { topic: '分层设计', background: '上游背景', materials: ['接口清单', '  '] } });
  const briefFromLegacy = normalizeConfig({ topic: '旧字段话题' });
  const blindDefault = defaultConfig().firstRoundBlind;
  record(
    '议题包：嵌套解析、旧 topic 字符串迁移、空材料剔除、首轮盲评默认开',
    briefFromRecord.brief.topic === '分层设计' && briefFromRecord.brief.background === '上游背景'
      && briefFromRecord.brief.materials?.length === 1
      && briefFromLegacy.brief.topic === '旧字段话题'
      && blindDefault === true,
    `record=${JSON.stringify(briefFromRecord.brief)} legacy=${briefFromLegacy.brief.topic} blind=${blindDefault}`,  );

  // 2 — JUDGE_MODEL / JUDGE_PERSONA.
  const parsedSlash = parseChairModel('dashscope/qwen3-max');
  const parsedColon = parseChairModel('dashscope:qwen3-max');
  const parsedBare = parseChairModel('qwen3-max');
  const overridden = applyEnvironmentOverrides(defaultConfig(), {
    chairModel: 'dashscope/qwen3-max',
    chairPersona: '你是主席',
    outputDir: '/tmp/out',
  });
  record(
    'JUDGE_MODEL 解析与环境覆盖',
    parsedSlash.provider === 'dashscope' && parsedSlash.model === 'qwen3-max'
      && parsedColon.provider === 'dashscope' && parsedColon.model === 'qwen3-max'
      && parsedBare.provider === '' && parsedBare.model === 'qwen3-max'
      && overridden.chair.provider === 'dashscope' && overridden.chair.model === 'qwen3-max'
      && overridden.chair.persona === '你是主席' && overridden.outputDir === '/tmp/out',
    `${JSON.stringify(parsedSlash)} / ${JSON.stringify(parsedColon)} / ${JSON.stringify(parsedBare)}`,
  );

  // 2b — an empty outputDir must not fall back to the host's working directory
  // (that was the profile directory, i.e. the system drive and a program folder).
  const blankOut = defaultConfig();
  blankOut.outputDir = '';
  const defaultOut = resolveOutputDir(blankOut);
  const relativeOut = defaultConfig();
  relativeOut.outputDir = 'reports';
  const resolvedRelative = resolveOutputDir(relativeOut);
  record(
    '输出目录：留空不再落到宿主工作目录，相对路径仍按工作目录解析',
    isAbsolute(defaultOut)
      && defaultOut === join(resolveDshHome(), 'symposium', 'reports')
      && resolvedRelative === resolve(process.cwd(), 'reports'),
    `default=${defaultOut} relative=${resolvedRelative}`,
  );
  // The directory is created on demand rather than assumed to exist.
  const outBase = mkdtempSync(join(tmpdir(), 'symposium-outdir-'));
  const freshOut = join(outBase, 'nested', 'deep', 'reports');
  let created = false;
  try {
    ensureOutputDir(freshOut);
    created = existsSync(freshOut);
  } catch (error) {
    record('输出目录：缺失时自动创建', false, (error as Error).message);
  }
  if (created) record('输出目录：缺失时自动创建', true, freshOut);

  // 3 — sensitive screening: redaction, folding, zero-width and ReDoS refusal.
  const scanner = compileScanner({
    builtin: true,
    words: ['内幕消息', 'ｓｅｘ'],
    patterns: [
      '(?i)secret\\s+plan',
      '未闭合的[正则',
      'a*',
      '(?i)',
      '\\s*',
      '\\bword\\b',
      'foo(?=bar)',
      '(?<=foo)bar',
      '(a+)+b',
      '(?:a*)*',
      '(\\w+)\\1',
    ],
  });
  const screened = screen(scanner, '这属于内幕消息，还有 a Secret Plan 在里面。');
  const folded = screen(scanner, '这里有 sex 字样。');
  const foldedRule = screen(scanner, '这里有 ｓｅｘ 字样。');
  const clean = screen(scanner, '今天天气不错，word 也只是普通词。');
  const rejectedSet = scanner.rejected.map((entry) => entry.rule).sort().join('|');
  record(
    '敏感过滤：替换、NFKC 折叠（词表与正文双向）、零宽与嵌套量词被拒',
    screened.redacted === true && screened.hits.length === 2
      && screened.text.includes('[内容已过滤]') && !screened.text.includes('内幕消息')
      // A zero-width rule must not spray the clean text or trip the threshold.
      && clean.redacted === false && clean.hits.length === 0 && clean.text.includes('word')
      && folded.redacted === true && folded.text.includes('[内容已过滤]')
      && foldedRule.redacted === true && foldedRule.text.includes('[内容已过滤]')
      && scanner.rejected.length === 10,
    `hits=${screened.hits.map((hit) => hit.rule).join('|')} rejected(${scanner.rejected.length})=${rejectedSet} clean=${clean.text}`,
  );

  // 3b — each refusal carries an operator-facing, specific reason.
  const reasonOf = (rule: string): string =>
    scanner.rejected.find((entry) => entry.rule === rule)?.reason ?? '';
  record(
    '敏感过滤：\\b / 前瞻 / 后顾 / 嵌套量词 / 反向引用各有明确拒绝理由',
    reasonOf('\\bword\\b').includes('零宽')
      && reasonOf('foo(?=bar)').includes('零宽')
      && reasonOf('(?<=foo)bar').includes('零宽')
      && reasonOf('(a+)+b').includes('嵌套量词')
      && reasonOf('(?:a*)*').includes('嵌套量词')
      && reasonOf('(\\w+)\\1').includes('反向引用')
      && analyzePattern('普通错误词').ok
      && analyzePattern('\\b').ok === false,
    `zeroWidth=${reasonOf('\\bword\\b')} nested=${reasonOf('(a+)+b')} backref=${reasonOf('(\\w+)\\1')}`,
  );

  // 3c — a pathological pattern is refused before it can run.
  const redosStart = Date.now();
  const redosScanner = compileScanner({ builtin: false, words: [], patterns: ['(a+)+b'] });
  const redosElapsed = Date.now() - redosStart;
  const redosHits = redosScanner.scan(`${'a'.repeat(5_000)}!`);
  record(
    'ReDoS：灾难性回溯正则被静态拒绝，宿主不被卡死',
    redosElapsed < 100 && redosScanner.ruleCount === 0 && redosHits.length === 0
      && redosScanner.rejected.length === 1,
    `elapsed=${redosElapsed}ms rules=${redosScanner.ruleCount} rejected=${redosScanner.rejected.length}`,
  );

  // 3b — the folding map keeps original offsets.
  const foldMap = foldForScan('ａb');
  const offsetsOk = foldMap.spans.length === 2
    && foldMap.spans[0]![0] === 0 && foldMap.spans[0]![1] === 1
    && foldMap.spans[1]![0] === 1 && foldMap.spans[1]![1] === 2;
  record(
    'Unicode 折叠保留原始偏移（按码点映射，不重写正文）',
    offsetsOk,
    JSON.stringify(foldMap.spans),
  );

  // 4 — cost attribution: exact match only, no day-total fallback.
  const matched = attributeTurnCost(
    snapshot({ 'p:a-1': 1, 'p:b-1': 5 }),
    snapshot({ 'p:a-1': 1.25, 'p:b-1': 5.5 }),
    'a-1',
  );
  const mixed = attributeTurnCost(
    snapshot({ 'p:a-1': 1 }),
    snapshot({ 'p:a-1': 1.4, 'wrapper:x': 0.2 }),
    'a-1',
  );
  const noLedger = attributeTurnCost(snapshot({}, false), snapshot({}), 'a-1');
  record(
    '花费归因：只认精确模型键，匹配不到就记 0 并标注',
    matched.cost === 0.25 && matched.status === 'matched'
      && Math.abs(mixed.cost - 0.4) < 1e-9 && mixed.status === 'matched'
        && mixed.unattributedKeys.join() === 'wrapper:x'
      && noLedger.cost === 0 && noLedger.status === 'no-ledger',
    `matched=${matched.cost}/${matched.status} mixed=${mixed.cost}/${mixed.status}/${mixed.unattributedKeys.join('|')} noLedger=${noLedger.status}`,
  );

  // 4b — a pure mismatch reports nothing attributed, never the day total.
  const pureMismatch = attributeTurnCost(
    snapshot({ 'p:a-1': 1 }),
    snapshot({ 'p:a-1': 1, 'wrapper:x': 0.9 }),
    'a-1',
  );
  record(
    '花费归因：有增量但匹配不到模型 → 归因失败，不做当日总额兜底',
    pureMismatch.cost === 0 && pureMismatch.status === 'unmatched'
      && pureMismatch.unattributedKeys.join() === 'wrapper:x',
    `cost=${pureMismatch.cost} status=${pureMismatch.status} keys=${pureMismatch.unattributedKeys.join('|')}`,
  );

  // 4c — a readable ledger with no movement is also "no data", not zero cost.
  const idleLedger = attributeTurnCost(snapshot({ 'p:a-1': 1 }), snapshot({ 'p:a-1': 1 }), 'a-1');
  record(
    '花费归因：账本可读但无增量 → 记为无账本口径，不当作 0 元',
    idleLedger.cost === 0 && idleLedger.status === 'no-ledger',
    `cost=${idleLedger.cost} status=${idleLedger.status}`,
  );

  // 4b — latency table: answered turns only, failures counted separately.
  const latencyRows = summarizeLatency([
    { participantId: 'a', name: 'A', provider: 'p', model: 'm', round: 1, text: 'x', status: 'ok', usage: { inputTokens: 10, outputTokens: 100 }, cost: 0, costStatus: 'measured', unattributedKeys: [], elapsedMs: 1000, sensitiveHits: 0, contextTokens: 0 },
    { participantId: 'a', name: 'A', provider: 'p', model: 'm', round: 2, text: 'x', status: 'ok', usage: { inputTokens: 10, outputTokens: 300 }, cost: 0, costStatus: 'measured', unattributedKeys: [], elapsedMs: 3000, sensitiveHits: 0, contextTokens: 0 },
    { participantId: 'a', name: 'A', provider: 'p', model: 'm', round: 3, text: '', status: 'timeout', usage: { inputTokens: 0, outputTokens: 0 }, cost: 0, costStatus: 'no-ledger', unattributedKeys: [], elapsedMs: 60000, sensitiveHits: 0, contextTokens: 0 },
    { participantId: 'b', name: 'B', provider: 'p', model: 'm', round: 1, text: '', status: 'empty', usage: { inputTokens: 0, outputTokens: 0 }, cost: 0, costStatus: 'no-ledger', unattributedKeys: [], elapsedMs: 900, sensitiveHits: 0, contextTokens: 0 },
  ] as Speech[]);
  const rowA = latencyRows.rows.find((row) => row.name === 'A');
  const rowB = latencyRows.rows.find((row) => row.name === 'B');
  record(
    '耗时表：失败的轮次不进平均值，单独计超时/空响应',
    rowA?.turns === 2 && rowA.averageMs === 2000 && rowA.timeouts === 1
      && rowA.tokensPerSecond === '100.0'
      && rowB?.turns === 0 && rowB.empties === 1
      && latencyRows.slowest?.elapsedMs === 3000,
    `A=${JSON.stringify(rowA)} B=${JSON.stringify(rowB)} 最慢=${JSON.stringify(latencyRows.slowest)}`,
  );

  // 5b — sages with no measured spend are listed with a reason.
  const speechesForCost = [
    { participantId: 'alpha', cost: 0.5, costStatus: 'measured', unattributedKeys: [] },
    { participantId: 'beta', cost: 0, costStatus: 'unmeasured', unattributedKeys: ['wrapper:x'] },
  ] as unknown as Speech[];
  const costs = participantCostsOf(speechesForCost, [
    { id: 'alpha', name: 'A', stance: '', duties: [], provider: 'p', model: 'a', persona: '' },
    { id: 'beta', name: 'B', stance: '', duties: [], provider: 'p', model: 'b', persona: '' },
    { id: 'gamma', name: 'C', stance: '', duties: [], provider: 'p', model: 'c', persona: '' },
  ]);
  record(
    '口径不可用：逐人标注原因，未测量者不计入总额',
    costs.alpha?.measured === true && costs.alpha?.cost === 0.5
      && costs.beta?.measured === false && typeof costs.beta?.reason === 'string'
      && costs.gamma?.measured === false,
    JSON.stringify(costs),
  );

  // 6 — the chair prompt asks for free Markdown, not a tagged-line DSL.
  const chairPromptProbe = buildChairPrompt({
    brief: { topic: '提示词契约', decisionPoints: [{ id: 'D1', title: '选型' }] },
    sages: [{ id: 'a', name: 'A', stance: 's', duties: [], provider: 'p', model: 'm', persona: '' }],
    speeches: [],
  }).prompt;
  record(
    '主席提示词是自由 Markdown 契约（不含标记行 DSL）',
    chairPromptProbe.includes('直接输出 Markdown 正文')
      && !chairPromptProbe.includes('【一致】')
      && !chairPromptProbe.includes('【ADR】')
      && !chairPromptProbe.includes('输出格式：每行一条'),
    `hasMarkdownAsk=${chairPromptProbe.includes('直接输出 Markdown 正文')} hasDsl=${chairPromptProbe.includes('【一致】') || chairPromptProbe.includes('输出格式：每行一条')}`,
  );

  // 7 — persona-file containment.
  const safeRelative = isSafePersonaFile('alice.md');
  const absoluteRejected = isSafePersonaFile('C:\\Windows\\System32\\drivers\\etc\\hosts');
  const posixRejected = isSafePersonaFile('/etc/passwd');
  const escapeRejected = isSafePersonaFile('../../secrets.md');
  const target = resolvePersonaTarget({
    id: 'alice', name: 'A', provider: 'p', model: 'm', persona: 'x',
    personaFile: 'C:\\Windows\\win.ini',
  });
  const personaDir = resolvePersonaDir();
  record(
    '人格文件限制：只接受 persona 目录内的相对路径',
    safeRelative && !absoluteRejected && !posixRejected && !escapeRejected
      && target.startsWith(personaDir)
      && target.endsWith('alice.md')
      && !target.toLowerCase().includes('windows'),
    `safe=${safeRelative} abs=${absoluteRejected} posix=${posixRejected} escape=${escapeRejected} target=${target}`,
  );

  // 8 — Markdown escaping of model output.
  const hostile = '# 标题\n| 注入 | 表格 |\n<script>alert(1)</script>\n- 列表\n[链接](http://x) ```js`';
  const escaped = escapeMarkdown(hostile);
  record(
    '战报转义：HTML 实体化 + Markdown 结构字符失效',
    escaped.includes('&lt;script&gt;') && !escaped.includes('<script>')
      && escaped.includes('\\#') && escaped.includes('\\|')
      && escaped.includes('\\`\\`\\`') && escaped.includes('\\[链接\\]')
      && escaped.includes('\\- 列表'),
    escaped.replace(/\n/g, '⏎'),
  );

  // 9 — a full mock discussion.
  const dirRoot = mkdtempSync(join(tmpdir(), 'symposium-verify-'));
  try {
    const config = scenarioConfig(dirRoot);
    const llm = makeMockLlm((call) => ({
      kind: 'text',
      text: `【${call.provider}】第 ${call.index + 1} 次发言：我反对。`,
      outputTokens: 40 + call.index,
    }));
    const run = new SymposiumRun({ llm: llm as never, config, log: () => {} }, config.brief);
    const timersBefore = activeTimers();
    const state: RunState = await run.execute();
    const timersAfter = activeTimers();
    const ok = state.rounds === 2 && state.speeches.length === 4 && state.status === 'done'
      && llm.calls.length === 4
      && state.reportPath !== undefined && existsSync(state.reportPath)
      && readFileSync(state.reportPath, 'utf8').includes('阿尔法')
      && readFileSync(state.reportPath, 'utf8').includes('贝塔')
      && state.costSource === 'unavailable'
      && state.speeches.every((speech) => speech.costStatus !== 'measured')
      && timersAfter <= timersBefore;
    record(
      '2 个 Provider × 2 轮：4 条发言、战报落盘、无残留定时器、无账本时口径不可用',
      ok,
      `rounds=${state.rounds} speeches=${state.speeches.length} status=${state.status} costSource=${state.costSource} report=${state.reportPath} timers=${timersBefore}->${timersAfter}`,
    );

    // 9b — blind first round, then full shared context; per-speaker persona.
    const secondPrompt = llm.calls[1]?.prompt ?? '';
    const thirdPrompt = llm.calls[2]?.prompt ?? '';
    record(
      '首轮盲评 + 次轮全量共享：本轮互不可见、第二轮起可见全部发言',
      !secondPrompt.includes('第 1 次发言')
        && thirdPrompt.includes('第 1 次发言') && thirdPrompt.includes('第 2 次发言')
        && (llm.calls[1]?.system ?? '').includes('暴躁的直觉派') === true,
      `blindFirst=${!secondPrompt.includes('第 1 次发言')} round2HasSpeaker1=${thirdPrompt.includes('第 1 次发言')} speaker2 system=${(llm.calls[1]?.system ?? '').slice(0, 14)}…`,
    );

    // 10 — 429 aborts the whole discussion.
    const failConfig = scenarioConfig(dirRoot);
    failConfig.maxRounds = 3;
    let callIndex = 0;
    const failing = makeMockLlm(() => {
      callIndex += 1;
      return callIndex === 3
        ? { kind: 'http', status: 429, message: 'Too Many Requests' }
        : { kind: 'text', text: `第 ${callIndex} 次发言`, outputTokens: 30 };
    });
    const stopped = await new SymposiumRun({ llm: failing as never, config: failConfig, log: () => {} }, failConfig.brief).execute();
    record(
      '429 致命错误：立即终止、记录异常、保留已完成部分',
      stopped.stopReason === 'fatal-error'
        && stopped.speeches.length >= 3
        && stopped.speeches.some((speech) => speech.status === 'error')
        && stopped.speeches.every((speech) => speech.round <= (stopped.speeches.find((item) => item.status === 'error')?.round ?? 0))
        && stopped.anomalies.some((anomaly) => anomaly.kind === '致命错误')
        && stopped.reportPath !== undefined
        && readFileSync(stopped.reportPath, 'utf8').includes('429'),
      `stopReason=${stopped.stopReason} speeches=${stopped.speeches.length} anomalies=${stopped.anomalies.length}`,
    );

    // 11 — user stop: real abort, referee skipped, transcript still written.
    const stopConfig = scenarioConfig(dirRoot);
    stopConfig.maxRounds = 4;
    stopConfig.chair.enabled = true;
    stopConfig.chair.provider = 'mock-alpha';
    stopConfig.chair.model = 'alpha-1';
    let handle: SymposiumRun | undefined;
    const stopping = makeMockLlm(
      (call) => ({ kind: 'text', text: `第 ${call.index + 1} 次发言`, outputTokens: 20 }),
      (call) => { if (call.index === 1) handle?.stop('user-stop'); },
    );
    handle = new SymposiumRun({ llm: stopping as never, config: stopConfig, log: () => {} }, stopConfig.brief);
    const stoppedState = await handle.execute();
    const judgeCalls = stopping.calls.filter((call) => (call.system ?? '').includes('裁判'));
    record(
      '终止讨论：AbortSignal 生效、跳过裁判、仍写战报',
      stoppedState.status === 'stopped' && stoppedState.stopReason === 'user-stop'
        && stoppedState.minutes === undefined
        && stoppedState.speeches.length >= 2 && stoppedState.speeches.length <= 3
        && stoppedState.reportPath !== undefined
        && judgeCalls.length === 0,
      `status=${stoppedState.status} reason=${stoppedState.stopReason} speeches=${stoppedState.speeches.length} judge=${stoppedState.minutes === undefined ? 'skipped' : 'ran'} report=${stoppedState.reportPath}`,
    );

    // 12 — continuing a finished run.
    const baseConfig = scenarioConfig(dirRoot);
    const baseLlm = makeMockLlm((call) => ({ kind: 'text', text: `第一场第 ${call.index + 1} 次`, outputTokens: 30 }));
    const base = await new SymposiumRun({ llm: baseLlm as never, config: baseConfig, log: () => {} }, baseConfig.brief).execute();
    const contLlm = makeMockLlm((call) => ({ kind: 'text', text: `续场第 ${call.index + 1} 次`, outputTokens: 30 }));
    const continuation = await new SymposiumRun(
      { llm: contLlm as never, config: baseConfig, log: () => {} },
      base.brief,
      { previousId: base.id, completedRounds: base.rounds, speeches: base.speeches, summary: base.summary },
    ).execute();
    const continuedPrompt = contLlm.calls[0]?.prompt ?? '';
    record(
      '续前讨论：轮次接续、上下文带入、报告标注来源',
      continuation.rounds === 4 && continuation.plannedRounds === 4
        && continuation.speeches.length === 8
        && continuation.continuedFrom === base.id
        && continuation.speeches[0]!.round === 1
        && continuation.speeches[4]!.round === 3
        && continuedPrompt.includes('第一场第 1 次')
        && continuation.reportPath !== undefined
        && readFileSync(continuation.reportPath, 'utf8').includes(base.id),
      `rounds=${continuation.rounds}/${continuation.plannedRounds} speeches=${continuation.speeches.length} continuedFrom=${continuation.continuedFrom} carriesTranscript=${continuedPrompt.includes('第一场第 1 次')}`,
    );

    // 15 — chair returns nothing: unchaired, transcript kept, nothing fabricated.
    const chairConfig = scenarioConfig(dirRoot);
    chairConfig.chair.enabled = true;
    chairConfig.chair.provider = 'mock-alpha';
    chairConfig.chair.model = 'alpha-1';
    let chairReply = '';
    const isChairCall = (call: { system?: string }): boolean => (call.system ?? '').includes('主席');
    const chairMock = makeMockLlm((call) => (isChairCall(call)
      ? { kind: 'text', text: chairReply }
      : { kind: 'text', text: '发言：原方案最稳。', outputTokens: 40 }));
    const unchairedRun = await new SymposiumRun({ llm: chairMock as never, config: chairConfig, log: () => {} }, chairConfig.brief).execute();
    const unchairedReport = unchairedRun.reportPath === undefined ? '' : readFileSync(unchairedRun.reportPath, 'utf8');
    record(
      '主席空返回：chaired=false + 纪要写明未产出 + 发言记录完整保留',
      unchairedRun.minutes !== undefined
        && unchairedRun.minutes.chaired === false
        && unchairedRun.minutes.raw === ''
        && (unchairedRun.minutes.note ?? '').length > 0
        && unchairedReport.includes('主席未产出纪要')
        && unchairedReport.includes('AI 主席自动收敛'),
      `chaired=${unchairedRun.minutes?.chaired} rawLen=${unchairedRun.minutes?.raw.length} note=${unchairedRun.minutes?.note}`,
    );

    // 15b — free Markdown minutes are kept verbatim, headings and all.
    chairReply = [
      '## 一致结论',
      '',
      '双方都认同保持零依赖。',
      '',
      '## 关键分歧',
      '',
      '- **缓存策略**：阿尔法主张 LRU；贝塔主张 TTL。',
      '',
      '## 建议决策',
      '',
      '先发 Markdown 纪要，再谈缓存。',
      '',
      '## 需要主人拍板',
      '',
      '缓存方案二选一。',
    ].join('\n');
    const goodChairMock = makeMockLlm((call) => (isChairCall(call)
      ? { kind: 'text', text: chairReply }
      : { kind: 'text', text: '发言：原方案最稳。', outputTokens: 40 }));
    const chairedRun = await new SymposiumRun({ llm: goodChairMock as never, config: chairConfig, log: () => {} }, chairConfig.brief).execute();
    const chairedReport = chairedRun.reportPath === undefined ? '' : readFileSync(chairedRun.reportPath, 'utf8');
    record(
      '主席自由 Markdown 原样保留：raw 与主席输出逐字相同、小节标题未被重排、报告里直接嵌原文',
      chairedRun.minutes?.chaired === true
        && chairedRun.minutes.raw === chairReply
        && chairedReport.includes('## 关键分歧')
        && chairedReport.includes('缓存方案二选一。')
        && !chairedReport.includes('### 一致点'),
      `chaired=${chairedRun.minutes?.chaired} rawEq=${chairedRun.minutes?.raw === chairReply} reportHasHeading=${chairedReport.includes('## 关键分歧')}`,
    );

    // 15 — a persona file outside the directory cannot be read or written. the directory cannot be read or written.
    mkdirSync(personaDir, { recursive: true });
    const outside = join(dirRoot, 'escape.md');
    writeFileSync(outside, 'SHOULD NOT BE READ', 'utf8');
    const escapeTarget = resolvePersonaTarget({
      id: 'mallory', name: 'M', provider: 'p', model: 'm', persona: 'inline', personaFile: outside,
    });
    const resolved = resolvePersona({
      id: 'mallory', name: 'M', provider: 'p', model: 'm', persona: 'inline', personaFile: outside,
    });
    record(
      '人格文件越权读取被拦截（绝对路径回落到 persona 目录内）',
      escapeTarget.startsWith(personaDir) && resolved === 'inline',
      `target=${escapeTarget} resolved=${resolved}`,
    );
  } finally {
    try {
      rmSync(dirRoot, { recursive: true, force: true });
    } catch {
      // A locked temp directory on Windows is not a verification failure.
    }
  }

  return results;
}

/**
 * Crash-path and referee-fidelity checks.
 *
 * R1: an unexpected exception used to skip the report, so "保留已完成部分" only
 * held for provider errors. R2: the referee used the inline persona while the
 * speaker performed the mirror file's version.
 * @returns one result per check.
 */
export async function runCrashPathChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
  };
  const dirRoot = mkdtempSync(join(tmpdir(), 'symposium-crash-'));

  try {
    // R1 — throw inside a turn after one speech was already recorded.
    const config = scenarioConfig(dirRoot);
    let personaReads = 0;
    const trapped = {
      id: 'beta', name: '贝塔', stance: '交付速度优先', duties: [], provider: 'mock-beta', model: 'beta-1',
    } as SageConfig & { persona: string };
    Object.defineProperty(trapped, 'persona', {
      enumerable: true,
      get() {
        personaReads += 1;
        // `resolvePersona` reads the inline persona twice per call, so beta sees
        // 2 reads in the preflight scan; its first turn starts at read 3, which is
        // already after 阿尔法 has spoken.
        if (personaReads >= 4) throw new Error('模拟内部异常');
        return '你是暴躁的直觉派。';
      },
    });
    config.sages = [
      { id: 'alpha', name: '阿尔法', stance: '守护长期可维护性', duties: [], provider: 'mock-alpha', model: 'alpha-1', persona: '你是尖刻的逻辑派。' },
      trapped,
    ];
    const llm = makeMockLlm((call) => ({ kind: 'text', text: `第 ${call.index + 1} 次发言`, outputTokens: 30 }));
    const run = await new SymposiumRun({ llm: llm as never, config, log: () => {} }, config.brief).execute();
    const report = run.reportPath === undefined ? '' : readFileSync(run.reportPath, 'utf8');
    record(
      '内部异常也写战报：failed + 保留已完成发言 + 记录内部错误',
      run.status === 'failed'
        && run.stopReason === 'internal-error'
        && run.speeches.length >= 1
        && run.reportPath !== undefined
        && report.includes('阿尔法')
        && report.includes('内部错误'),
      `status=${run.status} reason=${run.stopReason} speeches=${run.speeches.length} report=${run.reportPath}`,
    );

    // R2 — the chair must read the persona the speaker actually performed.
    const personaDir = resolvePersonaDir();
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'mirror.md'), '文件里的立场：守护可维护性，说话带刺。', 'utf8');
    const probe = buildChairPrompt({
      brief: { topic: '测试' },
      sages: [{
        id: 'mirror', name: '镜像贤者', stance: '内联的旧立场：完全不同的风格。', duties: [], provider: 'p', model: 'm',
        persona: '内联的旧人设：完全不同的风格。',
        personaFile: 'mirror.md',
      }],
      speeches: [],
    });
    record(
      '主席看到的是镜像文件内容，不是内联的旧文本',
      probe.prompt.includes('文件里的立场') && !probe.prompt.includes('内联的旧立场'),
      probe.prompt.split('\n').find((line) => line.includes('立场')) ?? '（没有立场行）',
    );
  } finally {
    try {
      rmSync(dirRoot, { recursive: true, force: true });
    } catch {
      // A locked temp directory on Windows is not a verification failure.
    }
  }

  return results;
}




/**
 * Wiring check: run the real `apply` against a mock Cordis context and report
 * everything it registered. Catches tool definitions the real registry would
 * refuse (`required: false` is rejected by the parameter DSL).
 * @returns one result.
 */
export async function runWiringCheck(): Promise<CheckResult> {
  const provided = new Map<string, unknown>();
  const tools: { name: string; parameters: Record<string, unknown> }[] = [];
  const promptSections: string[] = [];
  const injections: string[] = [];
  const failures: string[] = [];

  const base = {
    llm: {
      listProviders: () => [{ id: 'mock-alpha', name: 'Mock Alpha' }],
      listModels: async () => [],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
      stream: () => (async function* generate() { /* never called here */ })(),
    },
    get: () => undefined,
    provide: (key: string, value: unknown) => { provided.set(key, value); },
    inject(names: string[], callback: (ctx: unknown) => void) {
      injections.push(names.join(','));
      try {
        callback({
          tools: { register: (definition: { name: string; parameters: Record<string, unknown> }) => { tools.push(definition); return () => {}; } },
          systemPrompt: { section: (section: { name: string }) => { promptSections.push(section.name); return () => {}; }, getSectionOrder: () => 0 },
          effect: () => () => {},
        });
      } catch (error) {
        failures.push(`${names.join(',')}: ${(error as Error).message}`);
      }
      return () => {};
    },
  };

  try {
    await applyPlugin(base as never, { exposeTools: true, injectPromptSection: true, promptOrder: 1 });
  } catch (error) {
    failures.push(`apply: ${(error as Error).message}`);
  }

  const service = provided.get('symposium');
  const toolNames = tools.map((tool) => tool.name).sort().join(',');
  const optionalWithoutRequired = tools.every((tool) =>
    Object.values(tool.parameters).every((spec) => !('required' in (spec as object)) || (spec as { required?: unknown }).required === true));

  const ok = failures.length === 0
    && service !== undefined
    && tools.length === 6
    && toolNames === 'symposium_answer,symposium_config,symposium_journal,symposium_report,symposium_start,symposium_status'
    && optionalWithoutRequired
    && promptSections.includes('symposium:sages')
    && injections.includes('tools') && injections.includes('systemPrompt');

  return {
    name: '插件装配：服务注册 / 5 个工具 / prompt 段落 / 可选参数无 required:false',
    ok,
    detail: `provided=${[...provided.keys()].join(',')} tools=${toolNames} prompt=${promptSections.join(',')} inject=${injections.join('+')} failures=${failures.join(' | ') || '无'}`,
  };
}

/**
 * Chair minutes are free Markdown (post-DSL): the raw text survives verbatim,
 * nothing is re-parsed into per-decision slots, and the report embeds the
 * original headings instead of rebuilt ones.
 * @returns one result.
 */
export async function checkChairRawMinutes(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-chair-raw-'));
  try {
    const config = scenarioConfig(dir);
    config.maxRounds = 2;
    config.chair = { enabled: true, provider: 'mock-alpha', model: 'alpha-1', persona: '' };
    config.brief = {
      topic: '自由纪要',
      decisionPoints: [{ id: 'D1', title: '选型' }, { id: 'D2', title: '清理策略' }],
    };
    const minutesText = [
      '## 结论',
      '',
      'D1 用快照；D2 仍分裂，需要主人拍板。',
      '',
      '### 为什么 D2 分裂',
      '',
      '一方要删，一方要留。',
    ].join('\n');
    const isChairCall = (call: { system?: string }): boolean => (call.system ?? '').includes('主席');
    const llm = makeMockLlm((call) => ({
      kind: 'text',
      text: isChairCall(call) ? minutesText : '发言：我看可以。',
    }));
    const run = new SymposiumRun({ llm: llm as never, config, log: () => {} }, config.brief);
    const state = await run.execute();
    const minutes = state.minutes;
    const rawExact = minutes?.raw === minutesText;
    const noStructured = minutes !== undefined
      && !('perDecision' in minutes) && !('needsOwner' in minutes) && !('agreements' in minutes);
    const report = state.reportPath === undefined ? '' : readFileSync(state.reportPath, 'utf8');
    const embedded = report.includes('### 为什么 D2 分裂');
    const ok = minutes?.chaired === true && rawExact && noStructured && embedded;
    return {
      name: '主席纪要为自由 Markdown：raw 逐字保留、无结构化字段、报告原样嵌入主席小标题',
      ok,
      detail: `chaired=${minutes?.chaired} rawExact=${rawExact} noStructured=${noStructured} embedded=${embedded}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Hard token ceiling (P1.4): a blown budget must stop new rounds without
 * throwing away what was said, and the chair still runs (unlike user-stop).
 * @returns one result.
 */
export async function checkTierBudget(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-budget-'));
  try {
    const brief = { topic: '预算', decisionPoints: [{ id: 'D1', title: 'x' }] };
    const tooTight = scenarioConfig(dir);
    tooTight.brief = brief;
    tooTight.maxRounds = 4;
    tooTight.maxRunTokens = 1;
    const llmTight = makeMockLlm(() => ({ kind: 'text', text: '【裁决】D1 赞成：ok' }));
    const tight = await new SymposiumRun({ llm: llmTight as never, config: tooTight, log: () => {} }, brief).execute();
    const stopsBeforeAnyRound = tight.speeches.length === 0 && tight.stopReason === 'budget-exhausted';

    const oneRound = scenarioConfig(dir);
    oneRound.brief = brief;
    oneRound.maxRounds = 4;
    oneRound.maxRunTokens = 6_000;
    const llmOne = makeMockLlm(() => ({ kind: 'text', text: '【裁决】D1 赞成：ok' }));
    const run = await new SymposiumRun({ llm: llmOne as never, config: oneRound, log: () => {} }, brief).execute();
    const keepsFirstRound = run.speeches.length === 2 && run.stopReason === 'budget-exhausted';
    const notes = run.anomalies.some((anomaly) => anomaly.kind === '预算耗尽');
    const ok = stopsBeforeAnyRound && keepsFirstRound && notes;
    return {
      name: '档位硬顶：预算不足第一轮都不开、够一轮则跑完保留再停、异常记录写明预算耗尽',
      ok,
      detail: `tightSpeeches=${tight.speeches.length}/${tight.stopReason} oneRound=${run.speeches.length}/${run.stopReason} note=${notes}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fixed round count (post-matrix): with the ruling matrix gone there is no
 * trustworthy "converged" signal left, so a run speaks every planned round.
 * 【求证】 is the only marker still extracted.
 * @returns one result.
 */
export async function checkFixedRounds(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-rounds-'));
  try {
    const config = scenarioConfig(dir);
    config.maxRounds = 3;
    config.maxQuestions = 0;
    config.brief = {
      topic: '固定轮数',
      decisionPoints: [{ id: 'D1', title: '选型' }, { id: 'D2', title: '缓存策略' }],
    };
    const reply = '我的意见：D1 赞成，D2 修改。\n【求证】问题X\n【裁决】D1 赞成：这一行不该被解析';
    const llm = makeMockLlm(() => ({ kind: 'text', text: reply }));
    const run = new SymposiumRun({ llm: llm as never, config, log: () => {} }, config.brief);
    const state = await run.execute();
    const allRounds = state.rounds === 3 && state.speeches.length === 6;
    const noMatrix = !('matrix' in state);
    const questionOnly = state.speeches[0]?.questions?.length === 1;
    const noRulings = state.speeches.every((speech) => !('rulings' in speech));
    const verdictKept = state.speeches[0]?.text.includes('【裁决】') === true;
    const ok = allRounds && noMatrix && questionOnly && noRulings && verdictKept
      && state.stopReason === 'max-rounds';
    return {
      name: '固定跑满轮数：【求证】仍被抽出、【裁决】原样留在正文不再解析、状态无矩阵、3 轮全跑完',
      ok,
      detail: `rounds=${state.rounds}/${state.plannedRounds} speeches=${state.speeches.length} stop=${state.stopReason} `
        + `questions=${state.speeches[0]?.questions?.length} hasMatrix=${'matrix' in state} verdictKept=${verdictKept}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Prefix stability (P1.2): everything above `当前是第` must be byte-identical
 * between a seat's first and second turn, or the provider prefix cache never
 * hits and deep runs pay for the brief twice. Also pins the problem-only view.
 * @returns one result.
 */
export async function checkContextPrefixStability(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-prefix-'));
  const brief = {
    topic: '前缀稳定性',
    proposal: '草案正文-仅全场视野可见',
    decisionPoints: [{ id: 'D1', title: '选型', options: ['A', 'B'], lean: 'A' }],
    locked: ['锁定项'],
    invariants: ['不变量'],
    assumptions: [{ text: '假设一', verified: true }, { text: '假设二', verified: false }],
    rejected: [{ proposal: '旧方案', reason: '成本高' }],
  };
  const prefixOf = (prompt: string): string => {
    const at = prompt.indexOf('当前是第');
    return at >= 0 ? prompt.slice(0, at) : prompt;
  };
  try {
    const full = scenarioConfig(dir);
    full.brief = brief;
    full.maxRounds = 2;
    const llmFull = makeMockLlm(() => ({ kind: 'text', text: '【立场】坚持：理由' }));
    await new SymposiumRun({ llm: llmFull as never, config: full, log: () => {} }, full.brief).execute();
    const alphaPrompts = llmFull.calls.filter((call) => call.model === 'alpha-1').map((call) => call.prompt);
    const stable = alphaPrompts.length >= 2
      && prefixOf(alphaPrompts[0]) === prefixOf(alphaPrompts[1])
      && prefixOf(alphaPrompts[0]).length > 100;
    const showsDraft = (alphaPrompts[0] ?? '').includes('草案正文');

    const blind = scenarioConfig(dir);
    blind.brief = brief;
    blind.maxRounds = 1;
    blind.sages[0] = { ...blind.sages[0], view: 'problem-only' as const };
    const llmBlind = makeMockLlm(() => ({ kind: 'text', text: '【立场】坚持：理由' }));
    await new SymposiumRun({ llm: llmBlind as never, config: blind, log: () => {} }, blind.brief).execute();
    const blindPrompt = llmBlind.calls.find((call) => call.model === 'alpha-1')?.prompt ?? '';
    const hidesDraft = blindPrompt.length > 0 && !blindPrompt.includes('草案正文');
    const keepsPoints = blindPrompt.includes('D1 选型');

    const ok = stable && showsDraft && hidesDraft && keepsPoints;
    return {
      name: '上下文前缀稳定 + problem-only 视野：前缀逐字相同、全场视野见草案、problem-only 隐藏草案但保留决策点',
      ok,
      detail: `stable=${stable} prefixLen=${prefixOf(alphaPrompts[0] ?? '').length} showsDraft=${showsDraft} hidesDraft=${hidesDraft} keepsPoints=${keepsPoints}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Brief v2 contract: the agenda pack is the ceiling on review quality, so the
 * tier contract is enforced at startRun. Three cases pin the semantics.
 * @returns one result.
 */
export function checkBriefContract(): CheckResult {
  const dp = [{ id: 'D1', title: '存储选型' }];
  const quickOk = validateBrief({ topic: 't', decisionPoints: dp }, 'quick').length === 0;
  const quickNoDp = validateBrief({ topic: 't' }, 'quick').some((d) => d.includes('decisionPoints'));
  const standardMissing = validateBrief({ topic: 't', decisionPoints: dp }, 'standard');
  const namesMissing = ['proposal', 'locked', 'invariants', 'assumptions', 'rejected']
    .every((field) => standardMissing.some((d) => d.includes(field)));
  const standardDeclared = validateBrief({
    topic: 't',
    decisionPoints: dp,
    proposal: '',
    locked: [],
    invariants: [],
    assumptions: [],
    rejected: [],
  }, 'standard').length === 0;
  // The real path goes through normalizeConfig first; testing validateBrief on
  // a raw literal skipped that step and hid the "empty array = declared" bug.
  const declaredPack = {
    topic: 't',
    decisionPoints: dp,
    proposal: '',
    locked: [],
    invariants: [],
    assumptions: [],
    rejected: [],
  };
  const normalizedDeclared = validateBrief(normalizeConfig({ brief: declaredPack }).brief, 'standard');
  const badId = validateBrief({ topic: 't', decisionPoints: [{ id: 'X1', title: 'x' }] }, 'quick').some((d) => d.includes('D1'));
  const ok = quickOk && quickNoDp && namesMissing && standardDeclared && normalizedDeclared.length === 0 && badId;
  return {
    name: '议题包契约：quick 只要决策点 / standard 缺声明拒启动 / 空数组即声明（含 normalizeConfig 真实路径）/ 非法 id 被点名',
    ok,
    detail: `quickOk=${quickOk} quickNoDp=${quickNoDp} namesMissing=${namesMissing} standardDeclared=${standardDeclared} normalizedDeclared=${normalizedDeclared.length === 0 ? 'ok' : normalizedDeclared.join('|')} badId=${badId}`,
  };
}

/**
 * Agenda pack replacement: a supplied brief replaces the stored one whole.
 *
 * Regression for 2026-10-28: `mergeConfig` shallow-merges objects, so passing
 * only a new topic let the previous session's proposal/background ride along
 * and the chair minuted a plan review nobody had asked for.
 * @returns one result.
 */
export function checkBriefReplace(): CheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-brief-'));
  try {
    const path = join(dir, 'symposium.json');
    replaceBrief({ topic: '旧议题', proposal: 'OLD-PROPOSAL', background: 'OLD-BG' }, path);
    replaceBrief({ topic: '新议题', decisionPoints: [{ id: 'D1', title: 'x' }] }, path);
    const stored = loadConfig(path).brief;
    const fresh = stored.topic === '新议题';
    const noProposal = (stored.proposal ?? '') === '';
    const noBackground = (stored.background ?? '') === '';
    // And the merge path is still the merge path for everything else.
    const keptDecisionPoints = (stored.decisionPoints ?? []).length === 1;
    const ok = fresh && noProposal && noBackground && keptDecisionPoints;
    return {
      name: '议题包整包替换：新 brief 覆盖旧包，旧 proposal/background 不残留',
      ok,
      detail: `topic=${stored.topic} proposal=${JSON.stringify(stored.proposal ?? '')} background=${JSON.stringify(stored.background ?? '')} dps=${(stored.decisionPoints ?? []).length}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Chair budget guard: the convergence call must leave room for a reasoning
 * model. Measured 2026-10-27: a max-effort model burned 5426 tokens on
 * thinking alone and returned empty minutes under the old 3000 cap.
 * @returns one result.
 */
export function checkChairBudget(): CheckResult {
  const candidates = [
    join(process.cwd(), 'src', 'chair.ts'),
    join(process.cwd(), '..', 'src', 'chair.ts'),
    fileURLToPath(new URL('../../src/chair.ts', import.meta.url)),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    return { name: '主席输出预算：收敛调用 maxTokens ≥ 8000（满思考模型防掐死）', ok: false, detail: '找不到 src/chair.ts' };
  }
  const source = readFileSync(found, 'utf8');
  const match = source.match(/maxTokens:\s*(\d[\d_]*)/);
  const cap = match === null ? 0 : Number(match[1].replace(/_/g, ''));
  return {
    name: '主席输出预算：收敛调用 maxTokens ≥ 16000（满思考模型防 JSON 截断）',
    ok: cap >= 16_000,
    detail: `chair maxTokens=${cap}`,
  };
}

/**
 * Attribution wiring check: pins the call site to the model-specific cost wait.
 * @returns one result.
 */
export function checkModelCostWait(): CheckResult {
  const candidates = [
    join(process.cwd(), 'src', 'symposium.ts'),
    join(process.cwd(), '..', 'src', 'symposium.ts'),
    fileURLToPath(new URL('../../src/symposium.ts', import.meta.url)),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    return { name: '花费归因：等的是本模型那一笔，而不是「文件变过」', ok: false, detail: '找不到 src/symposium.ts' };
  }
  const source = readFileSync(found, 'utf8');
  const usesModelWait = source.includes('waitForModelCost(before, sage.model');
  const noStampWait = !source.includes('waitForLedger(beforeStamp');
  return {
    name: '花费归因：等的是本模型那一笔，而不是「文件变过」',
    ok: usesModelWait && noStampWait,
    detail: `模型级等待=${usesModelWait} 仍用文件戳=${!noStampWait}`,
  };
}

/**
 * Tier model overrides (#56): a cheap tier may force every seat onto one model
 * and swap the chair, and none of it may leak into the saved document.
 * @returns one result.
 */
export function checkTierModel(): CheckResult {
  const base = defaultConfig();
  base.sages = [
    { id: 'a', name: 'A', stance: 's', duties: [], provider: 'p1', model: 'm1', persona: '' },
    { id: 'b', name: 'B', stance: 's', duties: [], provider: 'p2', model: 'm2', persona: '' },
  ];
  base.chair = { ...base.chair, provider: 'pc', model: 'mc' };
  const withTiers = normalizeConfig({
    ...base,
    tiers: {
      quick: {
        rounds: 1, maxTokensPerTurn: 3072, maxTokens: 30_000, maxQuestions: 0,
        chair: { provider: 'glm-provider', model: 'glm-5.3' },
        seatModel: { provider: 'v4f-provider', model: 'wb2/flash' },
      },
    },
  });
  const run = applyTier(withTiers, 'quick', 0);
  const seatsMoved = run.sages.every((sage) => sage.provider === 'v4f-provider' && sage.model === 'wb2/flash');
  const chairMoved = run.chair.provider === 'glm-provider' && run.chair.model === 'glm-5.3';
  const docClean = withTiers.sages.every((sage) => sage.provider !== 'v4f-provider')
    && withTiers.chair.provider === 'pc';
  const rounds = run.maxRounds === 1 && run.maxRunTokens === 30_000;
  const explicitWins = applyTier(withTiers, 'quick', 3).maxRounds === 3;
  const standard = applyTier(withTiers, 'standard', 0);
  const standardKeepsSeats = standard.sages.every((sage) => sage.provider !== 'v4f-provider');
  const badBinding = normalizeConfig({ ...base, tiers: { quick: { chair: { provider: 'only-provider' } } } });
  const brokenDropped = badBinding.tiers.quick.chair === undefined;
  const ok = seatsMoved && chairMoved && docClean && rounds && explicitWins && standardKeepsSeats && brokenDropped;
  return {
    name: '档位模型覆盖：quick 全员换席位模型 + 主席换 glm、文档不被污染、显式 rounds 优先、坏绑定降级',
    ok,
    detail: `seats=${seatsMoved} chair=${chairMoved} doc=${docClean} rounds=${rounds} explicit=${explicitWins} `
      + `standard=${standardKeepsSeats} badDropped=${brokenDropped}`,
  };
}

/**
 * Journal without the matrix: objections are registered by hand as their own
 * line, reconcile is last-write-wins, the run summary counts them, and a sage
 * only gets a ratio from judged items — `不可用` until something is judged.
 * @returns one result.
 */
export function checkJournalManual(): CheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-journal-'));
  try {
    const path = join(dir, 'decisions.jsonl');
    const state = {
      id: 'abcdef1234567890',
      brief: { topic: '手动登记' },
      speeches: [{ participantId: 'alpha', name: '阿尔法' }],
    } as unknown as RunState;
    appendJournal(buildRunLine(state, 'quick'), path);
    appendJournal({
      type: 'objection',
      version: JOURNAL_VERSION,
      at: Date.now(),
      runId: 'abcdef1234567890',
      objection: {
        oid: 'abcdef12:alpha:D1', sage: 'alpha', sageName: '阿尔法', dp: 'D1', verdict: '否决', reason: '会丢状态',
      },
    }, path);
    const beforeRead = readJournal(path);
    const beforeStats = fulfillmentStats(beforeRead.lines);
    appendJournal(buildReconcileLine('abcdef12:alpha:D1', 'untested', '先挂起'), path);
    appendJournal(buildReconcileLine('abcdef12:alpha:D1', 'materialized', 'src/runs.ts:88'), path);
    const afterRead = readJournal(path);
    const afterStats = fulfillmentStats(afterRead.lines);
    const summaries = runSummaries(afterRead.lines);
    const collected = objectionsOf(afterRead.lines).length === 1;
    const unjudged = beforeStats.sages[0]?.ratio === '不可用';
    const lastWins = afterStats.sages[0]?.ratio === '1/1' && afterStats.sages[0]?.materialized === 1;
    const counted = summaries[0]?.objections === 1 && summaries[0]?.unreconciled === 0;
    const badLines = afterRead.badLines === 0;
    const ok = collected && unjudged && lastWins && counted && badLines;
    return {
      name: '决策日记手动链路：objection 行被汇总、未对账报「不可用」、同 oid 后者胜、runSummary 计入已对账',
      ok,
      detail: `collected=${collected} before=${beforeStats.sages[0]?.ratio} after=${afterStats.sages[0]?.ratio} `
        + `objections=${summaries[0]?.objections} unreconciled=${summaries[0]?.unreconciled} badLines=${afterRead.badLines}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * P2 pause/resume: a 【求证】 pauses the run, the answers come back as facts,
 * an unanswered question is recorded as `unverifiable`, and a persist failure
 * degrades to finishing the discussion instead of losing the questions.
 * @returns one result.
 */
export async function checkPauseResume(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-pause-'));
  try {
    const brief = { topic: '暂停', decisionPoints: [{ id: 'D1', title: 'x' }] };
    const asked = '【裁决】D1 赞成：ok\n【求证】问题一\n【求证】问题二';
    const quiet = '【裁决】D1 赞成：ok';

    const config = scenarioConfig(dir);
    config.maxRounds = 2;
    config.maxQuestions = 2;
    config.brief = brief;
    let persisted: RunState | undefined;
    const persistedStates: RunState[] = [];
    const llm = makeMockLlm((call) => ({ kind: 'text', text: call.index < 2 ? asked : quiet }));
    const run = new SymposiumRun({
      llm: llm as never,
      config,
      log: () => {},
      persist: (state) => { persisted = state; persistedStates.push(state); return true; },
    }, brief);
    const paused = await run.execute();
    const pauseOk = paused.status === 'awaiting-verification'
      && (paused.pendingQuestions?.length ?? 0) === 2
      && paused.pendingQuestions?.[0]?.qid === 'Q1'
      && paused.pendingQuestions?.[1]?.qid === 'Q2'
      && persisted?.status === 'awaiting-verification';

    const resumed = await run.resume([
      { qid: 'Q1', status: 'verified', finding: '事实一', evidence: 'src/x.ts:1', at: Date.now() },
    ]);
    const answered = (resumed.verifications ?? []).some((item) => item.qid === 'Q1' && item.status === 'verified');
    const unanswered = (resumed.verifications ?? []).some((item) => item.qid === 'Q2' && item.status === 'unverifiable');
    const injected = llm.calls.some((call) => call.prompt.includes('【已核实事实】'));
    const finished = resumed.status === 'done' && resumed.pendingQuestions?.length === 0;
    // The settled state must reach the file too, or the next boot recovers a corpse.
    const settledPersisted = persistedStates.some((item) => item.status === 'done');

    // Persist failure: the run must keep going, and the questions must survive
    // into the minutes instead of dying in memory.
    const broken = scenarioConfig(dir);
    broken.maxRounds = 2;
    broken.maxQuestions = 2;
    broken.brief = brief;
    const llmBroken = makeMockLlm((call) => ({ kind: 'text', text: call.index < 2 ? asked : quiet }));
    const degraded = await new SymposiumRun({
      llm: llmBroken as never,
      config: broken,
      log: () => {},
      persist: () => false,
    }, brief).execute();
    const degradedOk = degraded.status === 'done'
      && (degraded.pendingQuestions?.length ?? 0) === 0
      && degraded.anomalies.some((item) => item.kind === '落盘失败')
      && degraded.speeches.some((item) => (item.questions ?? []).includes('问题一'));

    const ok = pauseOk && answered && unanswered && injected && finished && settledPersisted && degradedOk;
    return {
      name: 'P2 求证暂停：暂停落盘 / 恢复注入已核实事实 / 未答按无法核实 / 落盘失败降级继续',
      ok,
      detail: `pause=${pauseOk} answered=${answered} unanswered=${unanswered} injected=${injected} `
        + `finished=${finished} settled=${settledPersisted} degraded=${degradedOk} `
        + `[st=${degraded.status} pq=${degraded.pendingQuestions?.length} `
        + `an=${degraded.anomalies.map((item) => item.kind).join('/')} `
        + `oq=${(degraded.minutes?.openQuestions ?? []).join('|').slice(0, 40)}]`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * P4 acceptance: model-grouped parallelism, same-round invisibility, plan mode.
 * @returns one result covering the three P4 contract points.
 */
export async function checkP4Topology(): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), 'symposium-p4-'));
  try {
    const config = scenarioConfig(dir);
    config.maxRounds = 2;
    config.maxQuestions = 0;
    config.chair.enabled = false;
    config.brief = { topic: '并行', decisionPoints: [{ id: 'D1', title: 'x' }] };
    config.sages = [
      { id: 'a1', name: '甲一', stance: 's', duties: [], provider: 'p', model: 'm1', persona: '' },
      { id: 'a2', name: '甲二', stance: 's', duties: [], provider: 'p', model: 'm1', persona: '' },
      { id: 'b1', name: '乙一', stance: 's', duties: [], provider: 'p', model: 'm2', persona: '' },
    ] as never;

    let inFlight = 0;
    let maxInFlight = 0;
    const perModel = new Map<string, number>();
    let maxPerModel = 0;
    const seen: { model: string; prompt: string; marker: string }[] = [];
    const llm = {
      calls: [] as unknown[],
      listProviders: () => [{ id: 'p', name: 'P' }],
      listModels: async () => [{ provider: 'p', id: 'm1', name: 'm1' }, { provider: 'p', id: 'm2', name: 'm2' }],
      resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
      stream(options: { model: string; messages: { content: { text?: string }[] }[] }) {
        const model = options.model;
        const prompt = options.messages.flatMap((message) => message.content).map((block) => block.text ?? '').join('\n');
        const marker = `MK${seen.length + 1}`;
        seen.push({ model, prompt, marker });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        perModel.set(model, (perModel.get(model) ?? 0) + 1);
        maxPerModel = Math.max(maxPerModel, perModel.get(model) ?? 0);
        return (async function* generate() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          inFlight -= 1;
          perModel.set(model, (perModel.get(model) ?? 1) - 1);
          const text = `${marker}【裁决】D1 赞成：ok`;
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };

    const run = new SymposiumRun({ llm: llm as never, config, log: () => {} }, config.brief);
    run.state.mode = 'plan';
    await run.execute();

    const parallelOk = maxInFlight === 2 && maxPerModel === 1;
    const round1 = seen.slice(0, 3);
    const invisOk = round1.every((entry) => round1.every((other) => !entry.prompt.includes(other.marker)));
    const round2 = seen.slice(3);
    const seesPrev = round2.length > 0
      && round2.every((entry) => round1.some((other) => entry.prompt.includes(other.marker)));
    const planRule = seen.some((entry) => entry.prompt.includes('施工顺序') || entry.prompt.includes('回滚'));

    // Post-DSL: the chair prompt is free Markdown in every mode, so plan mode
    // no longer asks for a 【风险】 triple — the risk discussion lives in prose.
    const chairPrompt = buildChairPrompt({
      brief: config.brief,
      sages: config.sages,
      speeches: run.state.speeches,
    }).prompt;
    const freeMarkdown = chairPrompt.includes('直接输出 Markdown 正文');
    const noMarkers = !chairPrompt.includes('【一致】')
      && !chairPrompt.includes('【ADR】')
      && !chairPrompt.includes('输出格式：每行一条');

    const ok = parallelOk && invisOk && seesPrev && planRule && freeMarkdown && noMarkers;
    return {
      name: 'P4 拓扑：组间并行/组内串行、同轮互不可见、plan 模式发言规则、主席提示词为自由 Markdown',
      ok,
      detail: `parallel=${maxInFlight}/${maxPerModel} invis=${invisOk} seesPrev=${seesPrev} `
        + `planRule=${planRule} freeMarkdown=${freeMarkdown} noMarkers=${noMarkers} calls=${seen.length}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
