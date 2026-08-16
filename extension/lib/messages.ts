/**
 * Typed message protocol between the three extension contexts.
 *
 *   content script  ──port──▶  service worker  ──port──▶  side panel
 *
 * The content script is a DUMB EXTRACTOR (docs/02 §2.1): it holds no business
 * logic — no quota, no enrichment, no output. It reports what it sees and
 * streams rows. All decisions live in the service worker.
 */

import type {
  CandidateRecord,
  ExtractedCard,
  ProfileId,
  TelemetryEvent,
} from '@recruitexport/shared';
import type { Settings } from './storage';

export const CONTENT_PORT = 're.content';
export const PANEL_PORT = 're.panel';

// ─── page status the content script reports ──────────────────────────────────

export type PageStatus =
  | { kind: 'supported'; profileId: ProfileId; resultCountEstimate: number | null; uiLanguage: string | null; isEnglishUi: boolean }
  | { kind: 'unsupported_layout'; profileId: ProfileId }
  | { kind: 'not_a_search_page' };

// ─── content script → service worker ─────────────────────────────────────────

export type ContentToWorker =
  | { type: 'hello'; href: string; status: PageStatus; configSource: string; configVersion: string }
  | { type: 'status'; href: string; status: PageStatus }
  /** A page's worth of extracted cards. Rows are streamed, never batched to the end. */
  | { type: 'cards'; jobId: string; pageNumber: number; cards: ExtractedCard[]; extractionRate: number; fieldMisses: Record<string, number>; cardsFound: number }
  /** Scrape finished on the content side. */
  | { type: 'scrapeEnd'; jobId: string; reason: ScrapeEndReason; pagesVisited: number }
  /** LinkedIn showed an interstitial — abort immediately, never auto-retry. */
  | { type: 'platformWarning'; jobId: string }
  | { type: 'extractorException'; field: string; message: string }
  /** Dev-only fixture capture (docs/03 §7), gated on WXT_DEV_CAPTURE. */
  | { type: 'fixtureCaptured'; html: string; profileId: ProfileId };

export type ScrapeEndReason =
  | 'reached_cap'
  | 'no_more_pages'
  | 'cancelled'
  | 'platform_warning'
  | 'page_cap'
  | 'navigated_away'
  | 'error';

// ─── service worker → content script ─────────────────────────────────────────

export type WorkerToContent =
  | { type: 'startScrape'; jobId: string; rowCap: number; rolling24hUsed: number }
  | { type: 'cancel'; jobId: string }
  | { type: 'requestStatus' }
  | { type: 'captureFixture' };

// ─── job state (docs/02 §2.2) ────────────────────────────────────────────────

export type JobPhase =
  | 'idle'
  | 'checking_quota'
  | 'scraping'
  | 'enriching'
  | 'building_output'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobProgress {
  page: number;
  pagesTotal: number | null;
  rows: number;
  enriched: number;
  skippedDuplicates: number;
  /** Rolling page-level extraction rate — drives the health chip (docs/06 §S3). */
  extractionRate: number;
}

export interface JobError {
  /** Maps to the E-states in docs/06 §2. */
  code:
    | 'quota_exhausted'
    | 'rolling_limit'
    | 'offline'
    | 'platform_warning'
    | 'plan_required'
    | 'not_signed_in'
    | 'unsupported_layout'
    | 'no_results'
    | 'sheets_auth'
    | 'unknown';
  message: string;
  /** e.g. checkoutUrl for plan_required, retryAfter for rolling_limit. */
  extra?: Record<string, unknown>;
}

export interface JobState {
  jobId: string | null;
  phase: JobPhase;
  progress: JobProgress;
  error: JobError | null;
  /** Set when the job ended with fewer rows than asked for (docs/06 §S4). */
  partialReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** True once enrichment allowance ran out mid-job (docs/05 §5). */
  allowanceExhausted: boolean;
}

export const IDLE_JOB: JobState = {
  jobId: null,
  phase: 'idle',
  progress: { page: 0, pagesTotal: null, rows: 0, enriched: 0, skippedDuplicates: 0, extractionRate: 1 },
  error: null,
  partialReason: null,
  startedAt: null,
  finishedAt: null,
  allowanceExhausted: false,
};

// ─── side panel ⇄ service worker ─────────────────────────────────────────────

export interface ExportRequest {
  rowCap: number;
  enrich: boolean;
  skipDuplicates: boolean;
  presetId: string;
  destination: 'csv' | 'sheets';
}

export type PanelToWorker =
  | { type: 'getState' }
  | { type: 'startExport'; request: ExportRequest }
  | { type: 'cancel' }
  | { type: 'requestMagicLink'; email: string }
  | { type: 'signOut' }
  | { type: 'refreshAccount' }
  | { type: 'saveSettings'; patch: Partial<Settings> }
  | { type: 'redownload' }
  | { type: 'pushToSheets' }
  | { type: 'clearHistory' }
  | { type: 'captureFixture' };

export interface PanelSnapshot {
  job: JobState;
  page: PageStatus;
  settings: Settings;
  account: import('@recruitexport/shared').MeResponse | null;
  signedIn: boolean;
  /** Client mirror of the rolling-24h counter (docs/03 §6). */
  rolling24hUsed: number;
  /** Which selector config we ended up on — surfaced in the debug footer. */
  configSource: string;
  configVersion: string;
  /** Result of the last finished job, for the S4 done screen. */
  lastResult: LastResult | null;
  extensionVersion: string;
}

export interface LastResult {
  rows: number;
  enriched: number;
  verified: number;
  skippedDuplicates: number;
  extractionRate: number;
  outcome: 'done' | 'cancelled' | 'failed' | 'partial';
  presetId: string;
  destination: 'csv' | 'sheets';
  sheetUrl: string | null;
  finishedAt: string;
}

export type WorkerToPanel =
  | { type: 'snapshot'; snapshot: PanelSnapshot }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; message: string }
  | { type: 'magicLinkSent' }
  | { type: 'fixtureCaptured'; filename: string };

// ─── in-memory job rows (never persisted — docs/04 §5) ───────────────────────

export interface JobRow {
  card: ExtractedCard;
  record: CandidateRecord;
}

export type { TelemetryEvent };
