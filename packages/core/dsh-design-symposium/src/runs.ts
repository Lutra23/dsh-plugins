/**
 * Run-state persistence (P2).
 *
 * A discussion that pauses for 【求证】 answers outlives the process that
 * started it: the owner may answer minutes later, or after a restart. The
 * paused state therefore lives on disk, one JSON file per run under
 * `$DSH_HOME/symposium/runs/`, written atomically (tmp + rename) so a crash
 * mid-write can never leave a half file that the recovery scan would trust.
 *
 * Only the plugin's own `*.json` files are ever pruned; anything else in that
 * directory belongs to somebody else and is left alone.
 *
 * @module dsh-design-symposium/runs
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from './config.js';
import type { RunState } from './symposium.js';

/** How many run files to keep; older ones are pruned by mtime. */
const KEEP_RUNS = 20;

/**
 * Directory holding persisted run states.
 * @param home - DSH home; defaults to the resolved one.
 * @returns the absolute directory path.
 */
export function resolveRunsDir(home: string = resolveDshHome()): string {
  return join(home, 'symposium', 'runs');
}

/**
 * Write one run state atomically and prune old files.
 *
 * The temp file is written first and then renamed over the target, so a reader
 * either sees the previous complete state or the new complete state — never a
 * truncated JSON document.
 * @param state - the state to persist.
 * @param dir - target directory; defaults to {@link resolveRunsDir}.
 * @returns the file path written.
 */
export function persistRun(state: RunState, dir: string = resolveRunsDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.id}.json`);
  const tmp = `${path}.tmp`;
  // Stamp the writer's pid: a restart must never reclassify a run whose owner
  // is still alive in another process.
  writeFileSync(tmp, JSON.stringify({ ...state, ownerPid: process.pid }, null, 2), 'utf8');
  renameSync(tmp, path);
  pruneRuns(dir);
  return path;
}

/**
 * Read one persisted run.
 * @param id - run id (file stem).
 * @param dir - source directory.
 * @returns the parsed state, or `undefined` when absent or unreadable.
 */
export function readRun(id: string, dir: string = resolveRunsDir()): RunState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
    return isRunState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The most recently written run that is still waiting for answers.
 * @param dir - source directory.
 * @returns the newest paused state, or `undefined` when there is none.
 */
export function latestPausedRun(dir: string = resolveRunsDir()): RunState | undefined {
  const files = listRunFiles(dir);
  for (const file of files) {
    const state = readRun(file.id, dir);
    if (state?.status === 'awaiting-verification') return state;
  }
  return undefined;
}

/**
 * Mark every persisted run that still claims to be running as interrupted.
 *
 * A `running` file can only exist because the process died mid-run: nothing
 * keeps writing after a clean stop. Those runs are not resumable — their round
 * is half-spoken — so they are recorded as failed instead of silently kept.
 * @param dir - source directory.
 * @returns the ids that were reclassified.
 */
export function markInterrupted(dir: string = resolveRunsDir()): string[] {
  const interrupted: string[] = [];
  for (const file of listRunFiles(dir)) {
    const state = readRun(file.id, dir);
    if (state?.status !== 'running') continue;
    // A live owner means this file is being written right now, not abandoned.
    if (isProcessAlive(state.ownerPid)) continue;
    state.status = 'failed';
    state.stopReason = 'internal-error';
    state.error = '进程在讨论中途退出，本轮发言不完整，无法恢复。';
    state.endedAt = state.endedAt ?? Date.now();
    persistRun(state, dir);
    interrupted.push(state.id);
  }
  return interrupted;
}

/**
 * Delete the oldest run files beyond {@link KEEP_RUNS}.
 * @param dir - source directory.
 */
export function pruneRuns(dir: string = resolveRunsDir()): void {
  const files = listRunFiles(dir);
  for (const file of files.slice(KEEP_RUNS)) {
    try {
      rmSync(join(dir, `${file.id}.json`), { force: true });
    } catch {
      // A file we cannot delete is not worth failing a write over.
    }
  }
}

/** Run files, newest first, with their mtime. */
function listRunFiles(dir: string): { id: string; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { id: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      out.push({ id: name.slice(0, -'.json'.length), mtime: statSync(path).mtimeMs });
    } catch {
      // Vanished between readdir and stat: skip it.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Whether the pid that wrote a run file is still running.
 * @param pid - the recorded owner; absent means the file predates the field.
 * @returns true when that process still exists.
 */
function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Structural check, so a foreign or corrupt file never becomes a live run. */
function isRunState(value: unknown): value is RunState {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.status === 'string'
    && typeof record.rounds === 'number'
    && Array.isArray(record.speeches)
    && record.brief !== null && typeof record.brief === 'object';
}
