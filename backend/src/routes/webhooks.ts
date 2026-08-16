/**
 * DodoPayments webhooks (docs/05 §6).
 *
 * Event names and the signature scheme below were VERIFIED against the live Dodo
 * docs (docs.dodopayments.com/developer-resources/webhooks and .../webhooks/
 * intents/webhook-events-guide) on 2026-08-16, as docs/05 §6 requires. docs/05
 * §6 has been updated to match — the original list there was a draft and was
 * missing subscription.failed / .expired / .paused / .unpaused / .plan_changed.
 *
 * Two rules that matter more than the event mapping:
 *  1. An unsigned or badly-signed request is a 401. Otherwise anyone can grant
 *     themselves Pro (docs/08 §1 "webhook forgery").
 *  2. An UNKNOWN event is a 200, never a 500 — a 500 makes Dodo retry forever.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Plan, SubscriptionStatus } from '@recruitexport/shared';
import type { App } from '../lib/middleware';
import { timingSafeEqual } from '../lib/jwt';
import { findUserByEmail, markWebhookProcessed, upsertSubscription, upsertUser } from '../db/queries';

export const webhookRoutes = new Hono<App>();

/** Standard Webhooks: reject anything older than this to stop replays. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

interface DodoEvent {
  type?: string;
  business_id?: string;
  timestamp?: string;
  data?: {
    customer?: { customer_id?: string; email?: string; name?: string };
    subscription_id?: string;
    product_id?: string;
    status?: string;
    next_billing_date?: string;
    previous_billing_date?: string;
    metadata?: Record<string, string>;
    payload_type?: string;
  };
}

webhookRoutes.post('/dodo', async (c) => {
  // Read the RAW body: the signature covers the exact bytes, so re-serializing
  // parsed JSON would break verification.
  const raw = await c.req.text();

  const id = c.req.header('webhook-id') ?? '';
  const timestamp = c.req.header('webhook-timestamp') ?? '';
  const signature = c.req.header('webhook-signature') ?? '';

  if (!id || !timestamp || !signature) {
    return c.json({ error: 'unsigned', message: 'Missing webhook signature headers.' }, 401);
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
    return c.json({ error: 'stale', message: 'Webhook timestamp outside tolerance.' }, 401);
  }

  const ok = await verifySignature({
    secret: c.env.DODO_WEBHOOK_SECRET,
    id,
    timestamp,
    body: raw,
    header: signature,
  });
  if (!ok) {
    return c.json({ error: 'bad_signature', message: 'Signature verification failed.' }, 401);
  }

  // Idempotency by event id (docs/05 §6): a redelivery must not double-apply.
  const fresh = await markWebhookProcessed(c.get('db'), id);
  if (!fresh) return c.json({ ok: true, duplicate: true });

  let event: DodoEvent;
  try {
    event = JSON.parse(raw) as DodoEvent;
  } catch {
    return c.json({ ok: true, ignored: 'unparseable' });
  }

  await handleEvent(c, event);
  return c.json({ ok: true });
});

/**
 * Standard Webhooks signature: HMAC-SHA256 over `{id}.{timestamp}.{body}`,
 * base64-encoded. The header may carry several space-separated versioned
 * signatures ("v1,<sig> v1,<sig>") during a secret rotation — any match passes.
 * The secret is base64 after its `whsec_` prefix.
 */
export async function verifySignature(args: {
  secret: string;
  id: string;
  timestamp: string;
  body: string;
  header: string;
}): Promise<boolean> {
  if (!args.secret) return false;

  const secretBytes = decodeSecret(args.secret);
  if (!secretBytes) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signed = new TextEncoder().encode(`${args.id}.${args.timestamp}.${args.body}`);
  const mac = await crypto.subtle.sign('HMAC', key, signed);
  const expected = base64(new Uint8Array(mac));

  return args.header
    .split(' ')
    .map((part) => (part.includes(',') ? part.slice(part.indexOf(',') + 1) : part))
    .some((candidate) => timingSafeEqual(candidate, expected));
}

function decodeSecret(secret: string): Uint8Array | null {
  const value = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  try {
    return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
  } catch {
    // A non-base64 secret is used as raw UTF-8 bytes.
    return new TextEncoder().encode(value);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function handleEvent(c: Context<App>, event: DodoEvent): Promise<void> {
  const db = c.get('db');
  const email = event.data?.customer?.email?.toLowerCase();
  const type = event.type ?? '';

  // Every event we act on is customer-scoped; without an email we cannot map it
  // to a user, so we acknowledge and move on rather than erroring.
  if (!email) {
    console.log(JSON.stringify({ at: 'webhook', type, mapped: false }));
    return;
  }

  const plan = planForProduct(c.env, event.data?.product_id);
  const next = statusForEvent(type);
  if (!next) {
    // Verified-but-unhandled event (dispute.*, payment.processing, …).
    console.log(JSON.stringify({ at: 'webhook', type, handled: false }));
    return;
  }

  // A paying customer may not have signed into the extension yet — create the
  // user row so their plan is live the moment they do.
  const user = (await findUserByEmail(db, email)) ?? (await upsertUser(db, email));

  await upsertSubscription(db, {
    user_id: user.id,
    dodo_customer_id: event.data?.customer?.customer_id ?? null,
    dodo_subscription_id: event.data?.subscription_id ?? null,
    ...(next.plan === 'keep' ? {} : { plan: next.plan === 'from_product' ? plan : next.plan }),
    status: next.status,
    current_period_end: event.data?.next_billing_date ?? null,
  });

  console.log(
    JSON.stringify({ at: 'webhook', type, handled: true, status: next.status, plan }),
  );

  if (next.flagForReview) {
    // Refunds get a human look; we do not automate money decisions.
    console.warn(JSON.stringify({ at: 'webhook', type, action: 'manual_review', userId: user.id }));
  }
}

interface EventOutcome {
  status: SubscriptionStatus;
  /** 'from_product' maps the Dodo product id to our plan; 'keep' leaves it. */
  plan: Plan | 'from_product' | 'keep';
  flagForReview?: boolean;
}

/**
 * Verified event names (docs.dodopayments.com, 2026-08-16). Anything not listed
 * here returns null and is acknowledged with a 200 + log.
 */
export function statusForEvent(type: string): EventOutcome | null {
  switch (type) {
    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.unpaused':
      return { status: 'active', plan: 'from_product' };

    case 'subscription.plan_changed':
      return { status: 'active', plan: 'from_product' };

    // Payment trouble: drop to free CAPS immediately via effectivePlan(), but
    // keep the plan on the row so a recovered payment restores it.
    case 'subscription.on_hold':
    case 'subscription.failed':
    case 'subscription.paused':
    case 'payment.failed':
      return { status: 'past_due', plan: 'keep' };

    // Cancelled: stays usable until current_period_end (docs/05 §6).
    case 'subscription.cancelled':
      return { status: 'cancelled', plan: 'keep' };

    case 'subscription.expired':
      return { status: 'cancelled', plan: 'free' };

    // Refund: revoke immediately and flag for a human.
    case 'refund.succeeded':
      return { status: 'cancelled', plan: 'free', flagForReview: true };

    default:
      return null;
  }
}

export function planForProduct(
  env: { DODO_PRODUCT_ID_PRO_MONTHLY: string; DODO_PRODUCT_ID_PRO_ANNUAL: string },
  productId: string | undefined,
): Plan {
  if (!productId) return 'pro_monthly';
  if (productId === env.DODO_PRODUCT_ID_PRO_ANNUAL) return 'pro_annual';
  if (productId === env.DODO_PRODUCT_ID_PRO_MONTHLY) return 'pro_monthly';
  // Unknown product: assume the cheaper plan rather than granting the better one.
  return 'pro_monthly';
}
