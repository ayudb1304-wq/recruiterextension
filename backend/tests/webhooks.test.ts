import { describe, expect, it } from 'vitest';
import { planForProduct, statusForEvent, verifySignature } from '../src/routes/webhooks';

const SECRET = 'whsec_' + btoa('super-secret-webhook-key');

/** Produce a Standard Webhooks signature the way Dodo does. */
async function sign(id: string, timestamp: string, body: string, secret = SECRET): Promise<string> {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  let binary = '';
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

describe('verifySignature (Standard Webhooks, verified against Dodo docs 2026-08-16)', () => {
  const id = 'evt_123';
  const timestamp = '1786000000';
  const body = JSON.stringify({ type: 'subscription.active' });

  it('accepts a correctly signed payload', async () => {
    const header = await sign(id, timestamp, body);
    expect(await verifySignature({ secret: SECRET, id, timestamp, body, header })).toBe(true);
  });

  it('accepts a rotated secret set (multiple space-separated signatures)', async () => {
    const good = await sign(id, timestamp, body);
    const header = `v1,AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK= ${good}`;
    expect(await verifySignature({ secret: SECRET, id, timestamp, body, header })).toBe(true);
  });

  it('rejects a payload whose body was modified in flight', async () => {
    const header = await sign(id, timestamp, body);
    const tampered = JSON.stringify({ type: 'subscription.active', data: { hacked: true } });
    expect(
      await verifySignature({ secret: SECRET, id, timestamp, body: tampered, header }),
    ).toBe(false);
  });

  it('rejects a signature replayed under a different event id', async () => {
    const header = await sign(id, timestamp, body);
    expect(
      await verifySignature({ secret: SECRET, id: 'evt_other', timestamp, body, header }),
    ).toBe(false);
  });

  it('rejects a signature replayed with a different timestamp', async () => {
    const header = await sign(id, timestamp, body);
    expect(
      await verifySignature({ secret: SECRET, id, timestamp: '1786000999', body, header }),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    const header = await sign(id, timestamp, body, 'whsec_' + btoa('attacker-key'));
    expect(await verifySignature({ secret: SECRET, id, timestamp, body, header })).toBe(false);
  });

  it('rejects everything when no secret is configured — fail closed', async () => {
    const header = await sign(id, timestamp, body);
    expect(await verifySignature({ secret: '', id, timestamp, body, header })).toBe(false);
  });

  it('rejects a garbage header instead of throwing', async () => {
    for (const header of ['', 'v1,', 'nonsense', 'v1,!!!not-base64!!!']) {
      expect(await verifySignature({ secret: SECRET, id, timestamp, body, header })).toBe(false);
    }
  });
});

describe('statusForEvent — verified Dodo event names', () => {
  it.each([
    ['subscription.active', 'active'],
    ['subscription.renewed', 'active'],
    ['subscription.unpaused', 'active'],
    ['subscription.plan_changed', 'active'],
  ])('%s → %s', (type, status) => {
    expect(statusForEvent(type)?.status).toBe(status);
  });

  it.each(['subscription.on_hold', 'subscription.failed', 'subscription.paused', 'payment.failed'])(
    '%s → past_due',
    (type) => {
      const outcome = statusForEvent(type);
      expect(outcome?.status).toBe('past_due');
      // Plan is kept so a recovered payment restores Pro without a re-purchase.
      expect(outcome?.plan).toBe('keep');
    },
  );

  it('subscription.cancelled keeps the plan until the period ends', () => {
    const outcome = statusForEvent('subscription.cancelled');
    expect(outcome?.status).toBe('cancelled');
    expect(outcome?.plan).toBe('keep');
  });

  it('subscription.expired drops to free', () => {
    expect(statusForEvent('subscription.expired')).toEqual({ status: 'cancelled', plan: 'free' });
  });

  it('refund.succeeded revokes immediately and flags for human review', () => {
    const outcome = statusForEvent('refund.succeeded');
    expect(outcome?.status).toBe('cancelled');
    expect(outcome?.plan).toBe('free');
    expect(outcome?.flagForReview).toBe(true);
  });

  it('returns null for events we knowingly do not act on', () => {
    for (const type of [
      'payment.succeeded',
      'payment.processing',
      'payment.cancelled',
      'refund.failed',
      'dispute.opened',
      'dispute.won',
      'subscription.updated',
      'subscription.update_payment_method',
      'license_key.created',
      '',
      'totally.made.up',
    ]) {
      expect(statusForEvent(type)).toBeNull();
    }
  });
});

describe('planForProduct', () => {
  const env = {
    DODO_PRODUCT_ID_PRO_MONTHLY: 'prod_monthly',
    DODO_PRODUCT_ID_PRO_ANNUAL: 'prod_annual',
  };

  it('maps configured product ids', () => {
    expect(planForProduct(env, 'prod_monthly')).toBe('pro_monthly');
    expect(planForProduct(env, 'prod_annual')).toBe('pro_annual');
  });

  it('defaults an unknown product to the cheaper plan, never the better one', () => {
    expect(planForProduct(env, 'prod_unknown')).toBe('pro_monthly');
    expect(planForProduct(env, undefined)).toBe('pro_monthly');
  });
});
