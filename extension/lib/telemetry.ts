/**
 * Privacy-preserving telemetry (docs/03 §9, docs/08 §5).
 *
 * WHAT MAY GO IN A PAYLOAD: counts, rates, durations, versions, profile ids,
 * field NAMES that missed.
 * WHAT MAY NEVER: scraped values, candidate names, emails, search queries,
 * page URLs, anything identifying a candidate or a search.
 *
 * `sanitizeEvent` is the enforcement point, not a convention — it drops any key
 * that is not on the allowlist and any value that is not a number. Batched and
 * sent at job end only. Opt-out honoured before anything is queued.
 */

import type { ProfileId, TelemetryEvent, TelemetryEventName } from '@recruitexport/shared';
import { TELEMETRY_EVENTS } from '@recruitexport/shared';
import { sendTelemetry } from './api';
import { getPendingTelemetry, getSettings, savePendingTelemetry } from './storage';

/** Only these metric keys are ever transmitted. */
const ALLOWED_METRIC_KEYS = new Set([
  'rows',
  'pages',
  'durationMs',
  'extractionRate',
  'cardsFound',
  'enriched',
  'verified',
  'skippedDuplicates',
  'probesFailed',
  'planTier',
  'degradedPages',
  'exceptionCount',
]);

export function sanitizeEvent(event: TelemetryEvent): TelemetryEvent | null {
  if (!TELEMETRY_EVENTS.includes(event.event)) return null;

  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(event.metrics ?? {})) {
    if (!ALLOWED_METRIC_KEYS.has(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    metrics[key] = Math.round(value * 1000) / 1000;
  }

  const fieldMisses: Record<string, number> = {};
  for (const [key, value] of Object.entries(event.fieldMisses ?? {})) {
    // Field NAMES only — the values that missed are never included.
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (!/^[a-zA-Z]{1,40}$/.test(key)) continue;
    fieldMisses[key] = Math.round(value);
  }

  return {
    event: event.event,
    profileId: event.profileId,
    configVersion: event.configVersion,
    extensionVersion: event.extensionVersion,
    at: event.at,
    ...(Object.keys(metrics).length ? { metrics } : {}),
    ...(Object.keys(fieldMisses).length ? { fieldMisses } : {}),
  };
}

export class TelemetryBuffer {
  private events: TelemetryEvent[] = [];

  constructor(
    private readonly context: {
      profileId: ProfileId | 'unknown';
      configVersion: string | null;
      extensionVersion: string;
    },
  ) {}

  record(
    event: TelemetryEventName,
    payload: { metrics?: Record<string, number>; fieldMisses?: Record<string, number> } = {},
  ): void {
    const sanitized = sanitizeEvent({
      event,
      profileId: this.context.profileId,
      configVersion: this.context.configVersion,
      extensionVersion: this.context.extensionVersion,
      at: new Date().toISOString(),
      ...payload,
    });
    if (sanitized) this.events.push(sanitized);
  }

  get size(): number {
    return this.events.length;
  }

  take(): TelemetryEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/**
 * Send at job end. Honours the opt-out toggle, and queues for the next attempt
 * when the backend is unreachable rather than dropping silently.
 */
export async function flushTelemetry(events: readonly TelemetryEvent[]): Promise<void> {
  const settings = await getSettings();
  if (settings.telemetryOptOut) {
    await savePendingTelemetry([]);
    return;
  }

  const queued = await getPendingTelemetry<TelemetryEvent>();
  const all = [...queued, ...events].map(sanitizeEvent).filter((e): e is TelemetryEvent => e !== null);
  if (all.length === 0) return;

  try {
    await sendTelemetry({ events: all });
    await savePendingTelemetry([]);
  } catch {
    await savePendingTelemetry(all);
  }
}
