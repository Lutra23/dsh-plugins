/**
 * Decision journal (P3).
 *
 * Append-only JSONL at `$DSH_HOME/symposium/decisions.jsonl`, one event per
 * line. A write is a single `write` of the whole line plus fsync and a size
 * read-back, because a half line is indistinguishable from a corrupt line once
 * it lands — parsing before the write cannot prevent that.
 *
 * Reads never throw. A line that does not parse (or does not carry a known
 * `type`) is skipped and counted, so statistics can say how much they could
 * not read instead of silently pretending the file was clean.
 *
 * @module dsh-design-symposium/journal
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDshHome } from './config.js';
import type { RunState } from './symposium.js';

/** Schema version stamped on every line; bump together with a reader migration. */
export const JOURNAL_VERSION = 1;

/** How a single objection finally turned out. */
export type ReconcileOutcome = 'materialized' | 'not-materialized' | 'untested';

/** One objection a sage raised, addressable by a stable id. */
export interface JournalObjection {
  /** `${runId.slice(0,8)}:${sageId}:${dp}` — stable for the life of the run. */
  oid: string;
  sage: string;
  sageName: string;
  dp: string;
  verdict: '否决' | '修改';
  reason: string;
}

/** Written once per settled run, after the chair. */
export interface JournalRunLine {
  type: 'run';
  version: number;
  at: number;
  runId: string;
  tier: string;
  topic: string;
  objections: JournalObjection[];
}

/** The owner's aligned ruling after a review. */
export interface JournalRulingLine {
  type: 'ruling';
  version: number;
  at: number;
  runId: string;
  decisions: { dp: string; choice: string; adopted: string[]; note?: string }[];
}

/** One reconciliation result; the last line for an oid wins. */
export interface JournalReconcileLine {
  type: 'reconcile';
  version: number;
  at: number;
  oid: string;
  outcome: ReconcileOutcome;
  evidence?: string;
}

/** One objection registered by hand after the owner alignment (P3, post-matrix). */
export interface JournalObjectionLine {
  type: 'objection';
  version: number;
  at: number;
  runId: string;
  objection: JournalObjection;
}

/** Closes a run for archival; without it a run must not be archived. */
export interface JournalCloseLine {
  type: 'close';
  version: number;
  at: number;
  runId: string;
  summary?: string;
}

/** A problem found during construction that no sage predicted. */
export interface JournalFindingLine {
  type: 'new-finding';
  version: number;
  at: number;
  runId?: string;
  oid?: string;
  text: string;
}

/** Any journal line. */
export type JournalLine =
  | JournalRunLine
  | JournalRulingLine
  | JournalObjectionLine
  | JournalReconcileLine
  | JournalCloseLine
  | JournalFindingLine;

/** Result of reading the journal: what parsed, what did not. */
export interface JournalRead {
  lines: JournalLine[];
  badLines: number;
  totalLines: number;
}

/** Per-sage fulfillment rollup. */
export interface SageFulfillment {
  sage: string;
  sageName: string;
  materialized: number;
  notMaterialized: number;
  untested: number;
  /** materialized + not-materialized — the only denominator that counts. */
  judged: number;
  /** `x/y`, or `不可用` when nothing has been judged yet. */
  ratio: string;
  /** `N 条` or `样本不足` — never hidden, so a ratio cannot look stronger than it is. */
  sample: string;
}

/** One line in the "recent runs" view. */
export interface JournalRunSummary {
  runId: string;
  topic: string;
  tier: string;
  at: number;
  objections: number;
  unreconciled: number;
  closed: boolean;
}

/** Absolute journal path for a DSH home. */
export function resolveJournalPath(home: string = resolveDshHome()): string {
  return join(home, 'symposium', 'decisions.jsonl');
}

/**
 * Append one line, then prove it landed whole.
 * @param line - the entry to write.
 * @param path - target file; defaults to {@link resolveJournalPath}.
 * @throws when the size read-back disagrees with what was written.
 */
export function appendJournal(line: JournalLine, path: string = resolveJournalPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(line)}\n`;
  const bytes = Buffer.byteLength(payload);
  const before = existsSync(path) ? statSync(path).size : 0;
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const after = existsSync(path) ? statSync(path).size : 0;
  if (after !== before + bytes) {
    throw new Error(`决策日记长度校验失败：期望 ${before + bytes} 字节，实际 ${after} 字节（${path}）`);
  }
}

/**
 * Read every parseable line and count the rest.
 * @param path - source file; a missing file reads as empty.
 * @returns parsed lines plus the corrupt-line count.
 */
export function readJournal(path: string = resolveJournalPath()): JournalRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { lines: [], badLines: 0, totalLines: 0 };
  }
  const lines: JournalLine[] = [];
  let badLines = 0;
  let totalLines = 0;
  for (const text of raw.split('\n')) {
    if (text.trim().length === 0) continue;
    totalLines += 1;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isJournalLine(parsed)) lines.push(parsed);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines, totalLines };
}

/**
 * Turn a settled run into its journal line.
 *
 * Objections are no longer harvested here: the ruling matrix is gone, and the
 * ones a matrix could produce were mechanical (`否决`/`修改` cells), not the
 * objections that actually matter. The main model registers those by hand,
 * after it has aligned with the owner, via `symposium_journal action=objection`.
 * @param state - the settled run.
 * @param tier - the tier it ran under.
 * @returns the run line, not yet written.
 */
export function buildRunLine(state: RunState, tier: string): JournalRunLine {
  return {
    type: 'run',
    version: JOURNAL_VERSION,
    at: Date.now(),
    runId: state.id,
    tier,
    topic: state.brief.topic,
    objections: [],
  };
}

/**
 * Build a ruling line; version and timestamp are stamped here so callers
 * cannot forget them.
 * @param runId - the run the ruling belongs to.
 * @param decisions - the owner's per-decision-point choices.
 * @returns the ruling line, not yet written.
 */
export function buildRulingLine(runId: string, decisions: JournalRulingLine['decisions']): JournalRulingLine {
  return { type: 'ruling', version: JOURNAL_VERSION, at: Date.now(), runId, decisions };
}

/**
 * Build a reconcile line.
 * @param oid - the objection being reconciled.
 * @param outcome - how it turned out.
 * @param evidence - optional pointer to the proof.
 * @returns the reconcile line, not yet written.
 */
export function buildReconcileLine(oid: string, outcome: ReconcileOutcome, evidence?: string): JournalReconcileLine {
  const trimmed = evidence?.trim() ?? '';
  return {
    type: 'reconcile',
    version: JOURNAL_VERSION,
    at: Date.now(),
    oid,
    outcome,
    ...(trimmed.length > 0 ? { evidence: trimmed } : {}),
  };
}

/** Every objection ever recorded, newest line last. */
export function objectionsOf(lines: readonly JournalLine[]): JournalObjection[] {
  const out: JournalObjection[] = [];
  for (const line of lines) {
    if (line.type === 'run') out.push(...line.objections);
    else if (line.type === 'objection') out.push(line.objection);
  }
  return out;
}

/**
 * Aggregate fulfillment per sage.
 *
 * Only `materialized` and `not-materialized` enter the denominator: `untested`
 * is not a failure, and an unreconciled objection is not a success. The last
 * reconcile line for an oid wins, so re-checking after construction corrects an
 * earlier verdict instead of double-counting it.
 * @param lines - journal lines in file order.
 * @returns per-sage rollup plus oids that have no owning run line.
 */
export function fulfillmentStats(lines: readonly JournalLine[]): { sages: SageFulfillment[]; orphanOids: string[] } {
  const owner = new Map<string, JournalObjection>();
  for (const objection of objectionsOf(lines)) owner.set(objection.oid, objection);

  const latest = new Map<string, JournalReconcileLine>();
  for (const line of lines) if (line.type === 'reconcile') latest.set(line.oid, line);

  const acc = new Map<string, { sageName: string; materialized: number; notMaterialized: number; untested: number }>();
  const orphanOids: string[] = [];
  for (const [oid, line] of latest) {
    const objection = owner.get(oid);
    if (objection === undefined) {
      orphanOids.push(oid);
      continue;
    }
    const entry = acc.get(objection.sage) ?? { sageName: objection.sageName, materialized: 0, notMaterialized: 0, untested: 0 };
    if (line.outcome === 'materialized') entry.materialized += 1;
    else if (line.outcome === 'not-materialized') entry.notMaterialized += 1;
    else entry.untested += 1;
    acc.set(objection.sage, entry);
  }
  // A sage with objections but no reconcile line still deserves a row: its
  // whole sample is untested, which is information, not absence of data.
  for (const objection of owner.values()) {
    if (!acc.has(objection.sage)) acc.set(objection.sage, { sageName: objection.sageName, materialized: 0, notMaterialized: 0, untested: 0 });
  }

  const sages: SageFulfillment[] = [...acc.entries()].map(([sage, entry]) => {
    const judged = entry.materialized + entry.notMaterialized;
    return {
      sage,
      sageName: entry.sageName,
      materialized: entry.materialized,
      notMaterialized: entry.notMaterialized,
      untested: entry.untested,
      judged,
      ratio: judged === 0 ? '不可用' : `${entry.materialized}/${judged}`,
      sample: judged < 5 ? '样本不足' : `${judged} 条`,
    };
  });
  sages.sort((a, b) => b.judged - a.judged || a.sage.localeCompare(b.sage));
  return { sages, orphanOids };
}

/**
 * Summarize recent runs: how many objections they raised, how many still lack
 * a reconciliation, and whether they were closed for archival.
 * @param lines - journal lines in file order.
 * @param limit - how many runs to return, newest first.
 * @returns one row per run.
 */
export function runSummaries(lines: readonly JournalLine[], limit = 10): JournalRunSummary[] {
  const reconciled = new Set<string>();
  for (const line of lines) if (line.type === 'reconcile') reconciled.add(line.oid);
  const closed = new Set<string>();
  for (const line of lines) if (line.type === 'close') closed.add(line.runId);
  // Objections arrive two ways: embedded in a legacy run line, or as their own
  // line registered by hand after the owner alignment. Both must count.
  const byRun = new Map<string, JournalObjection[]>();
  for (const line of lines) {
    if (line.type === 'run') {
      const bucket = byRun.get(line.runId) ?? [];
      bucket.push(...line.objections);
      byRun.set(line.runId, bucket);
    } else if (line.type === 'objection') {
      const bucket = byRun.get(line.runId) ?? [];
      bucket.push(line.objection);
      byRun.set(line.runId, bucket);
    }
  }

  const rows: JournalRunSummary[] = [];
  for (const line of lines) {
    if (line.type !== 'run') continue;
    const mine = byRun.get(line.runId) ?? [];
    rows.push({
      runId: line.runId,
      topic: line.topic,
      tier: line.tier,
      at: line.at,
      objections: mine.length,
      unreconciled: mine.filter((objection) => !reconciled.has(objection.oid)).length,
      closed: closed.has(line.runId),
    });
  }
  return rows.reverse().slice(0, Math.max(1, limit));
}

/** Structural check so a foreign or corrupt line never poisons the rollup. */
function isJournalLine(value: unknown): value is JournalLine {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string') return false;
  if (typeof record.version !== 'number' || typeof record.at !== 'number') return false;
  switch (record.type) {
    case 'run':
      return typeof record.runId === 'string' && Array.isArray(record.objections);
    case 'ruling':
      return typeof record.runId === 'string' && Array.isArray(record.decisions);
    case 'objection': {
      const objection = record.objection as Record<string, unknown> | undefined;
      return typeof record.runId === 'string'
        && objection !== null && typeof objection === 'object'
        && typeof objection.oid === 'string'
        && typeof objection.sage === 'string'
        && (objection.verdict === '否决' || objection.verdict === '修改');
    }
    case 'reconcile':
      return typeof record.oid === 'string'
        && (record.outcome === 'materialized' || record.outcome === 'not-materialized' || record.outcome === 'untested');
    case 'close':
      return typeof record.runId === 'string';
    case 'new-finding':
      return typeof record.text === 'string';
    default:
      return false;
  }
}
