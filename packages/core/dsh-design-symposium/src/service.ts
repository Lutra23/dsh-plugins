/**
 * The plugin's Host operations, shared by the agent tools.
 *
 * Every operation is implemented here exactly once and exposed only as agent
 * tools in `tools.ts` — the tool surface is the single code path (the upstream
 * settings page and its Remote binding were removed with the rebrand).
 *
 * One constraint is load-bearing and must survive future edits:
 *   - every method returns JSON-serializable data, because tool results travel
 *     through the tool-result wire.
 *
 * @module dsh-design-symposium/service
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import {
  applyEnvironmentOverrides,
  ensurePersonaFiles,
  loadConfig,
  mergeConfig,
  replaceBrief,
  readEnvironmentOverrides,
  resolveDshHome,
  applyTier,
  resolveConfigPath,
  resolveOutputDir,
  resolvePersona,
  resolvePersonaDir,
  validateBrief,
  type Brief,
  type BriefTier,
  type BriefMode,
  type SymposiumConfig,
} from './config.js';
import { latestPausedRun, markInterrupted, persistRun } from './runs.js';
import {
  appendJournal,
  buildRunLine,
  fulfillmentStats,
  objectionsOf,
  readJournal,
  resolveJournalPath,
  runSummaries,
  buildRulingLine,
  buildReconcileLine,
  JOURNAL_VERSION,
  type ReconcileOutcome,
} from './journal.js';
import { renderPanelHtml } from './panel.js';
import {
  loadProviderCatalog,
  probeProvider,
  resolveTarget,
  type ProviderOption,
} from './providers.js';
import { compileScanner, screen } from './sensitive.js';
import { readCostSnapshot, resolveLedgerPath } from './cost.js';
import {
  SymposiumRun,
  participantCostsOf,
  type PendingQuestion,
  type RunState,
  type RunnerDeps,
  type Verification,
} from './symposium.js';
import { buildMarkdownReport, renderMarkdownReport } from './report.js';
import { runChair, type ChairOutcome } from './chair.js';

/** What the settings page and the tools both read. */
export interface SymposiumStateView {
  /** Current persisted configuration, after environment overrides. */
  config: SymposiumConfig;
  /** Live provider catalogue from the Harness LLM service. */
  providers: ProviderOption[];
  /** The last or currently running discussion, when there is one. */
  run?: RunState;
  /** Whether a discussion is in flight. */
  running: boolean;
  /** Where a discussion would be judged: the resolved target after env overrides. */
  resolvedChair?: { provider: string; model: string };
  /** Where the ledger was read from, and whether it was found. */
  ledger: { path: string; available: boolean; error?: string };
  /** Absolute path of the persisted document. */
  configPath: string;
  /** Absolute path of the persona mirror directory. */
  personaDir: string;
}

/** Per-run logger, kept as a field so tests can silence it. */
export type LogSink = (line: string) => void;

/** Operations the UI actions and the tools both call. */
export class SymposiumEndpoints {
  private readonly hostCtx: Context;
  private readonly llm: LlmRuntime;
  private readonly log: LogSink;
  private current: SymposiumRun | undefined;
  private lastRun: RunState | undefined;
  /** The run parked on 【求证】 answers, if any (P2). */
  private pausedRun: SymposiumRun | undefined;
  /** Run ids already written to the decision journal (P3). */
  private readonly journaled = new Set<string>();

  /** Deps for one run: persistence rides here so the engine never touches fs. */
  private runnerDeps(config: SymposiumConfig): RunnerDeps {
    return {
      llm: this.llm,
      config,
      log: this.log,
      persist: (state: RunState) => {
        try {
          persistRun(state);
          this.writePanelSnapshot(state);
          return true;
        } catch (error) {
          console.warn(`[symposium] 运行状态写盘失败：${(error as Error).message}`);
          return false;
        }
      },
    };
  }
  private cachedProviders: ProviderOption[] = [];
  private providersAt = 0;

  constructor(ctx: Context, llm: LlmRuntime, log: LogSink = (line) => console.log(line)) {
    this.hostCtx = ctx;
    this.llm = llm;
    this.log = log;
  }

  /** Load the stored document with environment overrides applied. */
  private config(): SymposiumConfig {
    return applyEnvironmentOverrides(loadConfig(), readEnvironmentOverrides());
  }

  /**
   * Providers are cached for five seconds: the settings page polls this method
   * while a discussion runs, and re-enumerating every route's model list on
   * every tick would hit every gateway on every poll.
   */
  private async providers(force = false): Promise<ProviderOption[]> {
    const now = Date.now();
    if (!force && this.cachedProviders.length > 0 && now - this.providersAt < 5_000) {
      return this.cachedProviders;
    }
    this.cachedProviders = await loadProviderCatalog(this.llm, this.config().providerAliases);
    this.providersAt = now;
    return this.cachedProviders;
  }

  /** Resolve the referee, honouring `CHAIR_MODEL` and the qwen-by-default rule. */
  private async chairTarget(config: SymposiumConfig): Promise<{ provider: string; model: string } | undefined> {
    if (!config.chair.enabled) return undefined;
    return resolveTarget(
      this.llm,
      { provider: config.chair.provider, model: config.chair.model },
      config.providerAliases,
    );
  }

  /** The run the settings page should display, live one first. */
  private visibleRun(): RunState | undefined {
    return this.current?.state ?? this.lastRun;
  }

  /**
   * Everything the settings page renders.
   * @returns the configuration, provider catalogue, and run status.
   */
  async getState(): Promise<SymposiumStateView> {
    // Disk truth and the resolved view are two different things. `config` is
    // what is actually stored — the form must round-trip it, so a save cannot
    // silently bake an environment override (CHAIR_MODEL, an env output dir) into
    // symposium.json. The resolved referee is reported separately.
    const config = loadConfig();
    const effective = applyEnvironmentOverrides(config, readEnvironmentOverrides());
    const providers = await this.providers();
    const resolvedChair = await this.chairTarget(effective);
    const ledger = readCostSnapshot();
    const run = this.visibleRun();
    return {
      config,
      providers,
      ...run !== undefined ? { run } : {},
      running: this.current !== undefined,
      ...resolvedChair !== undefined ? { resolvedChair } : {},
      ledger: {
        path: resolveLedgerPath(),
        available: ledger.available,
        ...ledger.error !== undefined ? { error: ledger.error } : {},
      },
      configPath: resolveConfigPath(),
      personaDir: resolvePersonaDir(),
    };
  }

  /**
   * Re-enumerate providers, bypassing the cache.
   * @returns the refreshed catalogue.
   */
  async refreshProviders(): Promise<ProviderOption[]> {
    return this.providers(true);
  }

  /**
   * Probe one provider route.
   * @param provider - the route to test.
   * @returns whether it answered and how many models it advertised.
   */
  async testProvider(provider: string): Promise<{ ok: boolean; models: number; message: string }> {
    return probeProvider(this.llm, provider);
  }

  /**
   * Merge a patch into the stored document and persist it.
   * @param patch - partial document from the settings page.
   * @returns the merged document with environment overrides applied.
   */
  async saveConfig(patch: unknown): Promise<SymposiumConfig> {
    // Return exactly what was written. Applying the environment overrides here
    // would feed a merged view back into the form, and the next save would then
    // persist an override the user never typed.
    return mergeConfig(patch);
  }

  /**
   * Re-read the document from disk, discarding unsaved in-memory edits.
   * @returns the reloaded document.
   */
  async reloadConfig(): Promise<SymposiumConfig> {
    return this.config();
  }

  /**
   * Screen a passage so the settings page can show what the current word list
   * actually catches.
   * @param text - the passage to screen.
   * @param words - the word list being edited, when it differs from the saved one.
   * @param patterns - the pattern list being edited, likewise.
   * @returns the matched rules, the redacted result, and the active rule count.
   */
  async scanPreview(
    text: string,
    words?: string[],
    patterns?: string[],
  ): Promise<{
    hits: string[];
    redacted: string;
    ruleCount: number;
    rejected: string[];
    timedOut: string[];
  }> {
    const config = this.config();
    const scanner = compileScanner({
      builtin: config.sensitive.builtin,
      // The page passes what is currently in the form, so a preview reflects
      // unsaved edits instead of the last saved policy.
      words: Array.isArray(words) ? words.map(String) : config.sensitive.words,
      patterns: Array.isArray(patterns) ? patterns.map(String) : config.sensitive.patterns,
    });
    const result = screen(scanner, text);
    return {
      hits: [...new Set(result.hits.map((hit) => hit.rule))],
      redacted: result.text,
      ruleCount: scanner.ruleCount,
      // Flatten to display strings here: the reason belongs next to the rule on
      // the settings page, and the wire only carries JSON.
      rejected: scanner.rejected.map((entry) => `${entry.rule}（${entry.reason}）`),
      timedOut: [...scanner.timedOut],
    };
  }

  /**
   * Start a discussion and return immediately.
   *
   * The run continues in the background: the settings page polls
   * {@link getState} for progress, and the `symposium_start` tool waits on the
   * same run through {@link whenRunSettles}.
   * @param topic - topic override; empty keeps the stored topic.
   * @param rounds - round override; 0 keeps the stored value.
   * @returns the new run's initial state.
   * @throws when a discussion is already running or no sage is configured.
   */
  async startRun(
    brief: Brief | string,
    rounds: number,
    tier: BriefTier = 'quick',
    mode: BriefMode = 'design',
  ): Promise<RunState> {
    if (this.pausedRun !== undefined) {
      throw new Error('有一场研讨正在等待求证答案：请先用 symposium_answer 回答（或 finish=true 收尾），再开新场。');
    }
    if (this.current !== undefined) {
      throw new Error('已有一场研讨正在进行，请先终止或等待结束。');
    }
    let config = this.config();
    // A bare topic string is wrapped into a minimal brief — the tool layer
    // passes whichever shape the caller provided.
    const normalized: Brief = typeof brief === 'string' ? { topic: brief.trim() } : brief;
    // A supplied agenda pack replaces the stored one WHOLE. Field-wise merging
    // let a previous session's proposal ride into a new topic and the chair
    // minuted a subject nobody asked about (2026-10-28).
    if ((normalized.topic ?? '').trim().length > 0) {
      config = replaceBrief(normalized);
    }
    if (typeof rounds === 'number' && rounds > 0 && rounds !== config.maxRounds) {
      config = mergeConfig({ maxRounds: Math.min(20, Math.max(1, Math.trunc(rounds))) });
    }
    config = applyEnvironmentOverrides(config, readEnvironmentOverrides());
    if (config.sages.length === 0) {
      throw new Error('还没有配置任何贤者，请先在 symposium.json 的 sages 中添加席位。');
    }
    // Apply the tier after the brief/rounds patch: the tier supplies defaults,
    // an explicit `rounds` argument still wins. Model overrides inside the tier
    // are per-run only — the saved document keeps the owner's seat bindings.
    config = applyTier(config, tier, rounds, this.log);
    // The agenda pack is the ceiling on review quality: refuse to start when
    // the tier contract is not met, rather than letting sages review a brief
    // whose load-bearing sections were never written down.
    const defects = validateBrief(config.brief, tier, mode);
    if (defects.length > 0) {
      throw new Error(
        `议题包不满足 ${tier} 档契约，拒绝启动：\n- ${defects.join('\n- ')}\n`
        + '（quick 档只要求 topic + decisionPoints；standard/deep 还要求显式声明 '
        + 'proposal / locked / invariants / assumptions / rejected，无内容给空数组）',
      );
    }
    ensurePersonaFiles(config);
    const run = new SymposiumRun(this.runnerDeps(config), config.brief);
    run.state.tier = tier;
    run.state.mode = mode;
    return this.launch(run);
  }

  /**
   * Continue the last finished discussion for more rounds.
   *
   * The new run is seeded with the previous transcript and digest, so round
   * numbering, shared context and the closing report all describe one debate
   * rather than two unrelated ones. It is never a resume of a killed process:
   * only a finished run in this session can be continued.
   * @param rounds - additional rounds; 0 or negative uses the stored `maxRounds`.
   * @returns the new run's initial state.
   * @throws when a discussion is running or there is nothing to continue.
   */
  async continueRun(rounds: number): Promise<RunState> {
    if (this.current !== undefined) {
      throw new Error('已有一场讨论正在进行，请先终止或等待结束。');
    }
    const previous = this.lastRun;
    if (previous === undefined) throw new Error('还没有可以续接的讨论记录。');
    if (previous.speeches.length === 0) throw new Error('上一场没有任何发言，无法续接。');
    let config = this.config();
    const extra = typeof rounds === 'number' && rounds > 0 ? Math.min(20, Math.trunc(rounds)) : config.maxRounds;
    if (extra !== config.maxRounds) config = mergeConfig({ maxRounds: extra });
    config = applyEnvironmentOverrides(config, readEnvironmentOverrides());
    if (config.sages.length === 0) {
      throw new Error('还没有配置任何贤者，请先在 symposium.json 的 sages 中添加席位。');
    }
    ensurePersonaFiles(config);
    const run = new SymposiumRun(this.runnerDeps(config), previous.brief, {
      previousId: previous.id,
      completedRounds: previous.rounds,
      speeches: previous.speeches,
      summary: previous.summary,
    });
    run.state.tier = previous.tier ?? config.defaultTier;
    run.state.mode = previous.mode ?? 'design';
    return this.launch(run);
  }

  /** Wire a run into the background driving and the visible-state slot. */
  private launch(run: SymposiumRun): RunState {
    this.current = run;
    this.lastRun = run.state;
    void run.execute().then((state) => {
      this.lastRun = state;
      this.afterSettle(run, state);
    }).catch((error: unknown) => {
      console.warn(`[symposium] 讨论异常结束：${(error as Error).message}`);
    }).finally(() => {
      if (this.current === run) this.current = undefined;
    });
    return run.state;
  }

  /**
   * Track the paused slot whenever a run settles.
   * @param run - the run that just returned.
   * @param state - its settled state.
   */
  private afterSettle(run: SymposiumRun, state: RunState): void {
    this.journalSettled(state);
    if (state.status === 'awaiting-verification') {
      this.pausedRun = run;
      this.log(`[symposium] 等待求证：${state.pendingQuestions?.length ?? 0} 个问题待回答（symposium_answer 继续）`);
      return;
    }
    if (this.pausedRun === run) this.pausedRun = undefined;
  }

  /**
   * Answer the parked run's 【求证】 questions and let it continue (P2).
   * @param answers - the owner's findings, matched by `qid`.
   * @param finish - true to stop here and let the chair converge on what exists.
   * @returns the settled state of the continued run.
   * @throws when no run is waiting for answers.
   */
  async answerRun(answers: readonly Verification[], finish = false, runId?: string): Promise<RunState> {
    const run = this.pausedRun;
    if (run === undefined) throw new Error('当前没有等待求证答案的研讨。');
    if (runId !== undefined && runId.trim().length > 0 && runId.trim() !== run.state.id) {
      throw new Error(`答案指向的场次 ${runId} 不是当前等待答案的场次 ${run.state.id}，已拒绝以免投错。`);
    }
    this.pausedRun = undefined;
    if (finish) {
      run.state.pendingQuestions = [];
      run.state.stopReason = 'user-stop';
      run.state.status = 'stopped';
      run.stop('user-stop');
      const state = run.state;
      this.lastRun = state;
      return state;
    }
    this.current = run;
    const state = await run.resume(answers);
    this.lastRun = state;
    this.afterSettle(run, state);
    if (this.current === run) this.current = undefined;
    return state;
  }

  /**
   * Boot-time recovery (P2): reclassify interrupted runs and park the newest
   * paused one so the owner can still answer it after a restart.
   * @returns the recovered paused state, when there was one.
   */
  async recover(): Promise<RunState | undefined> {
    const interrupted = markInterrupted();
    if (interrupted.length > 0) {
      this.log(`[symposium] ${interrupted.length} 场研讨在进程退出时中断，已改判 failed：${interrupted.join('、')}`);
    }
    const saved = latestPausedRun();
    if (saved === undefined) return undefined;
    const config = this.config();
    const run = new SymposiumRun(this.runnerDeps(config), saved.brief, {
      previousId: saved.id,
      completedRounds: saved.rounds,
      speeches: saved.speeches,
      summary: saved.summary,
    });
    // A recovered run is the SAME run, not a continuation of it.
    delete run.state.continuedFrom;
    run.state.tier = saved.tier ?? config.defaultTier;
    run.state.mode = saved.mode ?? 'design';
    run.state.pendingQuestions = saved.pendingQuestions ?? [];
    run.state.verifications = saved.verifications ?? [];
    run.state.status = 'awaiting-verification';
    run.state.stopReason = 'awaiting-verification';
    this.pausedRun = run;
    this.lastRun = run.state;
    this.log(`[symposium] 已恢复暂停的研讨 ${saved.id}（${run.state.pendingQuestions.length} 个问题待回答）`);
    return run.state;
  }

  /** Append the run line once per settled run (P3). */
  private journalSettled(state: RunState): void {
    if (this.journaled.has(state.id)) return;
    if (state.status === 'idle' || state.status === 'running' || state.status === 'awaiting-verification') return;
    try {
      appendJournal(buildRunLine(state, state.tier ?? this.config().defaultTier));
      this.journaled.add(state.id);
    } catch (error) {
      // A journal failure must never fail a run that already finished.
      console.warn(`[symposium] 决策日记写入失败：${(error as Error).message}`);
    }
  }

  /** The newest run id recorded in the journal, if any. */
  private latestJournalRunId(): string | undefined {
    return runSummaries(readJournal().lines, 1)[0]?.runId;
  }

  /**
   * Record the owner's aligned ruling after a review (P3).
   * @param decisions - per decision point choices, with the objection ids adopted.
   * @param runId - target run; defaults to the newest run in the journal.
   * @returns a one-line confirmation.
   */
  async journalRuling(
    decisions: { dp: string; choice: string; adopted?: string[]; note?: string }[],
    runId?: string,
  ): Promise<string> {
    if (decisions.length === 0) throw new Error('ruling 需要至少一个决策项（dp/choice）');
    const target = runId?.trim() || this.latestJournalRunId();
    if (target === undefined) throw new Error('决策日记里还没有任何 run 行：先跑一场研讨，再记裁决。');
    appendJournal(buildRulingLine(target, decisions.map((item) => ({
      dp: item.dp.trim(),
      choice: item.choice.trim(),
      adopted: Array.isArray(item.adopted)
        ? item.adopted.map((oid) => String(oid).trim()).filter((oid) => oid !== '')
        : [],
      ...(item.note !== undefined && item.note.trim() !== '' ? { note: item.note.trim() } : {}),
    }))));
    return `已记录 ${decisions.length} 条裁决（run ${target.slice(0, 8)}）`;
  }

  /**
   * Register one objection by hand, after the owner alignment (P3).
   *
   * The ruling matrix used to produce these mechanically; that source is gone,
   * so the main model — the only reader that knows what actually matters —
   * decides what counts as an objection worth tracking.
   * @param input - which run, which sage, which point, the verdict and why.
   * @returns the objection id to use with `reconcile`.
   */
  async journalObjection(input: {
    runId?: string;
    sage: string;
    dp: string;
    verdict: '否决' | '修改';
    reason: string;
  }): Promise<string> {
    const sage = input.sage.trim();
    if (sage === '') throw new Error('objection 需要 sage：贤者 id 或名单里的名字');
    const dp = input.dp.trim();
    if (dp === '') throw new Error('objection 需要 dp：决策点 id（如 D1 或 W1）');
    const reason = input.reason.trim();
    if (reason === '') throw new Error('objection 需要 reason：一句话说明反对什么，删掉这条就丢了对账依据');
    const target = input.runId?.trim() || this.latestJournalRunId();
    if (target === undefined) throw new Error('决策日记里还没有任何 run 行：先跑一场研讨，再登记反对意见。');
    const config = this.config();
    const hit = config.sages.find((item) => item.id === sage || item.name === sage);
    const sageId = hit?.id ?? sage;
    const sageName = hit?.name ?? this.visibleRun()?.speeches.find((speech) => speech.participantId === sageId)?.name ?? sage;
    const oid = `${target.slice(0, 8)}:${sageId}:${dp}`;
    if (objectionsOf(readJournal().lines).some((item) => item.oid === oid)) {
      throw new Error(`oid 已存在：${oid}。同一条反对只能登记一次；要对账请用 action=reconcile。`);
    }
    appendJournal({
      type: 'objection',
      version: JOURNAL_VERSION,
      at: Date.now(),
      runId: target,
      objection: { oid, sage: sageId, sageName, dp, verdict: input.verdict, reason: reason.slice(0, 200) },
    });
    return oid;
  }

  /**
   * Reconcile one objection after construction (P3).
   * Unknown ids are rejected instead of creating an unattributable row.
   * @param oid - the objection id.
   * @param outcome - materialized | not-materialized | untested.
   * @param evidence - optional pointer to the proof.
   * @returns a one-line confirmation.
   */
  async journalReconcile(oid: string, outcome: ReconcileOutcome, evidence?: string): Promise<string> {
    const key = oid.trim();
    if (key === '') throw new Error('reconcile 需要 oid');
    const known = objectionsOf(readJournal().lines).find((item) => item.oid === key);
    if (known === undefined) {
      throw new Error(`oid 不存在：${key}。先用 symposium_journal action=list 查看最近的场次与未对账条目。`);
    }
    appendJournal(buildReconcileLine(key, outcome, evidence));
    return `已对账 ${key}（${known.sageName} / ${known.dp}）：${outcome}`;
  }

  /** Per-sage fulfillment rollup plus read health (P3). */
  journalStats(): {
    sages: ReturnType<typeof fulfillmentStats>['sages'];
    orphanOids: string[];
    badLines: number;
    totalLines: number;
  } {
    const read = readJournal();
    const stats = fulfillmentStats(read.lines);
    return { sages: stats.sages, orphanOids: stats.orphanOids, badLines: read.badLines, totalLines: read.totalLines };
  }

  /** Recent runs with unreconciled objection counts (P3). */
  journalList(limit = 10): ReturnType<typeof runSummaries> {
    return runSummaries(readJournal().lines, limit);
  }

  /** `应验 x/y` for one sage, `—` when the journal holds no data for it. */
  fulfillmentOf(sageId: string): string {
    const row = fulfillmentStats(readJournal().lines).sages.find((item) => item.sage === sageId);
    return row === undefined ? '—' : row.ratio;
  }

  /** Absolute journal path, for diagnostics. */
  journalPath(): string {
    return resolveJournalPath();
  }

  /** The paused run, for tool summaries. */
  pendingQuestions(): PendingQuestion[] {
    return this.pausedRun?.state.pendingQuestions ?? [];
  }

  /**
   * Write the chat page as a file (P2 可视化).
   *
   * The desktop shell refuses outside HTTP clients (`Browser access is
   * disabled`), so the page cannot be reached over the network there. A file
   * opened from disk has no such fence: it carries its own data and refreshes
   * itself, which is enough to watch a discussion run.
   * @param state - the run to render.
   */
  private writePanelSnapshot(state: RunState): void {
    try {
      const dir = join(resolveDshHome(), 'symposium');
      mkdirSync(dir, { recursive: true });
      const seats = this.rosterSnapshot().map((seat) => ({ id: seat.id, name: seat.name }));
      writeFileSync(join(dir, 'panel.html'), renderPanelHtml(seats, projectLiveState(state), 5), 'utf8');
    } catch {
      // A missing snapshot never fails a run.
    }
  }

  /**
   * A read-only projection of the current run for the live panel (P2 可视化).
   * Deliberately serializable and small: the page polls it every two seconds.
   * @returns the status, topic, speeches and pending questions.
   */
  liveState(): Record<string, unknown> {
    const state = this.current?.state ?? this.lastRun;
    if (state === undefined) {
      return { status: 'idle', topic: '', rounds: 0, plannedRounds: 0, speeches: [], pendingQuestions: [] };
    }
    return projectLiveState(state);
  }

  /** Projection helper lives at module scope so the snapshot writer can reuse it. */
  private liveStateBody(state: RunState): Record<string, unknown> {
    return {
      status: state.status,
      topic: state.brief.topic,
      rounds: state.rounds,
      plannedRounds: state.plannedRounds,
      startedAt: state.startedAt,
      pendingQuestions: (state.pendingQuestions ?? []).map((item) => ({
        qid: item.qid,
        sageId: item.sageId,
        sageName: item.sageName,
        text: item.text,
      })),
      speeches: state.speeches.map((speech) => ({
        participantId: speech.participantId,
        name: speech.name,
        model: speech.model,
        round: speech.round,
        status: speech.status,
        text: speech.text,
        note: speech.note,
        usage: { outputTokens: speech.usage.outputTokens },
      })),
    };
  }

  /**
   * Stop the running discussion.
   * @returns the run state at the moment of the request.
   * @throws when nothing is running.
   */
  async stopRun(): Promise<RunState> {
    const run = this.current;
    if (run === undefined) throw new Error('当前没有正在进行的讨论。');
    run.stop('user-stop');
    return run.state;
  }

  /**
   * Forget the finished discussion the settings page is displaying.
   * @returns whether a finished run was cleared.
   * @throws when a discussion is running.
   */
  async clearRun(): Promise<boolean> {
    if (this.current !== undefined) throw new Error('讨论进行中，不能清空。');
    const had = this.lastRun !== undefined;
    this.lastRun = undefined;
    return had;
  }

  /**
   * Read the Markdown 纪要 for the last finished discussion.
   * @returns the Markdown document, or an explanation when there is none.
   */
  async getReport(): Promise<string> {
    const state = this.visibleRun();
    if (state === undefined) return '还没有任何讨论记录。';
    return renderMarkdownReport(state, { outputDir: '', chairPersona: this.config().chair.persona });
  }

  /**
   * Score the last finished discussion again with the current referee and
   * rewrite its Markdown 纪要.
   * @returns the refreshed run state.
   * @throws when no discussion has finished or no referee is available.
   */
  async rechair(): Promise<RunState> {
    const state = this.visibleRun();
    if (state === undefined) throw new Error('还没有可重新收敛纪要的研讨记录。');
    if (this.current !== undefined) throw new Error('研讨还在进行中。');
    const config = this.config();
    const target = await this.chairTarget(config);
    if (target === undefined) throw new Error('没有可用的主席模型，请配置 CHAIR_MODEL 或主席 provider/model。');
    state.minutes = await runChair(this.llm, {
      brief: state.brief,
      provider: target.provider,
      model: target.model,
      persona: config.chair.persona,
      sages: config.sages,
      speeches: state.speeches,
      costByParticipant: participantCostsOf(state.speeches, config.sages),
      timeoutMs: Math.max(config.requestTimeoutMs, 300_000),
    });
    const directory = resolveOutputDir(config);
    mkdirSync(directory, { recursive: true });
    state.reportPath = buildMarkdownReport(state, { outputDir: directory, chairPersona: config.chair.persona });
    this.lastRun = state;
    return state;
  }

  /**
   * Wait until the background run settles.
   * Used by the `symposium_start` tool, which reports a finished discussion
   * rather than a started one.
   * @returns the settled run state, or the previous one when nothing is running.
   */
  async whenRunSettles(): Promise<RunState | undefined> {
    const run = this.current;
    if (run === undefined) return this.lastRun;
    while (this.current === run) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.lastRun ?? run.state;
  }

  /** The referee verdict of the visible run, for tool summaries. */
  minutesOfVisibleRun(): ChairOutcome | undefined {
    return this.visibleRun()?.minutes;
  }

  /** The persona text one configured sage would use, for diagnostics. */
  personaOf(participantId: string): string | undefined {
    const sage = this.config().sages.find((entry) => entry.id === participantId);
    return sage === undefined ? undefined : resolvePersona(sage);
  }

  /**
   * A compact roster for the system-prompt section and the startup log.
   * @returns one entry per sage, with a one-line persona hint.
   */
  rosterSnapshot(): { id: string; name: string; provider: string; model: string; personaHint: string }[] {
    return this.config().sages.map((sage) => ({
      id: sage.id,
      name: sage.name,
      provider: sage.provider,
      model: sage.model,
      personaHint: resolvePersona(sage).replace(/\s+/g, ' ').slice(0, 60),
    }));
  }

  /** Absolute path of the persisted document, without reading it. */
  configPathSnapshot(): string {
    return resolveConfigPath();
  }

  /** Absolute path of the persona mirror directory. */
  personaDirSnapshot(): string {
    return resolvePersonaDir();
  }

  /** The owning context, kept so the tools half can register against it. */
  get context(): Context {
    return this.hostCtx;
  }
}

function projectLiveState(state: RunState): Record<string, unknown> {

  return {
    status: state.status,
    topic: state.brief.topic,
    rounds: state.rounds,
    plannedRounds: state.plannedRounds,
    startedAt: state.startedAt,
    pendingQuestions: (state.pendingQuestions ?? []).map((item) => ({
      qid: item.qid,
      sageId: item.sageId,
      sageName: item.sageName,
      text: item.text,
    })),
    speeches: state.speeches.map((speech) => ({
      participantId: speech.participantId,
      name: speech.name,
      model: speech.model,
      round: speech.round,
      status: speech.status,
      text: speech.text,
      note: speech.note,
      usage: { outputTokens: speech.usage.outputTokens },
    })),
  };
}
