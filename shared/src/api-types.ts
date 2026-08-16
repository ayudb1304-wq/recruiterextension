/** Request/response shapes for the backend API. docs/05. */

import type {
  EmailStatus,
  Plan,
  ProfileId,
  SubscriptionStatus,
  TelemetryEvent,
} from './types';

/** Every non-2xx response uses this envelope (docs/05 §8). */
export interface ApiError {
  error: string;
  message: string;
  [extra: string]: unknown;
}

// ─── Auth (docs/05 §1) ───────────────────────────────────────────────────────

export interface RequestLinkBody {
  email: string;
}
/** Always `{ok:true}` — no account enumeration. */
export interface RequestLinkResponse {
  ok: true;
}

export interface AuthTokenResponse {
  token: string;
  /** ISO 8601 UTC */
  expiresAt: string;
  email: string;
}

// ─── Account (docs/05 §2) ────────────────────────────────────────────────────

export interface UsageSnapshot {
  rowsExported: number;
  rowsEnriched: number;
  monthCap: number;
  enrichCap: number;
  rolling24h: number;
  rolling24hCap: number;
}

export interface MeResponse {
  email: string;
  plan: Plan;
  status: SubscriptionStatus;
  /** ISO 8601 UTC, null on free */
  periodEnd: string | null;
  usage: UsageSnapshot;
  checkoutUrls: Record<Exclude<Plan, 'free'>, string>;
  portalUrl: string;
}

// ─── Selector config (docs/05 §3) ────────────────────────────────────────────

export interface SelectorConfigResponse {
  configVersion: string;
  /** validated against the zod schema in extension/lib/extraction/config-schema.ts */
  profile: unknown;
}

// ─── Quota (docs/05 §4) ──────────────────────────────────────────────────────

export interface QuotaReserveBody {
  estimatedRows: number;
  enrich: boolean;
}

export interface QuotaReserveResponse {
  jobToken: string;
  allowedRows: number;
  enrichAllowed: boolean;
  /** ISO 8601 UTC, reservation TTL (2h) */
  expiresAt: string;
}

export interface QuotaCommitBody {
  jobToken: string;
  actualRows: number;
  actualEnriched: number;
}

export interface QuotaCommitResponse {
  ok: true;
  usage: UsageSnapshot;
}

// ─── Enrichment (docs/05 §5) ─────────────────────────────────────────────────

export const ENRICH_BATCH_MAX = 25;

export interface EnrichRow {
  rowId: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyDomainGuess: string | null;
}

export interface EnrichBody {
  jobToken: string;
  batch: EnrichRow[];
}

export interface EnrichResult {
  rowId: string;
  email: string | null;
  emailStatus: EmailStatus;
  companyDomain: string | null;
}

export interface EnrichResponse {
  results: EnrichResult[];
  /** true once the plan's enrichment allowance ran out mid-job (docs/05 §5) */
  allowanceExhausted: boolean;
}

// ─── Telemetry (docs/05 §7) ──────────────────────────────────────────────────

export interface TelemetryBody {
  events: TelemetryEvent[];
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: true;
  version: string;
}

export type { ProfileId };
