import { describe, expect, it } from 'vitest';
import { THROTTLE } from '@recruitexport/shared';
import { AbortError, Throttle, ThrottleCapError, type Clock } from '../lib/throttle';

/** A clock that records sleeps instead of performing them. */
function fakeClock(randomSequence: number[] = []): Clock & { sleeps: number[] } {
  let i = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => 0,
    random: () => {
      const v = randomSequence[i % Math.max(1, randomSequence.length)] ?? 0.5;
      i += 1;
      return v;
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new AbortError();
      sleeps.push(ms);
    },
  };
}

describe('pageDelay', () => {
  it('always waits at least the 2s floor', async () => {
    const clock = fakeClock([0, 0.99]); // min delay, no reading pause
    const t = new Throttle({ clock });
    const ms = await t.pageDelay();
    expect(ms).toBeGreaterThanOrEqual(THROTTLE.pageDelayMinMs);
  });

  it('never exceeds the base ceiling without a reading pause', async () => {
    const clock = fakeClock([0.999, 0.99]);
    const t = new Throttle({ clock });
    const ms = await t.pageDelay();
    expect(ms).toBeLessThanOrEqual(THROTTLE.pageDelayMaxMs);
  });

  it('adds an 8-15s reading pause on the 1-in-8 roll', async () => {
    // second random < 1/8 triggers the pause; third picks its length
    const clock = fakeClock([0.5, 0.05, 0.5]);
    const t = new Throttle({ clock });
    const ms = await t.pageDelay();
    expect(ms).toBeGreaterThanOrEqual(THROTTLE.pageDelayMinMs + THROTTLE.readingPauseMinMs);
    expect(ms).toBeLessThanOrEqual(THROTTLE.pageDelayMaxMs + THROTTLE.readingPauseMaxMs);
  });

  it('actually sleeps for the delay it reports', async () => {
    const clock = fakeClock([0.5, 0.9]);
    const t = new Throttle({ clock });
    const ms = await t.pageDelay();
    expect(clock.sleeps).toEqual([ms]);
  });

  it('over many draws, stays inside the documented envelope', async () => {
    const t = new Throttle();
    const clock = fakeClock();
    const local = new Throttle({ clock });
    for (let i = 0; i < 200; i += 1) {
      const ms = await local.pageDelay();
      expect(ms).toBeGreaterThanOrEqual(THROTTLE.pageDelayMinMs);
      expect(ms).toBeLessThanOrEqual(THROTTLE.pageDelayMaxMs + THROTTLE.readingPauseMaxMs);
    }
    expect(t.pageCount).toBe(0);
  });

  it('rejects when the job is aborted mid-wait', async () => {
    const controller = new AbortController();
    controller.abort();
    const t = new Throttle({ clock: fakeClock(), signal: controller.signal });
    await expect(t.pageDelay()).rejects.toBeInstanceOf(AbortError);
  });
});

describe('scroll steps', () => {
  it('produces reading-sized increments, not jumps', () => {
    const t = new Throttle({ clock: fakeClock() });
    for (let i = 0; i < 50; i += 1) {
      const { px, delayMs } = t.nextScrollStep();
      expect(px).toBeGreaterThanOrEqual(THROTTLE.scrollStepMinPx);
      expect(px).toBeLessThanOrEqual(THROTTLE.scrollStepMaxPx);
      expect(delayMs).toBeGreaterThanOrEqual(THROTTLE.scrollDelayMinMs);
      expect(delayMs).toBeLessThanOrEqual(THROTTLE.scrollDelayMaxMs);
    }
  });
});

describe('hard caps (docs/03 §6)', () => {
  it('stops the job at 25 pages', () => {
    const t = new Throttle({ clock: fakeClock() });
    for (let i = 0; i < THROTTLE.maxPagesPerJob; i += 1) t.registerPage();
    expect(t.canVisitAnotherPage()).toBe(false);
    expect(() => t.registerPage()).toThrow(ThrottleCapError);
  });

  it('stops at 1,000 rows in a rolling 24h, counting prior usage', () => {
    const t = new Throttle({ clock: fakeClock(), rolling24hUsed: 950 });
    expect(t.rowsRemainingIn24h()).toBe(50);
    t.registerRows(50);
    expect(t.rowsRemainingIn24h()).toBe(0);
    expect(() => t.registerRows(1)).toThrow(ThrottleCapError);
  });

  it('reports which cap was hit so the UI can explain it', () => {
    const t = new Throttle({ clock: fakeClock(), rolling24hUsed: THROTTLE.maxRowsPerRolling24h });
    try {
      t.registerRows(1);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ThrottleCapError);
      expect((err as ThrottleCapError).cap).toBe('rolling24h');
    }
  });
});

describe('constants are not quietly weakened (CLAUDE.md guardrail 2)', () => {
  it('matches the documented numbers exactly', () => {
    expect(THROTTLE.pageDelayMinMs).toBe(2000);
    expect(THROTTLE.pageDelayMaxMs).toBe(5000);
    expect(THROTTLE.readingPauseChance).toBe(8);
    expect(THROTTLE.readingPauseMinMs).toBe(8000);
    expect(THROTTLE.readingPauseMaxMs).toBe(15000);
    expect(THROTTLE.maxPagesPerJob).toBe(25);
    expect(THROTTLE.maxRowsPerRolling24h).toBe(1000);
  });
});
