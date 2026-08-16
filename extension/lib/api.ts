/**
 * Backend client. EVERY network call the extension makes goes through here
 * (CLAUDE.md § Engineering conventions) — no direct third-party calls from the
 * extension, so there is exactly one place that knows about auth, retries and
 * error shapes.
 *
 * The extension holds no API keys. Enrichment is proxied by the Worker, which
 * is the only thing that knows the provider key (docs/08 §1).
 */

import type {
  ApiError,
  AuthTokenResponse,
  EnrichBody,
  EnrichResponse,
  HealthResponse,
  MeResponse,
  QuotaCommitBody,
  QuotaCommitResponse,
  QuotaReserveBody,
  QuotaReserveResponse,
  RequestLinkResponse,
  SelectorConfigResponse,
  TelemetryBody,
} from '@recruitexport/shared';
import { getSession, saveSession, type Session } from './storage';

export const API_BASE: string =
  (import.meta.env?.WXT_API_BASE as string | undefined) ?? 'http://localhost:8787';

export const EXTENSION_VERSION: string =
  (import.meta.env?.WXT_VERSION as string | undefined) ??
  (typeof chrome !== 'undefined' ? chrome.runtime?.getManifest?.()?.version : undefined) ??
  '0.0.0';

/** Thrown for any non-2xx. Carries the backend's error envelope (docs/05 §8). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Backend unreachable / offline — drives state E3 (docs/06 §2). */
  get isOffline(): boolean {
    return this.status === 0;
  }

  get isQuotaExhausted(): boolean {
    return this.code === 'quota_exhausted';
  }

  get isRolling24hHit(): boolean {
    return this.status === 429 && this.code === 'rolling_limit';
  }

  get isPlanRequired(): boolean {
    return this.code === 'plan_required';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
  /** ms; a slow backend must not hang a job forever. */
  timeoutMs?: number;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, timeoutMs = 15_000 } = opts;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (auth) {
    const session = await getSession();
    if (!session) {
      throw new ApiRequestError(401, 'not_signed_in', 'Sign in to continue.');
    }
    headers['authorization'] = `Bearer ${session.token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiRequestError(0, 'offline', 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const err = (parsed ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(
      res.status,
      err.error ?? `http_${res.status}`,
      err.message ?? `Request failed (${res.status}).`,
      err as Record<string, unknown>,
    );
  }

  return parsed as T;
}

// ─── auth (docs/05 §1) ───────────────────────────────────────────────────────

export function requestMagicLink(email: string): Promise<RequestLinkResponse> {
  return request('/auth/request-link', {
    method: 'POST',
    body: { email },
    auth: false,
  });
}

/** Store a token handed over by the auth page (docs/05 §1). */
export async function adoptToken(payload: AuthTokenResponse): Promise<Session> {
  const session: Session = {
    token: payload.token,
    email: payload.email,
    expiresAt: payload.expiresAt,
  };
  await saveSession(session);
  return session;
}

export async function refreshToken(): Promise<Session | null> {
  try {
    const res = await request<AuthTokenResponse>('/auth/refresh', { method: 'POST' });
    return adoptToken(res);
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  await saveSession(null);
}

// ─── account ─────────────────────────────────────────────────────────────────

export function getMe(): Promise<MeResponse> {
  return request('/me');
}

// ─── selector config (public — needed before login) ──────────────────────────

export function getSelectorConfig(profile: string): Promise<SelectorConfigResponse> {
  const qs = new URLSearchParams({ profile, v: EXTENSION_VERSION });
  return request(`/config/selectors?${qs.toString()}`, { auth: false, timeoutMs: 8000 });
}

// ─── quota ───────────────────────────────────────────────────────────────────

export function reserveQuota(body: QuotaReserveBody): Promise<QuotaReserveResponse> {
  return request('/quota/reserve', { method: 'POST', body });
}

export function commitQuota(body: QuotaCommitBody): Promise<QuotaCommitResponse> {
  return request('/quota/commit', { method: 'POST', body });
}

// ─── enrichment ──────────────────────────────────────────────────────────────

export function enrichBatch(body: EnrichBody): Promise<EnrichResponse> {
  // Generous timeout: the provider gets a 10s/row budget server-side (docs/05 §5).
  return request('/enrich', { method: 'POST', body, timeoutMs: 60_000 });
}

// ─── telemetry (no auth, rate-limited by IP) ─────────────────────────────────

export async function sendTelemetry(body: TelemetryBody): Promise<void> {
  try {
    await request('/telemetry', { method: 'POST', body, auth: false, timeoutMs: 5000 });
  } catch {
    // Telemetry must never affect the user's job.
  }
}

export function health(): Promise<HealthResponse> {
  return request('/healthz', { auth: false, timeoutMs: 5000 });
}
