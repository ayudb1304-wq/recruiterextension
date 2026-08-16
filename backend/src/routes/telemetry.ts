/**
 * Telemetry ingest (docs/05 §7).
 *
 * Strictly validated: anything with unexpected keys is DROPPED, not stored.
 * Raw events are never persisted — only the daily aggregate counters in
 * telemetry_daily. No auth (the extension may not be signed in when extraction
 * breaks), so it is rate-limited by IP.
 */

import { Hono } from 'hono';
import { PROFILE_IDS, TELEMETRY_EVENTS } from '@recruitexport/shared';
import { z } from 'zod';
import type { App } from '../lib/middleware';
import { clientIp, rateLimit } from '../lib/middleware';
import { incrementTelemetry } from '../db/queries';

export const telemetryRoutes = new Hono<App>();

/**
 * `.strict()` is the point of this schema: an event carrying a stray key —
 * a name, a URL, a search query — fails validation and is discarded rather
 * than quietly written to the database.
 */
const eventSchema = z
  .object({
    event: z.enum(TELEMETRY_EVENTS),
    profileId: z.union([z.enum(PROFILE_IDS), z.literal('unknown')]),
    configVersion: z.string().max(64).nullable(),
    extensionVersion: z.string().max(32),
    at: z.string().max(40),
    metrics: z.record(z.string().max(40), z.number()).optional(),
    fieldMisses: z.record(z.string().max(40), z.number()).optional(),
  })
  .strict();

const bodySchema = z.object({
  events: z.array(eventSchema).max(50),
});

telemetryRoutes.post('/', async (c) => {
  await rateLimit(c, `telemetry:${clientIp(c)}`, 30, 60);

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // A malformed batch is dropped silently: telemetry must never surface an
    // error to the user's export.
    return c.json({ ok: true, accepted: 0 });
  }

  const db = c.get('db');
  const today = new Date().toISOString().slice(0, 10);
  let accepted = 0;

  for (const event of parsed.data.events) {
    try {
      await incrementTelemetry(db, {
        day: today,
        profileId: event.profileId,
        configVersion: event.configVersion ?? 'unknown',
        event: event.event,
        count: 1,
        extractionRate:
          typeof event.metrics?.extractionRate === 'number' ? event.metrics.extractionRate : null,
      });
      accepted += 1;
    } catch (err) {
      console.error('telemetry write failed', err instanceof Error ? err.message : 'unknown');
    }
  }

  return c.json({ ok: true, accepted });
});
