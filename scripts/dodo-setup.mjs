/**
 * DodoPayments setup (docs/07 Phase 5, docs/05 §6).
 *
 * Creates the two subscription products and the webhook endpoint, then prints
 * the exact secrets/vars to feed the Worker. Idempotent: it looks for existing
 * products by name and reuses them rather than creating duplicates.
 *
 * API shapes verified against docs.dodopayments.com on 2026-08-16:
 *   POST /products                    → create product
 *   GET  /products                    → list (for idempotency)
 *   POST /webhooks                    → create webhook endpoint
 *   GET  /webhooks/{id}/secret        → signing key (NOT returned on create)
 *
 * Usage:
 *   DODO_API_KEY=... node scripts/dodo-setup.mjs                 # dry run
 *   DODO_API_KEY=... node scripts/dodo-setup.mjs --apply         # test mode
 *   DODO_API_KEY=... node scripts/dodo-setup.mjs --apply --live  # live mode
 *
 * Options:
 *   --webhook-url <url>   endpoint to register (default http://localhost:8787/webhooks/dodo)
 *   --live                use https://live.dodopayments.com (default: test)
 *   --apply               actually create things (default: print the plan only)
 *
 * NOTHING here is committed with a key in it. Pass DODO_API_KEY in the
 * environment (CLAUDE.md guardrail 4).
 */

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIVE = args.includes('--live');
const WEBHOOK_URL =
  valueOf('--webhook-url') ?? 'http://localhost:8787/webhooks/dodo';

const BASE = LIVE ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
const API_KEY = process.env.DODO_API_KEY;

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (!API_KEY) {
  console.error('DODO_API_KEY is not set.\n');
  console.error('Get one from the Dodo dashboard → Developer → API Keys.');
  console.error('Use a TEST-mode key until the whole flow is verified.\n');
  console.error('  DODO_API_KEY=... node scripts/dodo-setup.mjs --apply');
  process.exit(1);
}

/**
 * The plans from docs/01 F12 and docs/04 §7. Prices are in the lowest
 * denomination: $39.00 → 3900.
 *
 * `subscription_period_*` is the TOTAL TERM the subscription stays active, not
 * the billing cadence — that is `payment_frequency_*`. A long term with a
 * monthly cadence is how you express "renews until cancelled".
 * 👤 Eyeball both products in the dashboard after creating them.
 */
const PRODUCTS = [
  {
    key: 'DODO_PRODUCT_ID_PRO_MONTHLY',
    name: 'Recruiter Export Pro — Monthly',
    description:
      '2,000 exported rows per month, 2,000 verified email lookups, all ATS presets, Google Sheets export.',
    tax_category: 'saas',
    price: {
      type: 'recurring_price',
      price: 3900,
      currency: 'USD',
      discount: 0,
      purchasing_power_parity: false,
      payment_frequency_count: 1,
      payment_frequency_interval: 'Month',
      subscription_period_count: 10,
      subscription_period_interval: 'Year',
      trial_period_days: 0,
      tax_inclusive: false,
    },
  },
  {
    key: 'DODO_PRODUCT_ID_PRO_ANNUAL',
    name: 'Recruiter Export Pro — Annual',
    description:
      'Everything in Pro, billed yearly. 2,000 exported rows and 2,000 verified email lookups per month.',
    tax_category: 'saas',
    price: {
      type: 'recurring_price',
      price: 39000,
      currency: 'USD',
      discount: 0,
      purchasing_power_parity: false,
      payment_frequency_count: 1,
      payment_frequency_interval: 'Year',
      subscription_period_count: 10,
      subscription_period_interval: 'Year',
      trial_period_days: 0,
      tax_inclusive: false,
    },
  },
];

/**
 * Exactly the events backend/src/routes/webhooks.ts acts on, plus the ones it
 * deliberately acknowledges. Subscribing narrowly keeps the endpoint quiet and
 * makes an unexpected event type obvious in the logs.
 */
const WEBHOOK_EVENTS = [
  'subscription.active',
  'subscription.renewed',
  'subscription.unpaused',
  'subscription.plan_changed',
  'subscription.on_hold',
  'subscription.failed',
  'subscription.paused',
  'subscription.cancelled',
  'subscription.expired',
  'payment.failed',
  'refund.succeeded',
];

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${detail?.slice(0, 400)}`);
  }
  return body;
}

function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function findProductByName(name) {
  try {
    return listOf(await api('/products')).find((p) => p?.name === name) ?? null;
  } catch (err) {
    console.warn(`  (could not list products: ${err.message})`);
    return null;
  }
}

async function findWebhookByUrl(url) {
  try {
    return listOf(await api('/webhooks')).find((w) => w?.url === url) ?? null;
  } catch (err) {
    console.warn(`  (could not list webhooks: ${err.message})`);
    return null;
  }
}

async function main() {
  console.log(`Dodo setup — ${LIVE ? 'LIVE' : 'TEST'} mode (${BASE})`);
  console.log(`Webhook endpoint: ${WEBHOOK_URL}`);
  if (!APPLY) console.log('\nDRY RUN. Re-run with --apply to create anything.\n');

  const env = {};

  // ── products ─────────────────────────────────────────────────────────────
  for (const product of PRODUCTS) {
    const dollars = (product.price.price / 100).toFixed(2);
    const cadence = `${product.price.payment_frequency_count} ${product.price.payment_frequency_interval}`;
    console.log(`\n▸ ${product.name} — $${dollars} every ${cadence}`);

    const existing = await findProductByName(product.name);
    if (existing) {
      console.log(`  already exists: ${existing.product_id ?? existing.id}`);
      env[product.key] = existing.product_id ?? existing.id;
      continue;
    }

    if (!APPLY) {
      console.log('  would create');
      continue;
    }

    const { key, ...payload } = product;
    const created = await api('/products', { method: 'POST', body: JSON.stringify(payload) });
    const id = created.product_id ?? created.id;
    console.log(`  created: ${id}`);
    env[key] = id;
  }

  // ── webhook ──────────────────────────────────────────────────────────────
  console.log(`\n▸ Webhook → ${WEBHOOK_URL}`);
  console.log(`  subscribing to ${WEBHOOK_EVENTS.length} event types`);

  let webhook = await findWebhookByUrl(WEBHOOK_URL);
  if (webhook) {
    console.log(`  already exists: ${webhook.id}`);
  } else if (APPLY) {
    webhook = await api('/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: WEBHOOK_URL,
        description: 'Recruiter Export — subscription lifecycle',
        filter_types: WEBHOOK_EVENTS,
      }),
    });
    console.log(`  created: ${webhook.id}`);
  } else {
    console.log('  would create');
  }

  if (webhook?.id && APPLY) {
    const { secret } = await api(`/webhooks/${webhook.id}/secret`);
    env.DODO_WEBHOOK_SECRET = secret;
  }

  // ── output ───────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\nDry run complete — nothing was created.');
    return;
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('Add to backend/.dev.vars for local dev:\n');
  for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
  console.log('\nFor production, set the SECRET with wrangler (never commit it):\n');
  console.log('  npx wrangler secret put DODO_WEBHOOK_SECRET');
  console.log('\nThe non-secret product ids can go in wrangler.jsonc "vars".');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('\n👤 Still manual in the Dodo dashboard:');
  console.log('  - checkout links per product  → DODO_CHECKOUT_URL_PRO_{MONTHLY,ANNUAL}');
  console.log('  - customer portal link        → DODO_PORTAL_URL');
  console.log('  - business/tax details, and switching from test to live keys');
  console.log('\n👤 Verify both products in the dashboard before taking real money.');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
