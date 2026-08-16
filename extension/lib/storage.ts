/**
 * Typed chrome.storage wrappers.
 *
 * local  — job history, dedupe hashes, cached config, session token.
 * sync   — user settings and preset edits (small, follows the user).
 *
 * What is NEVER stored anywhere: candidate records. Only dedupe hashes
 * (docs/04 §3, docs/08 §5).
 */

import type { MeResponse, Plan } from '@recruitexport/shared';
import { DEDUPE_HISTORY_MAX, DEFAULT_ROW_CAP } from '@recruitexport/shared';

export interface Settings {
  defaultPreset: string;
  defaultRowCap: number;
  skipAlreadyExported: boolean;
  enrichByDefault: boolean;
  telemetryOptOut: boolean;
  destination: 'csv' | 'sheets';
  /** Google Sheets spreadsheet id chosen on first Sheets push. */
  sheetId: string | null;
  /** One-time CWS review ask (docs/06 §S4) — dismissed forever once true. */
  reviewAskDismissed: boolean;
  reviewAskShown: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultPreset: 'generic',
  defaultRowCap: DEFAULT_ROW_CAP,
  skipAlreadyExported: true,
  enrichByDefault: false,
  telemetryOptOut: false,
  destination: 'csv',
  sheetId: null,
  reviewAskDismissed: false,
  reviewAskShown: false,
};

export interface JobHistoryEntry {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  rows: number;
  enriched: number;
  skippedDuplicates: number;
  extractionRate: number;
  profileId: string;
  outcome: 'done' | 'cancelled' | 'failed' | 'partial';
  preset: string;
}

export interface Session {
  token: string;
  email: string;
  expiresAt: string;
}

const LOCAL_KEYS = {
  session: 're.session',
  dedupeHashes: 're.dedupeHashes',
  jobHistory: 're.jobHistory',
  cachedConfig: 're.cachedConfig',
  cachedMe: 're.cachedMe',
  pendingCommits: 're.pendingCommits',
  pendingTelemetry: 're.pendingTelemetry',
  rolling24h: 're.rolling24h',
} as const;

const SYNC_KEYS = {
  settings: 're.settings',
  presetOverrides: 're.presetOverrides',
} as const;

async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const got = await chrome.storage.local.get(key);
  return (got[key] as T | undefined) ?? fallback;
}

async function setLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function getSync<T>(key: string, fallback: T): Promise<T> {
  const got = await chrome.storage.sync.get(key);
  return (got[key] as T | undefined) ?? fallback;
}

async function setSync(key: string, value: unknown): Promise<void> {
  await chrome.storage.sync.set({ [key]: value });
}

// ─── settings ────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  const stored = await getSync<Partial<Settings>>(SYNC_KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await setSync(SYNC_KEYS.settings, next);
  return next;
}

// ─── preset overrides (docs/06 §S6) ──────────────────────────────────────────

/** presetId → user-edited column list. "Reset to default" deletes the entry. */
export type PresetOverrides = Record<string, unknown>;

export async function getPresetOverrides(): Promise<PresetOverrides> {
  return getSync<PresetOverrides>(SYNC_KEYS.presetOverrides, {});
}

export async function savePresetOverride(id: string, columns: unknown): Promise<void> {
  const all = await getPresetOverrides();
  all[id] = columns;
  await setSync(SYNC_KEYS.presetOverrides, all);
}

export async function clearPresetOverride(id: string): Promise<void> {
  const all = await getPresetOverrides();
  delete all[id];
  await setSync(SYNC_KEYS.presetOverrides, all);
}

// ─── session ─────────────────────────────────────────────────────────────────

export async function getSession(): Promise<Session | null> {
  return getLocal<Session | null>(LOCAL_KEYS.session, null);
}

export async function saveSession(session: Session | null): Promise<void> {
  await setLocal(LOCAL_KEYS.session, session);
}

// ─── cached /me (so the panel renders < 100ms — docs/06 §4) ──────────────────

export async function getCachedMe(): Promise<MeResponse | null> {
  return getLocal<MeResponse | null>(LOCAL_KEYS.cachedMe, null);
}

export async function saveCachedMe(me: MeResponse | null): Promise<void> {
  await setLocal(LOCAL_KEYS.cachedMe, me);
}

export function planOf(me: MeResponse | null): Plan {
  return me?.plan ?? 'free';
}

// ─── dedupe history (hashes only) ────────────────────────────────────────────

export async function getDedupeHashes(): Promise<string[]> {
  return getLocal<string[]>(LOCAL_KEYS.dedupeHashes, []);
}

export async function saveDedupeHashes(hashes: readonly string[]): Promise<void> {
  await setLocal(LOCAL_KEYS.dedupeHashes, hashes.slice(-DEDUPE_HISTORY_MAX));
}

export async function clearDedupeHashes(): Promise<void> {
  await setLocal(LOCAL_KEYS.dedupeHashes, []);
}

// ─── job history ─────────────────────────────────────────────────────────────

const JOB_HISTORY_MAX = 50;

export async function getJobHistory(): Promise<JobHistoryEntry[]> {
  return getLocal<JobHistoryEntry[]>(LOCAL_KEYS.jobHistory, []);
}

export async function appendJobHistory(entry: JobHistoryEntry): Promise<void> {
  const history = await getJobHistory();
  history.unshift(entry);
  await setLocal(LOCAL_KEYS.jobHistory, history.slice(0, JOB_HISTORY_MAX));
}

// ─── cached selector config ──────────────────────────────────────────────────

export interface CachedConfig {
  fetchedAt: string;
  raw: unknown;
}

export async function getCachedConfig(): Promise<CachedConfig | null> {
  return getLocal<CachedConfig | null>(LOCAL_KEYS.cachedConfig, null);
}

export async function saveCachedConfig(raw: unknown): Promise<void> {
  await setLocal(LOCAL_KEYS.cachedConfig, {
    fetchedAt: new Date().toISOString(),
    raw,
  } satisfies CachedConfig);
}

// ─── offline queues (docs/06 state E3) ───────────────────────────────────────

export interface PendingCommit {
  jobToken: string;
  actualRows: number;
  actualEnriched: number;
  queuedAt: string;
}

export async function getPendingCommits(): Promise<PendingCommit[]> {
  return getLocal<PendingCommit[]>(LOCAL_KEYS.pendingCommits, []);
}

export async function savePendingCommits(commits: readonly PendingCommit[]): Promise<void> {
  await setLocal(LOCAL_KEYS.pendingCommits, commits);
}

export async function getPendingTelemetry<T>(): Promise<T[]> {
  return getLocal<T[]>(LOCAL_KEYS.pendingTelemetry, []);
}

export async function savePendingTelemetry<T>(events: readonly T[]): Promise<void> {
  // Bounded so an offline user cannot grow storage without limit.
  await setLocal(LOCAL_KEYS.pendingTelemetry, events.slice(-200));
}

// ─── client-side mirror of the rolling-24h ceiling (docs/03 §6) ──────────────

export interface RollingEntry {
  at: number;
  rows: number;
}

export async function getRolling24h(): Promise<RollingEntry[]> {
  const entries = await getLocal<RollingEntry[]>(LOCAL_KEYS.rolling24h, []);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return entries.filter((e) => e.at > cutoff);
}

export async function addRolling24h(rows: number): Promise<void> {
  const entries = await getRolling24h();
  entries.push({ at: Date.now(), rows });
  await setLocal(LOCAL_KEYS.rolling24h, entries);
}

export async function rolling24hTotal(): Promise<number> {
  return (await getRolling24h()).reduce((sum, e) => sum + e.rows, 0);
}
