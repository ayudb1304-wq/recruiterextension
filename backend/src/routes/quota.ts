/**
 * Quota reservation model (docs/05 §4).
 *
 * Reserve before scraping, commit after. This is what stops a user discovering
 * mid-export that they ran out — and what stops ten parallel panels each
 * claiming the full monthly allowance. The arithmetic happens inside Postgres
 * functions so it is atomic (migrations/0001_init.sql).
 *
 * The server is authoritative; the extension's copy is only for UX.
 */

import { Hono } from 'hono';
import { RESERVATION_TTL_MS, type QuotaCommitResponse, type QuotaReserveResponse } from '@recruitexport/shared';
import { z } from 'zod';
import type { App } from '../lib/middleware';
import { perUserRateLimit, requireAuth } from '../lib/middleware';
import { checkoutUrl } from '../lib/checkout';
import { fail } from '../lib/errors';
import {
  commitQuota,
  effectivePlan,
  getReservation,
  getSubscription,
  getUsage,
  reserveQuota,
} from '../db/queries';
import { randomToken } from '../lib/jwt';

export const quotaRoutes = new Hono<App>();

quotaRoutes.use('*', requireAuth, perUserRateLimit);

const reserveSchema = z.object({
  estimatedRows: z.number().int().min(1).max(1000),
  enrich: z.boolean(),
});

quotaRoutes.post('/reserve', async (c) => {
  const parsed = reserveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, 'bad_request', 'Invalid reservation request.');

  const db = c.get('db');
  const userId = c.get('userId');
  const subscription = await getSubscription(db, userId);
  const plan = effectivePlan(subscription);

  // Enrichment is a paid feature. Fail with the upgrade path, not a bare 402.
  if (parsed.data.enrich && plan === 'free') {
    fail(402, 'plan_required', 'Verified emails are on Pro.', {
      checkoutUrl: checkoutUrl(c.env, 'pro_monthly', c.get('email')),
    });
  }

  const jobToken = `jt_${randomToken(18)}`;
  const result = await reserveQuota(db, {
    userId,
    jobToken,
    estimatedRows: parsed.data.estimatedRows,
    enrich: parsed.data.enrich,
    plan,
  });

  if (result.allowed_rows <= 0) {
    const usage = await getUsage(db, userId, plan);
    // Distinguish "used your month" from "hit the daily safety ceiling" — they
    // need different explanations and only one of them is fixable by upgrading.
    if (usage.rolling24h >= usage.rolling24hCap) {
      fail(429, 'rolling_limit', 'Account-safe limit reached (rows per 24h).', {
        retryAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    fail(402, 'quota_exhausted', 'You have used your rows for this month.', {
      checkoutUrl: plan === 'free' ? checkoutUrl(c.env, 'pro_monthly', c.get('email')) : undefined,
      monthCap: usage.monthCap,
    });
  }

  const response: QuotaReserveResponse = {
    jobToken,
    allowedRows: result.allowed_rows,
    enrichAllowed: result.enrich_allowed,
    expiresAt: result.expires_at ?? new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
  };
  return c.json(response);
});

const commitSchema = z.object({
  jobToken: z.string().min(3).max(128),
  actualRows: z.number().int().min(0).max(2000),
  actualEnriched: z.number().int().min(0).max(2000),
});

quotaRoutes.post('/commit', async (c) => {
  const parsed = commitSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, 'bad_request', 'Invalid commit request.');

  const db = c.get('db');
  const userId = c.get('userId');

  const reservation = await getReservation(db, parsed.data.jobToken);
  if (!reservation || reservation.user_id !== userId) {
    fail(404, 'unknown_reservation', 'That export could not be reconciled.');
  }

  // commit_quota is idempotent per token, so a retried commit is safe.
  await commitQuota(db, {
    jobToken: parsed.data.jobToken,
    userId,
    rows: parsed.data.actualRows,
    enriched: parsed.data.actualEnriched,
  });

  const subscription = await getSubscription(db, userId);
  const usage = await getUsage(db, userId, effectivePlan(subscription));

  const response: QuotaCommitResponse = { ok: true, usage };
  return c.json(response);
});
