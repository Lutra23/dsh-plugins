/**
 * Configuration model, defaults, and the `symposium.json` store.
 *
 * Layering (highest wins):
 *   1. environment overrides — `CHAIR_MODEL`, `CHAIR_PERSONA`, `SYMPOSIUM_OUTPUT_DIR`
 *   2. the stored document (`$DSH_HOME/symposium.json`, else `~/.dsh/symposium.json`)
 *   3. {@link defaultConfig}
 *
 * Secrets never enter this document. Providers are read from the Harness LLM
 * service, so their API keys stay in the DSH credential store; the only
 * credential-shaped field here is `apiKeyEnv`, a *name*.
 *
 * @module dsh-design-symposium/config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** One debating AI: identity, model binding, persona, and artwork. */
export interface SageConfig {
  /** Stable slug used in file names and transcripts. */
  id: string;
  /** Display name shown in the transcript and the report. */
  name: string;
  /**
   * What this seat defends — the identity anchor of a sage.
   * A symposium seat is defined by its stance, not by its model: models are
   * interchangeable tuning knobs, stances are what collide productively.
   */
  stance: string;
  /** Review duties: what this seat must actively check every round. */
  duties: string[];
  /** Harness provider route (as `ctx.llm.listProviders()` reports it). May be empty — the engine skips unbound seats per run with an anomaly. */
  provider: string;
  /** Model id accepted by that provider. May be empty — same skip rule as provider. */
  model: string;
  /** Optional persona supplement, mirrored to `personas/<id>.md` on save. */
  persona: string;
  /**
   * Persona file to read, as a path **relative to the persona directory**.
   * Absolute paths and `..` escapes are dropped on load: the field names a file
   * inside `personas/`, never an arbitrary path the plugin would then read or
   * overwrite.
   */
  personaFile?: string;
  /** Marks a low-cost model; summaries prefer these. */
  cheap?: boolean;
  /**
   * How much of the agenda pack this seat sees.
   * `full` (default) gets the proposal and the author's leans; `problem-only`
   * gets just the topic, the decision points and the invariants, so the seat
   * can propose an independent alternative before being anchored.
   */
  view?: 'full' | 'problem-only';
}

/** The rotating referee. */
export interface ChairConfig {
  enabled: boolean;
  /** Provider route for the chair; empty resolves to the first qwen-ish route. */
  provider: string;
  /** Model id for the chair; empty resolves to that provider's first qwen-ish model. */
  model: string;
  /** Referee persona; `CHAIR_PERSONA` overrides it. */
  persona: string;
}

/** Sensitive-content scanning policy. */
export interface SensitiveConfig {
  /** Scan with the built-in Chinese/English baseline list. */
  builtin: boolean;
  /** Extra literal words (matched case-insensitively). */
  words: string[];
  /** Extra regular expressions (case-insensitive, must be valid). */
  patterns: string[];
}

/** One open decision the sages rule on, by id. */
export interface DecisionPoint {
  /** Stable id, `D<n>`. */
  id: string;
  /** One-line statement of the question. */
  title: string;
  /** Optional candidate options, so a ruling can be `修改` towards one. */
  options?: string[];
  /** Optional author's leaning — made explicit so sages can attack it. */
  lean?: string;
}

/** One assumption the brief rests on, flagged as verified or not. */
export interface Assumption {
  text: string;
  /** true = already checked against reality; false = inferred, open to attack. */
  verified: boolean;
}

/** The agenda pack every sage receives before round 1. */
export interface Brief {
  /** The design question under discussion. */
  topic: string;
  /** Optional context the caller collected before the symposium (docs, constraints). */
  background?: string;
  /** Optional engineering materials injected verbatim into the round-1 context. */
  materials?: string[];
  /** The author's draft under review (v0.5 contract). */
  proposal?: string;
  /** Open decision points; every sage rules on each of them every round. */
  decisionPoints?: DecisionPoint[];
  /** Decisions already made by the owner; sages must not reopen them. */
  locked?: string[];
  /** Invariants that must hold in any accepted design. */
  invariants?: string[];
  /** Assumptions, split into verified facts and open hypotheses. */
  assumptions?: Assumption[];
  /** Options already rejected, with the reason they were dropped. */
  rejected?: { proposal: string; reason: string }[];
}

/** Strictness of the agenda-pack contract. */
export type BriefTier = 'quick' | 'standard' | 'deep';

/** Review mode: a design review, or a construction-plan review (P4). */
export type BriefMode = 'design' | 'plan';

/** Who a seat may see while speaking (P4, D1 ruling). */
export type VisibilityPolicy = 'previous_rounds' | 'incremental';

/** One budget tier: who speaks, how many rounds, and the hard token ceiling. */
export interface TierSpec {
  /** Sage ids invited in this tier; empty = every configured sage. */
  seats: string[];
  /** Round cap for this tier (1–20). */
  rounds: number;
  /** Per-turn output cap. */
  maxTokensPerTurn: number;
  /** Hard ceiling on the whole run's tokens (input + output); 0 = unlimited. */
  maxTokens: number;
  /** 【求证】 question budget for the run; 0 disables pausing (P2). */
  maxQuestions: number;
  /**
   * Chair binding for this tier; absent = the document's `chair`.
   * A cheap tier may keep a strong chair while forcing cheap speakers.
   */
  chair?: ModelBinding;
  /**
   * Force every seat of this tier onto one model; absent = each seat's own
   * binding. Lets a tier trade review depth for spend without editing seats.
   */
  seatModel?: ModelBinding;
}

/** A provider/model pair as written in the document. */
export interface ModelBinding {
  provider: string;
  model: string;
}

/** Built-in tier defaults; a user's `tiers` block overrides them field by field. */
const TIER_DEFAULTS: Record<BriefTier, TierSpec> = {
  quick: { seats: [], rounds: 1, maxTokensPerTurn: 16_384, maxTokens: 200_000, maxQuestions: 0 },
  standard: { seats: [], rounds: 2, maxTokensPerTurn: 16_384, maxTokens: 200_000, maxQuestions: 3 },
  deep: { seats: [], rounds: 4, maxTokensPerTurn: 16_384, maxTokens: 600_000, maxQuestions: 8 },
};

/** The complete persisted document. */
export interface SymposiumConfig {
  /** Document schema version, bumped by migrations. */
  version: number;
  /** The agenda pack: topic + optional background and engineering materials. */
  brief: Brief;
  /**
   * First-round blind review: during round 1 each sage sees only the brief,
   * not the other sages' opening statements — independence before collision.
   */
  firstRoundBlind: boolean;
  /** Who a seat sees while speaking: `previous_rounds` hides the current round (P4). */
  visibilityPolicy: VisibilityPolicy;
  /** Number of speaking rounds, 1–20. */
  maxRounds: number;
  /** Output-token cap for a single speaker turn. */
  maxTokensPerTurn: number;
  /** Per-request timeout in milliseconds; a timeout makes that AI absent for the round. */
  requestTimeoutMs: number;
  /** Estimated-context budget; exceeding it compresses old rounds into a summary. */
  tokenBudget: number;
  /** Compression turns kept verbatim after the summary. */
  keepRecentRounds: number;
  /** Abort the discussion after this many sensitive-content hits. */
  sensitiveThreshold: number;
  /** Directory the report is written to. */
  outputDir: string;
  /** Per-tier budgets; `normalizeConfig` always fills all three. */
  tiers: Record<BriefTier, TierSpec>;
  /** Tier used when a run does not name one. */
  defaultTier: BriefTier;
  /** Hard token ceiling applied to the current run; 0 = unlimited. */
  maxRunTokens: number;
  /** 【求证】 question budget for this run, copied from the tier (P2). */
  maxQuestions: number;
  /** Declared sages, in speaking order. */
  sages: SageConfig[];
  chair: ChairConfig;
  sensitive: SensitiveConfig;
  /** Optional display aliases, e.g. `{ "qwen": "dashscope" }`. */
  providerAliases: Record<string, string>;
}

/** Environment overrides read once per call so a restart is never required for the chair. */
export interface EnvironmentOverrides {
  chairModel?: string;
  chairPersona?: string;
  outputDir?: string;
}

/** Resolve the Harness home the same way the installation does. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured);
  return join(homedir(), '.dsh');
}

/** Absolute path of the stored document. */
export function resolveConfigPath(): string {
  return join(resolveDshHome(), 'symposium.json');
}

/** Absolute path of the persona mirror directory. */
export function resolvePersonaDir(): string {
  return join(resolveDshHome(), 'symposium', 'personas');
}

/** Read `CHAIR_MODEL` / `CHAIR_PERSONA` / `SYMPOSIUM_OUTPUT_DIR`. */
export function readEnvironmentOverrides(env: NodeJS.ProcessEnv = process.env): EnvironmentOverrides {
  const nonEmpty = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim().length > 0 ? value : undefined;
  return {
    chairModel: nonEmpty(env.CHAIR_MODEL),
    chairPersona: nonEmpty(env.CHAIR_PERSONA),
    outputDir: nonEmpty(env.SYMPOSIUM_OUTPUT_DIR),
  };
}

/**
 * Split a `CHAIR_MODEL` value into a provider route and a model id.
 * Accepts `provider/model`, `provider:model`, or a bare model id (empty provider).
 * @param raw - the raw environment value.
 * @returns the parsed pair; `model` is empty when `raw` carries no model.
 */
export function parseChairModel(raw: string): { provider: string; model: string } {
  const value = raw.trim();
  const separator = value.search(/[/:]/);
  if (separator <= 0) return { provider: '', model: value };
  return {
    provider: value.slice(0, separator).trim(),
    model: value.slice(separator + 1).trim(),
  };
}

/**
 * Repair the tier table. Missing tiers fall back to the built-in defaults and
 * every field is clamped, so a hand-edited document can never disable the cap.
 * @param value - the raw `tiers` block.
 * @returns all three tiers, fully populated.
 */
function normalizeTiers(value: unknown): Record<BriefTier, TierSpec> {
  const raw = asRecord(value);
  const out = {} as Record<BriefTier, TierSpec>;
  for (const tier of ['quick', 'standard', 'deep'] as const) {
    const entry = asRecord(raw[tier]);
    const base = TIER_DEFAULTS[tier];
    out[tier] = {
      seats: asStringArray(entry.seats).map((id) => id.trim()).filter((id) => id.length > 0),
      rounds: asNumber(entry.rounds, base.rounds, 1, 20),
      maxTokensPerTurn: asNumber(entry.maxTokensPerTurn, base.maxTokensPerTurn, 16, 64_000),
      maxTokens: asNumber(entry.maxTokens, base.maxTokens, 0, 10_000_000),
      maxQuestions: asNumber(entry.maxQuestions, base.maxQuestions, 0, 50),
      chair: asBinding(entry.chair) ?? base.chair,
      seatModel: asBinding(entry.seatModel) ?? base.seatModel,
    };
  }
  return out;
}

/**
 * Read an optional provider/model pair. A half-filled or non-string binding is
 * dropped rather than rejected: the tier simply falls back to its default,
 * which is always safer than refusing to boot the plugin.
 * @param value - the raw `chair` / `seatModel` block.
 * @returns the binding, or `undefined` when it is unusable.
 */
function asBinding(value: unknown): ModelBinding | undefined {
  const raw = asRecord(value);
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/** Fresh default document. */
export function defaultConfig(): SymposiumConfig {
  return {
    version: 1,
    brief: { topic: '' },
    firstRoundBlind: true,
    visibilityPolicy: 'previous_rounds',
    maxRounds: 3,
    maxTokensPerTurn: 1024,
    requestTimeoutMs: 60_000,
    tokenBudget: 24_000,
    keepRecentRounds: 2,
    sensitiveThreshold: 3,
    outputDir: '',
    tiers: normalizeTiers(undefined),
    defaultTier: 'standard',
    maxRunTokens: 0,
    maxQuestions: 0,
    sages: [],
    chair: { enabled: true, provider: '', model: '', persona: '' },
    sensitive: { builtin: true, words: [], patterns: [] },
    providerAliases: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Normalize the agenda pack. A legacy plain-string `topic` (upstream
 * roundtable-harness config) is accepted and wrapped; a record is read
 * field by field. Empty materials entries are dropped.
 */
function normalizeBrief(value: unknown, legacyTopic: unknown, fallback: Brief): Brief {
  const raw = typeof value === 'string' ? { topic: value } : asRecord(value);
  const topic = asString(raw.topic, '').trim()
    || asString(legacyTopic, '').trim()
    || fallback.topic;
  const background = asString(raw.background, '').trim();
  const materials = asStringArray(raw.materials).filter((item) => item.trim().length > 0);
  const draft = asString(raw.proposal, '').trim();
  const decisionPoints = Array.isArray(raw.decisionPoints)
    ? raw.decisionPoints.map((entry): DecisionPoint | undefined => {
      const item = asRecord(entry);
      const id = asString(item.id, '').trim();
      const title = asString(item.title, '').trim();
      if (id.length === 0 || title.length === 0) return undefined;
      const options = asStringArray(item.options).filter((option) => option.trim().length > 0);
      const lean = asString(item.lean, '').trim();
      return {
        id,
        title,
        ...options.length > 0 ? { options } : {},
        ...lean.length > 0 ? { lean } : {},
      };
    }).filter((entry): entry is DecisionPoint => entry !== undefined)
    : [];
  const locked = asStringArray(raw.locked).filter((item) => item.trim().length > 0);
  const invariants = asStringArray(raw.invariants).filter((item) => item.trim().length > 0);
  const assumptions = Array.isArray(raw.assumptions)
    ? raw.assumptions.map((entry): Assumption | undefined => {
      const item = asRecord(entry);
      const text = asString(item.text, '').trim();
      if (text.length === 0) return undefined;
      return { text, verified: item.verified === true };
    }).filter((entry): entry is Assumption => entry !== undefined)
    : [];
  const rejected = Array.isArray(raw.rejected)
    ? raw.rejected.map((entry): { proposal: string; reason: string } | undefined => {
      const item = asRecord(entry);
      const proposal = asString(item.proposal, '').trim();
      if (proposal.length === 0) return undefined;
      return { proposal, reason: asString(item.reason, '').trim() };
    }).filter((entry): entry is { proposal: string; reason: string } => entry !== undefined)
    : [];
  // "Empty array = declared" is part of the tier contract, so presence of the
  // key — not the length of its value — decides whether a field was declared.
  const declared = new Set(Object.keys(raw));
  return {
    topic,
    ...background.length > 0 ? { background } : {},
    ...materials.length > 0 ? { materials } : {},
    ...(declared.has('proposal') || draft.length > 0) ? { proposal: draft } : {},
    ...decisionPoints.length > 0 ? { decisionPoints } : {},
    ...declared.has('locked') || locked.length > 0 ? { locked } : {},
    ...declared.has('invariants') || invariants.length > 0 ? { invariants } : {},
    ...declared.has('assumptions') || assumptions.length > 0 ? { assumptions } : {},
    ...declared.has('rejected') || rejected.length > 0 ? { rejected } : {},
  };
}

/**
 * Check the agenda pack against the tier contract before a run starts.
 *
 * The full tiers require every section to be *declared*: an empty array is a
 * deliberate "there is nothing in this section", a missing field is an
 * undeclared one. `quick` only needs the topic and the decision points.
 * @param brief - the pack as stored or supplied by the caller.
 * @param tier - which contract to apply.
 * @returns the defects; empty means the pack is acceptable.
 */
export function validateBrief(brief: Brief, tier: BriefTier = 'standard', mode: BriefMode = 'design'): string[] {
  const defects: string[] = [];
  if (brief.topic.trim().length === 0) defects.push('topic 为空：研讨会必须有一个议题');
  const points = brief.decisionPoints ?? [];
  if (points.length === 0) {
    defects.push('decisionPoints 为空：至少给一个开放决策点（D1、D2…）');
  }
  const idPattern = mode === 'plan' ? /^[DW]\d+$/ : /^D\d+$/;
  const seen = new Set<string>();
  for (const point of points) {
    if (!idPattern.test(point.id)) {
      defects.push(mode === 'plan'
        ? `决策点 id「${point.id}」不合规：plan 模式必须形如 W1、W2（工作包）或 D1、D2`
        : `决策点 id「${point.id}」不合规：必须形如 D1、D2`);
    }
    if (seen.has(point.id)) defects.push(`决策点 id「${point.id}」重复`);
    seen.add(point.id);
  }
  if (tier === 'quick') return defects;
  const required: [keyof Brief, string][] = [
    ['proposal', 'proposal 草案正文'],
    ['locked', 'locked 已锁定项'],
    ['invariants', 'invariants 不变量'],
    ['assumptions', 'assumptions 假设'],
    ['rejected', 'rejected 已否决方案'],
  ];
  for (const [key, label] of required) {
    if (brief[key] === undefined) defects.push(`缺少 ${label}：请显式声明（无内容给空数组/空串）`);
  }
  return defects;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Repair one sage entry read from disk. A seat without a model binding is
 * kept — stance is the identity anchor, not the model; the engine skips
 * unbound seats per run and records an anomaly.
 */
function normalizeSage(value: unknown, index: number): SageConfig {
  const raw = asRecord(value);
  const name = asString(raw.name, '').trim() || `贤者 ${index + 1}`;
  const id = slug(asString(raw.id, '').trim() || name, `sage-${index + 1}`);
  // A persona file is only ever a name inside the persona directory. An
  // absolute path or a `..` escape is dropped here, so no other code path — the
  // reader, the writer, or the report — ever has to re-check it.
  const rawPersonaFile = asString(raw.personaFile, '').trim();
  const personaFile = isSafePersonaFile(rawPersonaFile) ? rawPersonaFile : '';
  return {
    id,
    name,
    stance: asString(raw.stance, ''),
    duties: asStringArray(raw.duties),
    provider: asString(raw.provider, '').trim(),
    model: asString(raw.model, '').trim(),
    persona: asString(raw.persona, ''),
    ...personaFile.length > 0 ? { personaFile } : {},
    ...raw.cheap === true ? { cheap: true } : {},
    ...raw.view === 'problem-only' ? { view: 'problem-only' as const } : {},
  };
}

/**
 * Whether a persona-file value is usable.
 *
 * Accepts only a relative path that stays inside the persona directory: no
 * absolute path, no `..` segment, no NUL, no drive-relative form.
 * @param value - the raw field value.
 * @returns `true` when the value may be resolved against the persona directory.
 */
export function isSafePersonaFile(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('\0')) return false;
  if (isAbsolute(trimmed)) return false;
  // Windows drive-relative (`C:foo`) and UNC-ish leading separators.
  if (/^[A-Za-z]:/.test(trimmed)) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
  const segments = trimmed.split(/[\\/]+/);
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Turn arbitrary text into a file-safe slug.
 * @param value - source text.
 * @param fallback - used when the text yields no usable characters.
 * @returns a lowercase `[a-z0-9-]` slug.
 */
export function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Normalize a document read from disk or supplied by the settings page.
 * Unknown keys are dropped and out-of-range numbers are clamped, so a hand
 * edit can never wedge the engine.
 * @param value - raw document.
 * @returns a complete, in-range configuration.
 */
export function normalizeConfig(value: unknown): SymposiumConfig {
  const base = defaultConfig();
  const raw = asRecord(value);
  const chairRaw = asRecord(raw.chair ?? raw.judge);
  const sensitiveRaw = asRecord(raw.sensitive);
  // `participants` was the upstream roundtable-harness key; reading it here
  // migrates an old config in one load — saving then persists it as `sages`.
  const sagesRaw = Array.isArray(raw.sages) ? raw.sages : Array.isArray(raw.participants) ? raw.participants : [];
  const sages: SageConfig[] = [];
  /** Ids already taken; a duplicate would merge two speakers' scores and costs. */
  const usedIds = new Set<string>();
  for (const [index, entry] of sagesRaw.entries()) {
    const sage = normalizeSage(entry, index);
    if (usedIds.has(sage.id)) {
      // Keep the sage, rename it: dropping a configured speaker because
      // two names slugged to the same id would silently shrink the field.
      let suffix = 2;
      while (usedIds.has(`${sage.id}-${suffix}`)) suffix += 1;
      sage.id = `${sage.id}-${suffix}`;
    }
    usedIds.add(sage.id);
    sages.push(sage);
  }
  const aliasesRaw = asRecord(raw.providerAliases);
  const providerAliases: Record<string, string> = {};
  for (const [key, alias] of Object.entries(aliasesRaw)) {
    if (typeof alias === 'string' && key.trim().length > 0 && alias.trim().length > 0) {
      providerAliases[key.trim()] = alias.trim();
    }
  }
  return {
    version: base.version,
    brief: normalizeBrief(raw.brief, raw.topic, base.brief),
    firstRoundBlind: raw.firstRoundBlind !== false,
    visibilityPolicy: raw.visibilityPolicy === 'incremental' ? 'incremental' : 'previous_rounds',
    maxRounds: asNumber(raw.maxRounds, base.maxRounds, 1, 20),
    maxTokensPerTurn: asNumber(raw.maxTokensPerTurn, base.maxTokensPerTurn, 16, 64_000),
    requestTimeoutMs: asNumber(raw.requestTimeoutMs, base.requestTimeoutMs, 1_000, 600_000),
    tokenBudget: asNumber(raw.tokenBudget, base.tokenBudget, 512, 1_000_000),
    keepRecentRounds: asNumber(raw.keepRecentRounds, base.keepRecentRounds, 0, 10),
    tiers: normalizeTiers(raw.tiers),
    defaultTier: raw.defaultTier === 'quick' || raw.defaultTier === 'deep' ? raw.defaultTier : 'standard',
    maxRunTokens: asNumber(raw.maxRunTokens, base.maxRunTokens, 0, 10_000_000),
    maxQuestions: asNumber(raw.maxQuestions, base.maxQuestions, 0, 50),
    sensitiveThreshold: asNumber(raw.sensitiveThreshold, base.sensitiveThreshold, 1, 100),
    outputDir: asString(raw.outputDir, base.outputDir),
    sages,
    chair: {
      enabled: chairRaw.enabled !== false,
      provider: asString(chairRaw.provider, '').trim(),
      model: asString(chairRaw.model, '').trim(),
      persona: asString(chairRaw.persona, ''),
    },
    sensitive: {
      builtin: sensitiveRaw.builtin !== false,
      words: asStringArray(sensitiveRaw.words),
      patterns: asStringArray(sensitiveRaw.patterns),
    },
    providerAliases,
  };
}

/**
 * Apply `CHAIR_MODEL` / `CHAIR_PERSONA` / `SYMPOSIUM_OUTPUT_DIR` on top of a document.
 * @param config - the stored configuration.
 * @param overrides - values read from the environment.
 * @returns a new configuration; the input is not mutated.
 */
export function applyEnvironmentOverrides(
  config: SymposiumConfig,
  overrides: EnvironmentOverrides,
): SymposiumConfig {
  const next: SymposiumConfig = {
    ...config,
    chair: { ...config.chair },
  };
  if (overrides.chairModel !== undefined) {
    const parsed = parseChairModel(overrides.chairModel);
    next.chair.enabled = true;
    if (parsed.provider.length > 0) next.chair.provider = parsed.provider;
    if (parsed.model.length > 0) next.chair.model = parsed.model;
  }
  if (overrides.chairPersona !== undefined) next.chair.persona = overrides.chairPersona;
  if (overrides.outputDir !== undefined) next.outputDir = overrides.outputDir;
  return next;
}

/** Read the stored document, falling back to defaults when it is absent or unreadable. */
export function loadConfig(path: string = resolveConfigPath()): SymposiumConfig {
  try {
    if (!existsSync(path)) return defaultConfig();
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    console.warn(`[symposium] 读取 ${path} 失败，改用默认配置：${(error as Error).message}`);
    return defaultConfig();
  }
}

/**
 * Write the document atomically (temp file + rename), so a crash mid-write
 * cannot truncate a working configuration.
 * @param config - the document to persist.
 * @param path - destination; defaults to the resolved path.
 */
export function saveConfig(config: SymposiumConfig, path: string = resolveConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Deep-merge a patch into the stored document and persist it.
 * Arrays replace wholesale, so a sage list edit is never half-applied.
 * @param patch - partial document from the settings page.
 * @param path - document path; defaults to the resolved path.
 * @returns the merged, normalized document.
 */
export function mergeConfig(
  patch: unknown,
  path: string = resolveConfigPath(),
): SymposiumConfig {
  const current = loadConfig(path) as unknown as Record<string, unknown>;
  const incoming = asRecord(patch);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const existing = current[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      merged[key] = { ...existing as Record<string, unknown>, ...asRecord(value) };
    } else {
      merged[key] = value;
    }
  }
  const next = normalizeConfig(merged);
  saveConfig(next, path);
  ensurePersonaFiles(next);
  return next;
}

/**
 * Replace the stored agenda pack wholesale.
 *
 * A brief is a contract, not a bag of preferences. `mergeConfig` shallow-merges
 * objects, so reusing it for a brief leaves the previous pack's
 * `proposal`/`background` attached to a brand-new topic — observed 2026-10-28:
 * a fresh quick run about de-structuring got minuted as a plan review of the
 * previous session's close-write entry, because the stale proposal rode along.
 * @param brief - the complete pack to store.
 * @param path - document path; defaults to the resolved path.
 * @returns the reloaded document.
 */
export function replaceBrief(brief: Brief, path: string = resolveConfigPath()): SymposiumConfig {
  const current = loadConfig(path) as unknown as Record<string, unknown>;
  const next = normalizeConfig({ ...current, brief });
  saveConfig(next, path);
  ensurePersonaFiles(next);
  return next;
}

/**
 * Fold one tier's defaults into a run config.
 *
 * The tier supplies round count, per-turn cap, run ceiling and — when the
 * document declares them — a chair binding and a uniform seat binding. An
 * explicit `rounds` argument always wins over the tier's own count. The result
 * is a copy: nothing here is written back to the document, so a cheap tier
 * never rewrites the seat bindings the owner configured.
 * @param config - the loaded document.
 * @param tier - which tier to apply.
 * @param rounds - explicit round override; 0 means "use the tier".
 * @param log - optional observer for skipped or missing seats.
 * @returns a new config for this run.
 */
export function applyTier(
  config: SymposiumConfig,
  tier: BriefTier,
  rounds: number,
  log: (line: string) => void = () => {},
): SymposiumConfig {
  const spec = config.tiers[tier];
  let next = config;
  if (spec.seats.length > 0) {
    const invited = new Set(spec.seats);
    const kept = next.sages.filter((sage) => invited.has(sage.id));
    if (kept.length > 0) {
      next = { ...next, sages: kept };
      log(`[symposium] 档位 ${tier} 限定席位：${kept.map((sage) => sage.id).join('、')}`);
    } else {
      log(`[symposium] 档位 ${tier} 的 seats 全部未配置（${spec.seats.join('、')}），回退全员`);
    }
    for (const id of spec.seats.filter((id) => !config.sages.some((sage) => sage.id === id))) {
      log(`[symposium] 档位 ${tier} 的席位 ${id} 未配置，已忽略`);
    }
  }
  next = {
    ...next,
    maxRounds: rounds > 0 ? Math.min(20, Math.max(1, Math.trunc(rounds))) : spec.rounds,
    maxTokensPerTurn: spec.maxTokensPerTurn,
    maxRunTokens: spec.maxTokens,
    maxQuestions: spec.maxQuestions,
  };
  if (spec.seatModel !== undefined) {
    const binding = spec.seatModel;
    next = {
      ...next,
      sages: next.sages.map((sage) => ({ ...sage, provider: binding.provider, model: binding.model })),
    };
    log(`[symposium] 档位 ${tier} 全员改用 ${binding.provider}/${binding.model}`);
  }
  if (spec.chair !== undefined) {
    const binding = spec.chair;
    next = { ...next, chair: { ...next.chair, provider: binding.provider, model: binding.model } };
    log(`[symposium] 档位 ${tier} 主席改用 ${binding.provider}/${binding.model}`);
  }
  return next;
}

/** Absolute path of one sage's persona mirror. */
export function personaFilePath(participantId: string): string {
  return join(resolvePersonaDir(), `${slug(participantId, 'sage')}.md`);
}

/**
 * Resolve the persona file one sage reads and writes.
 *
 * The result is always inside the persona directory: an unsafe `personaFile`
 * falls back to the sage's own `<id>.md`, so a hand-edited document can
 * never turn this field into an arbitrary read or write.
 * @param sage - the sage whose persona file to resolve.
 * @returns an absolute path inside the persona directory.
 */
export function resolvePersonaTarget(sage: SageConfig): string {
  const dir = resolvePersonaDir();
  const declared = sage.personaFile;
  if (declared === undefined || !isSafePersonaFile(declared)) return personaFilePath(sage.id);
  const candidate = resolve(dir, declared);
  const rel = relative(dir, candidate);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    return personaFilePath(sage.id);
  }
  return candidate;
}

/**
 * Mirror every inline persona into the persona directory.
 * The mirror is what makes a persona diffable and hand-editable; it is written
 * only when its content would change, so saving settings is not a disk churn.
 * @param config - the document whose sages to mirror.
 */
export function ensurePersonaFiles(config: SymposiumConfig): void {
  mkdirSync(resolvePersonaDir(), { recursive: true });
  for (const sage of config.sages) {
    if (sage.persona.trim().length === 0) continue;
    const target = resolvePersonaTarget(sage);
    try {
      if (existsSync(target) && readFileSync(target, 'utf8') === sage.persona) continue;
      writeFileSync(target, sage.persona, 'utf8');
    } catch (error) {
      console.warn(`[symposium] 写入人格文件 ${target} 失败：${(error as Error).message}`);
    }
  }
}

/**
 * Resolve the persona text used for one sage at call time.
 * The persona file wins over the inline text so a hand edit takes effect without
 * going through the settings page; the path is always the sanitized one.
 * @param sage - the sage to resolve.
 * @returns the persona text, or `''` when neither source has content.
 */
export function resolvePersona(sage: SageConfig): string {
  // A mirror only speaks for the sage while there is something for it to
  // mirror, or while the document named that file explicitly. Clearing the
  // inline persona therefore clears the persona, instead of resurrecting a
  // stale file.
  const mirrorAuthoritative = sage.persona.trim().length > 0 || sage.personaFile !== undefined;
  if (mirrorAuthoritative) {
    const target = resolvePersonaTarget(sage);
    try {
      if (existsSync(target)) {
        const text = readFileSync(target, 'utf8');
        if (text.trim().length > 0) return text;
      }
    } catch {
      // A missing or unreadable mirror simply falls through to the inline text.
    }
  }
  return sage.persona;
}

/**
 * Resolve the directory that reports are written into.
 *
 * An empty `outputDir` used to mean "the host process's working directory",
 * which on this machine was the *profile* directory — the export really did
 * write there, but it is a program directory, it sits on the system drive, and
 * nobody thinks to look inside it. The default is now `$DSH_HOME/symposium`,
 * next to `personas/`, so reports live with the rest of the plugin's data.
 *
 * A relative path still resolves against the working directory, so "reports"
 * keeps meaning what it looks like: relative to the host.
 * @param config - the stored configuration.
 * @returns an absolute directory path (not guaranteed to exist yet).
 */
export function resolveOutputDir(config: SymposiumConfig): string {
  const configured = config.outputDir.trim();
  if (configured.length === 0) return join(resolveDshHome(), 'symposium', 'reports');
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * Create the output directory if it is missing.
 *
 * Writing a report used to assume the directory existed; a first run with a
 * fresh `$DSH_HOME` therefore failed with ENOENT instead of just working.
 * @param directory - the directory to ensure.
 */
export function ensureOutputDir(directory: string): void {
  mkdirSync(directory, { recursive: true });
}
