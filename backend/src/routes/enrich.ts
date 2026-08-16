/**
 * Enrichment proxy (docs/05 §5).
 *
 * PRIVACY CONTRACT — this is the ONE endpoint that ever sees candidate-shaped
 * data, and it is a pass-through:
 *   in:  first name, last name, company
 *   out: an email
 *   stored: NOTHING. Not the request, not the response, not a hash.
 * We log counts and latency only. If you are about to add `console.log(body)`
 * here, you are breaking the privacy policy and the CWS disclosure (docs/08 §5).
 */

import { Hono } from 'hono';
import { ENRICH_BATCH_MAX, type EnrichResponse, type EnrichResult } from '@recruitexport/shared';
import { z } from 'zod';
import type { App } from '../lib/middleware';
import { perUserRateLimit, requireAuth } from '../lib/middleware';
import { fail } from '../lib/errors';
import { consumeEnrichment, effectivePlan, getReservation, getSubscription } from '../db/queries';
import { NOT_FOUND, resolveProvider } from '../enrich/provider';

export const enrichRoutes = new Hono<App>();

enrichRoutes.use('*', requireAuth, perUserRateLimit);

const rowSchema = z.object({
  rowId: z.string().min(1).max(64),
  firstName: z.string().max(200).nullable(),
  lastName: z.string().max(200).nullable(),
  companyName: z.string().max(300).nullable(),
  companyDomainGuess: z.string().max(300).nullable(),
});

const bodySchema = z.object({
  jobToken: z.string().min(3).max(128),
  batch: z.array(rowSchema).min(1).max(ENRICH_BATCH_MAX),
});

/** Per-row budget (docs/05 §5). A slow provider must not hang the job. */
const PER_ROW_TIMEOUT_MS = 10_000;

enrichRoutes.post('/', async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, 'bad_request', 'Invalid enrichment batch.');

  const db = c.get('db');
  const userId = c.get('userId');
  const { jobToken, batch } = parsed.data;

  const reservation = await getReservation(db, jobToken);
  if (!reservation || reservation.user_id !== userId) {
    fail(404, 'unknown_reservation', 'That export could not be found.');
  }
  if (reservation.committed_at) fail(409, 'job_closed', 'That export is already finished.');
  if (new Date(reservation.expires_at) < new Date()) {
    fail(410, 'reservation_expired', 'That export took too long. Start a new one.');
  }
  if (!reservation.enrich_allowed) {
    fail(402, 'plan_required', 'Verified emails are on Pro.', {
      checkoutUrl: c.env.DODO_CHECKOUT_URL_PRO_MONTHLY,
    });
  }

  const subscription = await getSubscription(db, userId);
  const plan = effectivePlan(subscription);

  // Claim allowance transactionally BEFORE spending credits. If only some of
  // the batch is covered, the rest come back "skipped" and the job continues.
  const granted = await consumeEnrichment(db, {
    jobToken,
    userId,
    requested: batch.length,
    plan,
  });

  const provider = resolveProvider(c.env);
  const started = Date.now();
  const covered = batch.slice(0, granted);
  const uncovered = batch.slice(granted);

  const results: EnrichResult[] = await Promise.all(
    covered.map(async (row): Promise<EnrichResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_ROW_TIMEOUT_MS);
      try {
        const found = await provider.findEmail(
          {
            firstName: row.firstName,
            lastName: row.lastName,
            companyName: row.companyName,
            companyDomain: row.companyDomainGuess,
          },
          c.env,
          controller.signal,
        );
        return {
          rowId: row.rowId,
          email: found.email,
          emailStatus: found.status,
          companyDomain: found.companyDomain,
        };
      } catch {
        // A provider error is never a job failure (docs/05 §5).
        return { rowId: row.rowId, email: null, emailStatus: NOT_FOUND.status, companyDomain: null };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  for (const row of uncovered) {
    results.push({ rowId: row.rowId, email: null, emailStatus: 'skipped', companyDomain: null });
  }

  // Counts and latency only — never the payload.
  console.log(
    JSON.stringify({
      at: 'enrich',
      provider: provider.name,
      requested: batch.length,
      granted,
      found: results.filter((r) => r.email !== null).length,
      ms: Date.now() - started,
    }),
  );

  const response: EnrichResponse = {
    results,
    allowanceExhausted: granted < batch.length,
  };
  return c.json(response);
});
