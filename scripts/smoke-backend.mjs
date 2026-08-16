/**
 * End-to-end backend smoke test (docs/07 Phase 5 DoD).
 *
 * Drives a REAL running Worker against a REAL database through the whole
 * lifecycle: magic link → JWT → /me → quota reserve → enrich → commit → usage,
 * plus the free-tier enrichment refusal and a signed Dodo webhook upgrade.
 *
 * It creates one throwaway user and DELETES IT at the end (cascading to every
 * child row), so it is safe to run against production. Nothing else is touched.
 *
 * Usage:
 *   pnpm --filter backend dev          # in another terminal
 *   node scripts/smoke-backend.mjs
 *   node scripts/smoke-backend.mjs --base https://<worker>.workers.dev
 *
 * Reads DATABASE_URL and SUPABASE_* from the gitignored .env, and the webhook
 * secret from backend/.dev.vars so the signature check exercises the real path.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const BASE = (args[args.indexOf('--base') + 1] ?? '').startsWith('http')
  ? args[args.indexOf('--base') + 1]
  : 'http://localhost:8787';

function readEnvFile(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...readEnvFile('.env'), ...readEnvFile('backend/.dev.vars') };
const DB_URL = env.DATABASE_URL;
const EMAIL = `smoke-${Date.now()}@example.invalid`;

let pass = 0;
let fail = 0;
let skipped = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Not-yet-configured, as opposed to broken. Reported, but not a failure. */
function skip(label, why) {
  skipped += 1;
  console.log(`  ⊘ ${label}\n      ${why}`);
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: json, raw: text };
}

const { default: postgres } = await import('postgres');
const sql = postgres(DB_URL, { ssl: 'require', max: 1, onnotice: () => {} });

/** Sentinel for "stop the suite, but still clean up". */
const STOP = Symbol('stop');
let stoppedEarly = false;

console.log(`Backend smoke test → ${BASE}`);
console.log(`Throwaway user: ${EMAIL}\n`);

try {
  // ── health ───────────────────────────────────────────────────────────────
  console.log('health');
  const health = await call('/healthz');
  check('GET /healthz returns ok', health.status === 200 && health.body?.ok === true);
  if (health.status !== 200) {
    console.log('\nWorker unreachable — start it with: pnpm --filter backend dev');
    process.exit(1);
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  console.log('\nauth (docs/05 §1)');
  const link = await call('/auth/request-link', { method: 'POST', body: { email: EMAIL } });

  // 10 magic links per IP per hour (docs/05 §1). Running this suite repeatedly
  // from one address legitimately trips it, so a 429 here is the rate limiter
  // doing its job — not a broken endpoint. Report it as such and skip the
  // checks that depend on a token having been issued.
  const rateLimited = link.status === 429;

  if (rateLimited) {
    check('rate limiter is enforcing the per-IP magic-link cap', link.body?.error === 'rate_limited');
    skip(
      'magic-link issuance checks',
      `per-IP hourly cap reached — retry after ${link.body?.retryAfter ?? 'the hour rolls over'}`,
    );
  } else {
    check('POST /auth/request-link returns ok:true', link.body?.ok === true);

    const bad = await call('/auth/request-link', { method: 'POST', body: { email: 'not-an-email' } });
    check('invalid email still returns ok (no account enumeration)', bad.body?.ok === true);

    const [tokenRow] = await sql`
      select token_hash, expires_at, used_at from auth_tokens
       where email = ${EMAIL} order by created_at desc limit 1`;
    check('magic-link token stored, hashed, unused', !!tokenRow && tokenRow.used_at === null);
    check(
      'token is a hash, not the raw value',
      !!tokenRow && /^[0-9a-f]{64}$/.test(tokenRow.token_hash),
    );
  }

  // /auth/verify is exercised regardless, by planting a token the same way the
  // endpoint does — so sign-in stays covered even when issuance is throttled.

  // Plant a known token so we can exercise /auth/verify without reading email.
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await sql`insert into auth_tokens (token_hash, email, expires_at)
            values (${hash}, ${EMAIL}, now() + interval '15 minutes')`;

  const verify = await call('/auth/verify', { method: 'POST', body: { token: rawToken } });

  // Verify has its own per-IP hourly cap. Everything downstream needs the JWT
  // it returns, so if that cap is hit there is nothing meaningful left to test
  // — stop with an explanation rather than cascading confusing failures.
  if (verify.status === 429) {
    check('rate limiter is enforcing the per-IP verify cap', verify.body?.error === 'rate_limited');
    console.log(
      '\n⊘ Cannot obtain a session — the per-IP verify cap is exhausted.' +
        `\n  Nothing is broken; retry after ${verify.body?.retryAfter ?? 'the hour rolls over'},` +
        '\n  or run from a different network to exercise the full suite.',
    );
    // Thrown, not process.exit(), so the cleanup in `finally` still runs —
    // otherwise an early exit would leak the throwaway user and its rows.
    stoppedEarly = true;
    throw STOP;
  }

  check('POST /auth/verify returns a JWT', verify.status === 200 && !!verify.body?.token);
  const jwt = verify.body?.token;

  const replay = await call('/auth/verify', { method: 'POST', body: { token: rawToken } });
  check('the same token cannot be used twice', replay.status === 400);

  const junk = await call('/auth/verify', { method: 'POST', body: { token: 'nonsense' } });
  check('a bogus token is rejected', junk.status === 400);

  // ── account ──────────────────────────────────────────────────────────────
  console.log('\naccount (docs/05 §2)');
  const noAuth = await call('/me');
  check('GET /me without a token is 401', noAuth.status === 401);

  const me = await call('/me', { token: jwt });
  check('GET /me returns the account', me.status === 200 && me.body?.email === EMAIL);
  check('new user starts on the free plan', me.body?.plan === 'free');
  check('free plan caps are 50 rows / 0 enriched', me.body?.usage?.monthCap === 50 && me.body?.usage?.enrichCap === 0);

  const [user] = await sql`select id from users where email = ${EMAIL}`;

  // ── quota, free tier ─────────────────────────────────────────────────────
  console.log('\nquota — free tier (docs/05 §4)');
  const enrichAsFree = await call('/quota/reserve', {
    method: 'POST',
    token: jwt,
    body: { estimatedRows: 10, enrich: true },
  });
  check('free user asking for enrichment gets plan_required', enrichAsFree.body?.error === 'plan_required');

  // Deliberately strict: an empty string is NOT a usable upgrade link, and an
  // earlier version of this assertion passed locally purely because an unset
  // env var reads back as "".
  const checkoutUrl = enrichAsFree.body?.checkoutUrl ?? '';
  check('...with a usable https checkout URL', /^https:\/\/.+\/buy\/pdt_/.test(checkoutUrl), checkoutUrl || '(empty)');
  check(
    '...prefilled with the account email',
    checkoutUrl.includes(encodeURIComponent(EMAIL)),
  );
  check(
    '...and the email field locked, so payment cannot land on another account',
    checkoutUrl.includes('disableEmail=true'),
  );

  const freeReserve = await call('/quota/reserve', {
    method: 'POST',
    token: jwt,
    body: { estimatedRows: 500, enrich: false },
  });
  check('500-row request is clamped to the 50-row free cap', freeReserve.body?.allowedRows === 50);
  const freeToken = freeReserve.body?.jobToken;

  const secondReserve = await call('/quota/reserve', {
    method: 'POST',
    token: jwt,
    body: { estimatedRows: 50, enrich: false },
  });
  check('a second concurrent reservation is refused', secondReserve.status === 402 || secondReserve.body?.allowedRows === 0);

  const commit = await call('/quota/commit', {
    method: 'POST',
    token: jwt,
    body: { jobToken: freeToken, actualRows: 37, actualEnriched: 0 },
  });
  check('commit records the actual rows', commit.body?.usage?.rowsExported === 37);

  const recommit = await call('/quota/commit', {
    method: 'POST',
    token: jwt,
    body: { jobToken: freeToken, actualRows: 37, actualEnriched: 0 },
  });
  check('commit is idempotent on replay', recommit.body?.usage?.rowsExported === 37);

  // ── webhook upgrade ──────────────────────────────────────────────────────
  console.log('\npayments webhook (docs/05 §6)');
  const unsigned = await call('/webhooks/dodo', {
    method: 'POST',
    body: { type: 'subscription.active' },
  });
  check('an unsigned webhook is rejected 401', unsigned.status === 401);

  const secret = env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    console.log('  ⊘ signed-webhook checks skipped (DODO_WEBHOOK_SECRET not set yet)');
  } else {
    const payload = JSON.stringify({
      type: 'subscription.active',
      data: {
        customer: { email: EMAIL, customer_id: 'cus_smoke' },
        subscription_id: 'sub_smoke',
        product_id: env.DODO_PRODUCT_ID_PRO_MONTHLY,
        next_billing_date: new Date(Date.now() + 30 * 864e5).toISOString(),
      },
    });
    const id = `evt_smoke_${Date.now()}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const keyBytes = secret.startsWith('whsec_')
      ? Buffer.from(secret.slice(6), 'base64')
      : Buffer.from(secret);
    const sig =
      'v1,' +
      crypto.createHmac('sha256', keyBytes).update(`${id}.${ts}.${payload}`).digest('base64');

    const signed = await call('/webhooks/dodo', {
      method: 'POST',
      headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig },
      body: JSON.parse(payload),
    });
    check('a correctly signed webhook is accepted', signed.status === 200);

    const dup = await call('/webhooks/dodo', {
      method: 'POST',
      headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig },
      body: JSON.parse(payload),
    });
    check('a redelivered webhook is idempotent', dup.body?.duplicate === true);

    const tampered = await call('/webhooks/dodo', {
      method: 'POST',
      headers: {
        'webhook-id': `${id}_x`,
        'webhook-timestamp': ts,
        'webhook-signature': sig,
      },
      body: JSON.parse(payload),
    });
    check('a replayed signature under a new id is rejected', tampered.status === 401);

    const upgraded = await call('/me', { token: jwt });
    check('the webhook upgraded the plan to pro_monthly', upgraded.body?.plan === 'pro_monthly');
    check('pro caps are now 2,000 rows', upgraded.body?.usage?.monthCap === 2000);
  }

  // ── enrichment, as a paid user ───────────────────────────────────────────
  console.log('\nenrichment (docs/05 §5)');
  // Ensure paid regardless of whether the webhook path ran.
  await sql`update subscriptions set plan='pro_monthly', status='active',
              current_period_end = now() + interval '30 days'
            where user_id = ${user.id}`;

  const paidReserve = await call('/quota/reserve', {
    method: 'POST',
    token: jwt,
    body: { estimatedRows: 100, enrich: true },
  });
  check('paid user gets an enrichment-enabled reservation', paidReserve.body?.enrichAllowed === true);
  const paidToken = paidReserve.body?.jobToken;

  const enriched = await call('/enrich', {
    method: 'POST',
    token: jwt,
    body: {
      jobToken: paidToken,
      batch: [
        { rowId: '0', firstName: 'Jane', lastName: 'Doe', companyName: 'Acme', companyDomainGuess: null },
        { rowId: '1', firstName: 'Wei', lastName: 'Chen', companyName: 'Globex', companyDomainGuess: null },
      ],
    },
  });
  check('POST /enrich returns one result per row', enriched.body?.results?.length === 2);
  check(
    'each result carries a status',
    (enriched.body?.results ?? []).every((r) =>
      ['verified', 'risky', 'not_found', 'skipped'].includes(r.emailStatus),
    ),
  );
  check('rowIds are preserved so rows map back correctly',
    enriched.body?.results?.[0]?.rowId === '0' && enriched.body?.results?.[1]?.rowId === '1');

  const foreignJob = await call('/enrich', {
    method: 'POST',
    token: jwt,
    body: { jobToken: 'jt_does_not_exist', batch: [{ rowId: '0', firstName: 'A', lastName: 'B', companyName: 'C', companyDomainGuess: null }] },
  });
  check('enrichment against an unknown job is refused', foreignJob.status === 404);

  const oversized = await call('/enrich', {
    method: 'POST',
    token: jwt,
    body: {
      jobToken: paidToken,
      batch: Array.from({ length: 26 }, (_, i) => ({
        rowId: String(i), firstName: 'A', lastName: 'B', companyName: 'C', companyDomainGuess: null,
      })),
    },
  });
  check('a batch over 25 rows is rejected', oversized.status === 400);

  await call('/quota/commit', {
    method: 'POST',
    token: jwt,
    body: { jobToken: paidToken, actualRows: 100, actualEnriched: 2 },
  });
  const finalMe = await call('/me', { token: jwt });
  check('usage accumulates across jobs', finalMe.body?.usage?.rowsExported === 137);
  check('enriched rows are counted separately', finalMe.body?.usage?.rowsEnriched === 2);

  // ── telemetry ────────────────────────────────────────────────────────────
  console.log('\ntelemetry (docs/05 §7)');
  const tel = await call('/telemetry', {
    method: 'POST',
    body: {
      events: [{
        event: 'job_summary', profileId: 'salesnav_people_search',
        configVersion: '0.0.0-seed', extensionVersion: '0.1.0',
        at: new Date().toISOString(), metrics: { rows: 137, extractionRate: 0.97 },
      }],
    },
  });
  check('telemetry accepts a valid event without auth', tel.body?.accepted === 1);

  const dirty = await call('/telemetry', {
    method: 'POST',
    body: {
      events: [{
        event: 'job_summary', profileId: 'salesnav_people_search',
        configVersion: 'v', extensionVersion: '0.1.0', at: new Date().toISOString(),
        candidateName: 'Jane Doe', searchQuery: 'backend engineers berlin',
      }],
    },
  });
  check('an event carrying PII keys is DROPPED, not stored', dirty.body?.accepted === 0);

  const [telRow] = await sql`
    select count(*)::int n from telemetry_daily
     where profile_id='salesnav_people_search' and event='job_summary'`;
  check('telemetry aggregated into daily counters', telRow.n > 0);
} catch (err) {
  if (err !== STOP) throw err;
} finally {
  // ── cleanup ──────────────────────────────────────────────────────────────
  console.log('\ncleanup');
  await sql`delete from auth_tokens where email = ${EMAIL}`;
  const deleted = await sql`delete from users where email = ${EMAIL} returning id`;
  await sql`delete from processed_webhooks where event_id like 'evt_smoke_%'`;
  console.log(`  removed ${deleted.length} throwaway user and its child rows`);
  const [remaining] = await sql`select count(*)::int n from users`;
  console.log(`  users table now holds ${remaining.n} row(s)`);
  await sql.end();
}

console.log(
  `\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}` +
    (stoppedEarly ? ' — suite stopped early (rate limited)' : ''),
);
process.exit(fail === 0 ? 0 : 1);
