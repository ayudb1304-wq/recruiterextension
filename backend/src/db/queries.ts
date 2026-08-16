/**
 * Every database access in one place, so "what do we store?" has one answer
 * (docs/04 §5): users, subscriptions, counters, config, aggregate telemetry.
 * No candidate data, ever.
 */

import {
  PLAN_LIMITS,
  RESERVATION_TTL_MS,
  type Plan,
  type SubscriptionStatus,
  type UsageSnapshot,
} from '@recruitexport/shared';
import type { Db } from './client';

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface SubscriptionRow {
  user_id: string;
  dodo_customer_id: string | null;
  dodo_subscription_id: string | null;
  plan: Plan;
  status: SubscriptionStatus;
  current_period_end: string | null;
}

export interface UsageRow {
  user_id: string;
  period_ym: string;
  rows_exported: number;
  rows_enriched: number;
  jobs_run: number;
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─── users ───────────────────────────────────────────────────────────────────

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  return db.selectOne<UserRow>('users', `email=eq.${encodeURIComponent(email.toLowerCase())}`);
}

export async function upsertUser(db: Db, email: string): Promise<UserRow> {
  const normalized = email.toLowerCase().trim();
  const existing = await findUserByEmail(db, normalized);
  if (existing) {
    await db.update('users', `id=eq.${existing.id}`, { last_seen_at: new Date().toISOString() });
    return existing;
  }
  const [created] = await db.insert<UserRow>('users', {
    email: normalized,
    last_seen_at: new Date().toISOString(),
  });
  if (!created) throw new Error('user insert returned nothing');
  // Every user starts on free; the webhook upgrades them.
  await db.upsert('subscriptions', { user_id: created.id, plan: 'free', status: 'active' }, 'user_id');
  return created;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | null> {
  return db.selectOne<UserRow>('users', `id=eq.${encodeURIComponent(id)}`);
}

// ─── subscriptions ───────────────────────────────────────────────────────────

export async function getSubscription(db: Db, userId: string): Promise<SubscriptionRow> {
  const row = await db.selectOne<SubscriptionRow>(
    'subscriptions',
    `user_id=eq.${encodeURIComponent(userId)}`,
  );
  return (
    row ?? {
      user_id: userId,
      dodo_customer_id: null,
      dodo_subscription_id: null,
      plan: 'free',
      status: 'active',
      current_period_end: null,
    }
  );
}

/**
 * A past_due or cancelled-and-expired subscription falls back to free limits.
 * We never leave someone on Pro caps because a webhook was missed.
 */
export function effectivePlan(sub: SubscriptionRow, now = new Date()): Plan {
  if (sub.status === 'past_due') return 'free';
  if (sub.status === 'cancelled') {
    if (!sub.current_period_end) return 'free';
    return new Date(sub.current_period_end) > now ? sub.plan : 'free';
  }
  return sub.plan;
}

export async function upsertSubscription(
  db: Db,
  row: Partial<SubscriptionRow> & { user_id: string },
): Promise<void> {
  await db.upsert('subscriptions', { ...row, updated_at: new Date().toISOString() }, 'user_id');
}

// ─── usage ───────────────────────────────────────────────────────────────────

export async function getUsage(db: Db, userId: string, plan: Plan): Promise<UsageSnapshot> {
  const period = currentPeriod();
  const [counter, rolling] = await Promise.all([
    db.selectOne<UsageRow>(
      'usage_counters',
      `user_id=eq.${encodeURIComponent(userId)}&period_ym=eq.${period}`,
    ),
    rolling24hRows(db, userId),
  ]);

  const limits = PLAN_LIMITS[plan];
  return {
    rowsExported: counter?.rows_exported ?? 0,
    rowsEnriched: counter?.rows_enriched ?? 0,
    monthCap: limits.rowsPerMonth,
    enrichCap: limits.enrichedRowsPerMonth,
    rolling24h: rolling,
    rolling24hCap: limits.rowsPerRolling24h,
  };
}

export async function rolling24hRows(db: Db, userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.select<{ rows: number }>(
    'export_events',
    `user_id=eq.${encodeURIComponent(userId)}&at=gt.${since}&select=rows`,
  );
  return rows.reduce((sum, r) => sum + (r.rows ?? 0), 0);
}

// ─── quota (atomic, in the database) ─────────────────────────────────────────

export interface ReservationResult {
  allowed_rows: number;
  enrich_allowed: boolean;
  expires_at: string;
}

export async function reserveQuota(
  db: Db,
  args: { userId: string; jobToken: string; estimatedRows: number; enrich: boolean; plan: Plan },
): Promise<ReservationResult> {
  const limits = PLAN_LIMITS[args.plan];
  const rows = await db.rpc<ReservationResult[]>('reserve_quota', {
    p_user_id: args.userId,
    p_job_token: args.jobToken,
    p_estimated_rows: args.estimatedRows,
    p_enrich: args.enrich,
    p_month_cap: limits.rowsPerMonth,
    p_enrich_cap: limits.enrichedRowsPerMonth,
    p_rolling_cap: limits.rowsPerRolling24h,
    p_ttl: `${Math.round(RESERVATION_TTL_MS / 1000)} seconds`,
  });
  const result = Array.isArray(rows) ? rows[0] : (rows as unknown as ReservationResult);
  if (!result) throw new Error('reserve_quota returned nothing');
  return result;
}

export async function commitQuota(
  db: Db,
  args: { jobToken: string; userId: string; rows: number; enriched: number },
): Promise<void> {
  await db.rpc('commit_quota', {
    p_job_token: args.jobToken,
    p_user_id: args.userId,
    p_rows: args.rows,
    p_enriched: args.enriched,
  });
}

export interface ReservationRow {
  job_token: string;
  user_id: string;
  allowed_rows: number;
  enrich_allowed: boolean;
  enriched_used: number;
  expires_at: string;
  committed_at: string | null;
}

export async function getReservation(db: Db, jobToken: string): Promise<ReservationRow | null> {
  return db.selectOne<ReservationRow>(
    'quota_reservations',
    `job_token=eq.${encodeURIComponent(jobToken)}`,
  );
}

export async function consumeEnrichment(
  db: Db,
  args: { jobToken: string; userId: string; requested: number; plan: Plan },
): Promise<number> {
  const granted = await db.rpc<number>('consume_enrichment', {
    p_job_token: args.jobToken,
    p_user_id: args.userId,
    p_requested: args.requested,
    p_enrich_cap: PLAN_LIMITS[args.plan].enrichedRowsPerMonth,
  });
  return typeof granted === 'number' ? granted : 0;
}

// ─── magic-link tokens ───────────────────────────────────────────────────────

export async function storeAuthToken(
  db: Db,
  args: { tokenHash: string; email: string; expiresAt: string },
): Promise<void> {
  await db.insert(
    'auth_tokens',
    { token_hash: args.tokenHash, email: args.email.toLowerCase(), expires_at: args.expiresAt },
    false,
  );
}

export interface AuthTokenRow {
  token_hash: string;
  email: string;
  expires_at: string;
  used_at: string | null;
}

/** Single use: returns the row only if unused and unexpired, and marks it used. */
export async function consumeAuthToken(db: Db, tokenHash: string): Promise<AuthTokenRow | null> {
  const rows = await db.update<AuthTokenRow>(
    'auth_tokens',
    `token_hash=eq.${encodeURIComponent(tokenHash)}&used_at=is.null&expires_at=gt.${new Date().toISOString()}`,
    { used_at: new Date().toISOString() },
  );
  return rows[0] ?? null;
}

// ─── selector config ─────────────────────────────────────────────────────────

export interface SelectorConfigRow {
  profile_id: string;
  config_version: string;
  config: unknown;
}

export async function getActiveSelectorConfig(
  db: Db,
  profileId: string,
): Promise<SelectorConfigRow | null> {
  return db.selectOne<SelectorConfigRow>(
    'selector_configs',
    `profile_id=eq.${encodeURIComponent(profileId)}&is_active=is.true&select=profile_id,config_version,config`,
  );
}

// ─── telemetry (aggregate counters only) ─────────────────────────────────────

export async function incrementTelemetry(
  db: Db,
  args: {
    day: string;
    profileId: string;
    configVersion: string;
    event: string;
    count: number;
    extractionRate: number | null;
  },
): Promise<void> {
  // Raw events are never stored — only the daily counter is touched (docs/05 §7).
  const existing = await db.selectOne<{ count: number; extraction_rate_avg: number | null }>(
    'telemetry_daily',
    `day=eq.${args.day}&profile_id=eq.${encodeURIComponent(args.profileId)}` +
      `&event=eq.${encodeURIComponent(args.event)}` +
      `&config_version=eq.${encodeURIComponent(args.configVersion)}`,
  );

  const nextCount = (existing?.count ?? 0) + args.count;
  // Running mean, weighted by event count.
  const nextRate =
    args.extractionRate == null
      ? (existing?.extraction_rate_avg ?? null)
      : existing?.extraction_rate_avg == null
        ? args.extractionRate
        : (existing.extraction_rate_avg * (existing.count || 1) + args.extractionRate * args.count) /
          (nextCount || 1);

  await db.upsert(
    'telemetry_daily',
    {
      day: args.day,
      profile_id: args.profileId,
      config_version: args.configVersion,
      event: args.event,
      count: nextCount,
      extraction_rate_avg: nextRate,
    },
    'day,profile_id,event,config_version',
  );
}

// ─── webhook idempotency ─────────────────────────────────────────────────────

export async function markWebhookProcessed(db: Db, eventId: string): Promise<boolean> {
  try {
    await db.insert('processed_webhooks', { event_id: eventId }, false);
    return true;
  } catch {
    // Primary-key conflict = we have already handled this event.
    return false;
  }
}
