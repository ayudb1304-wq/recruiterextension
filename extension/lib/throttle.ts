/**
 * Throttle & safety layer (docs/03 §6).
 *
 * CLAUDE.md guardrail 2: EVERY pagination and scroll action goes through here.
 * Never bypass it, including in tests against live pages. Never "improve" these
 * timings downward — they are the product's account-safety promise, surfaced in
 * the UI as "Account-safe mode", not hidden fine print.
 *
 * The numbers live in shared/constants.ts THROTTLE so the backend can verify
 * the same ceilings server-side.
 */

import { THROTTLE } from '@recruitexport/shared';

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

export const realClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/** Thrown when a hard cap is hit. The job stops; it does not slow down and continue. */
export class ThrottleCapError extends Error {
  constructor(
    readonly cap: 'pages' | 'rolling24h',
    message: string,
  ) {
    super(message);
    this.name = 'ThrottleCapError';
  }
}

function randomBetween(clock: Clock, min: number, max: number): number {
  return Math.floor(min + clock.random() * (max - min));
}

export interface ThrottleOptions {
  clock?: Clock;
  /** Rows already exported in the last rolling 24h (client mirror of the server count). */
  rolling24hUsed?: number;
  signal?: AbortSignal;
}

export class Throttle {
  private readonly clock: Clock;
  private readonly signal: AbortSignal | undefined;
  private pagesVisited = 0;
  private rowsThisJob = 0;
  private readonly rolling24hUsed: number;
  /** Delays actually waited, for the "is this really human-speed" test. */
  readonly delaysMs: number[] = [];

  constructor(opts: ThrottleOptions = {}) {
    this.clock = opts.clock ?? realClock;
    this.rolling24hUsed = opts.rolling24hUsed ?? 0;
    this.signal = opts.signal;
  }

  get pageCount(): number {
    return this.pagesVisited;
  }

  /**
   * Pause between pages: uniform 2000–5000 ms, plus a 1-in-8 chance of an
   * 8–15 s "reading pause". Call before advancing to the next page, never after
   * the last one.
   */
  async pageDelay(): Promise<number> {
    let ms = randomBetween(this.clock, THROTTLE.pageDelayMinMs, THROTTLE.pageDelayMaxMs);
    if (Math.floor(this.clock.random() * THROTTLE.readingPauseChance) === 0) {
      ms += randomBetween(this.clock, THROTTLE.readingPauseMinMs, THROTTLE.readingPauseMaxMs);
    }
    this.delaysMs.push(ms);
    await this.clock.sleep(ms, this.signal);
    return ms;
  }

  /** One incremental scroll step's distance and pause — reading, not jumping. */
  nextScrollStep(): { px: number; delayMs: number } {
    return {
      px: randomBetween(this.clock, THROTTLE.scrollStepMinPx, THROTTLE.scrollStepMaxPx),
      delayMs: randomBetween(this.clock, THROTTLE.scrollDelayMinMs, THROTTLE.scrollDelayMaxMs),
    };
  }

  async scrollPause(delayMs: number): Promise<void> {
    await this.clock.sleep(delayMs, this.signal);
  }

  /**
   * Called as each page is consumed. Throws ThrottleCapError at a hard cap —
   * the caller stops the job and reports it, and never retries past it.
   */
  registerPage(): void {
    this.pagesVisited += 1;
    if (this.pagesVisited > THROTTLE.maxPagesPerJob) {
      throw new ThrottleCapError(
        'pages',
        `Reached the ${THROTTLE.maxPagesPerJob}-page-per-job limit.`,
      );
    }
  }

  registerRows(count: number): void {
    this.rowsThisJob += count;
    if (this.rolling24hUsed + this.rowsThisJob > THROTTLE.maxRowsPerRolling24h) {
      throw new ThrottleCapError(
        'rolling24h',
        `Account-safe limit reached (${THROTTLE.maxRowsPerRolling24h} rows/24h).`,
      );
    }
  }

  /** Rows still allowed under the client-side rolling-24h mirror. */
  rowsRemainingIn24h(): number {
    return Math.max(
      0,
      THROTTLE.maxRowsPerRolling24h - this.rolling24hUsed - this.rowsThisJob,
    );
  }

  canVisitAnotherPage(): boolean {
    return this.pagesVisited < THROTTLE.maxPagesPerJob;
  }
}

/**
 * Scroll a container in human-sized increments to reveal already-listed results.
 * This is the ONLY scrolling path in the extension.
 *
 * Read-only: it moves the viewport, it does not click, type, or change any
 * LinkedIn state (CLAUDE.md guardrail 1).
 */
export async function humanScroll(
  el: Element | Window,
  throttle: Throttle,
  opts: { maxSteps?: number; untilStable?: () => boolean } = {},
): Promise<void> {
  const maxSteps = opts.maxSteps ?? 12;
  for (let i = 0; i < maxSteps; i += 1) {
    const { px, delayMs } = throttle.nextScrollStep();
    if (el instanceof Window) {
      el.scrollBy({ top: px, behavior: 'smooth' });
    } else {
      el.scrollTop += px;
    }
    await throttle.scrollPause(delayMs);
    if (opts.untilStable?.()) return;
  }
}
