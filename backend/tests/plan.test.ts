import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '@recruitexport/shared';
import { currentPeriod, effectivePlan, type SubscriptionRow } from '../src/db/queries';

function sub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    user_id: 'u1',
    dodo_customer_id: null,
    dodo_subscription_id: null,
    plan: 'pro_monthly',
    status: 'active',
    current_period_end: null,
    ...overrides,
  };
}

const NOW = new Date('2026-09-15T12:00:00Z');

describe('effectivePlan', () => {
  it('honours an active paid subscription', () => {
    expect(effectivePlan(sub(), NOW)).toBe('pro_monthly');
    expect(effectivePlan(sub({ plan: 'pro_annual' }), NOW)).toBe('pro_annual');
  });

  it('drops a past_due subscription to free caps', () => {
    // A failed payment must not keep giving away 2,000 enriched rows.
    expect(effectivePlan(sub({ status: 'past_due' }), NOW)).toBe('free');
  });

  it('keeps a cancelled subscription until the period actually ends', () => {
    expect(
      effectivePlan(sub({ status: 'cancelled', current_period_end: '2026-10-01T00:00:00Z' }), NOW),
    ).toBe('pro_monthly');
  });

  it('drops a cancelled subscription after the period ends', () => {
    expect(
      effectivePlan(sub({ status: 'cancelled', current_period_end: '2026-09-01T00:00:00Z' }), NOW),
    ).toBe('free');
  });

  it('drops a cancelled subscription with no known period end', () => {
    expect(effectivePlan(sub({ status: 'cancelled', current_period_end: null }), NOW)).toBe('free');
  });

  it('leaves free users on free', () => {
    expect(effectivePlan(sub({ plan: 'free' }), NOW)).toBe('free');
  });
});

describe('plan limits match docs/04 §7', () => {
  it('free: 50 rows, no enrichment', () => {
    expect(PLAN_LIMITS.free).toEqual({
      rowsPerMonth: 50,
      enrichedRowsPerMonth: 0,
      rowsPerRolling24h: 50,
    });
  });

  it('pro: 2,000 rows/mo, 2,000 enriched, 1,000/24h', () => {
    for (const plan of ['pro_monthly', 'pro_annual'] as const) {
      expect(PLAN_LIMITS[plan]).toEqual({
        rowsPerMonth: 2000,
        enrichedRowsPerMonth: 2000,
        rowsPerRolling24h: 1000,
      });
    }
  });
});

describe('currentPeriod', () => {
  it('formats as YYYY-MM in UTC', () => {
    expect(currentPeriod(new Date('2026-09-15T12:00:00Z'))).toBe('2026-09');
    expect(currentPeriod(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    // A late-December local time must not roll into the wrong UTC month.
    expect(currentPeriod(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12');
  });
});
