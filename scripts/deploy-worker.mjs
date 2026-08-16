/**
 * Deploy the Worker to Cloudflare (docs/07 Phase 5/6).
 *
 * Does the whole first-deploy sequence, idempotently:
 *   1. check you are logged in
 *   2. create the RE_KV namespace (prod + preview) if wrangler.jsonc still has
 *      the placeholder ids, and patch them in
 *   3. push the secrets from backend/.dev.vars via `wrangler secret put`
 *   4. deploy, and report the URL
 *
 * Secrets are piped over stdin, never passed as argv — arguments are visible
 * in the process table (CLAUDE.md guardrail 4, docs/08 §7).
 *
 * Usage:
 *   npx wrangler login          # once, interactive
 *   node scripts/deploy-worker.mjs            # dry run: show the plan
 *   node scripts/deploy-worker.mjs --apply
 *
 * Re-running is safe: an existing KV namespace is reused, secrets are
 * overwritten with the current .dev.vars values, and the deploy is idempotent.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = resolve(ROOT, 'backend');
const CONFIG = resolve(BACKEND, 'wrangler.jsonc');
const DEV_VARS = resolve(BACKEND, '.dev.vars');

const APPLY = process.argv.includes('--apply');

/**
 * Values that must be Worker SECRETS, not vars. Anything not on this list and
 * present in .dev.vars is expected to live in wrangler.jsonc "vars" instead.
 */
const SECRET_KEYS = [
  'SUPABASE_SERVICE_KEY',
  'JWT_SECRET',
  'DODO_WEBHOOK_SECRET',
  'ENRICH_API_KEY',
  'EMAIL_API_KEY',
];

function wrangler(args, opts = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: BACKEND,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function readDevVars() {
  if (!fs.existsSync(DEV_VARS)) return {};
  const out = {};
  for (const line of fs.readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// ── 1. auth ─────────────────────────────────────────────────────────────────

console.log('Cloudflare Worker deploy\n');

// `wrangler whoami` exits 0 even when logged out — it just prints a notice.
// So the exit code proves nothing; the output has to be read.
let who = '';
try {
  who = wrangler(['whoami']);
} catch (err) {
  who = (err.stdout ?? '') + (err.stderr ?? '');
}

if (/not authenticated/i.test(who) || !/account/i.test(who)) {
  console.error('✖ Not logged in to Cloudflare.\n');
  console.error('Run this yourself — it opens a browser and cannot be automated:\n');
  console.error('  npx wrangler login\n');
  console.error('Then re-run: node scripts/deploy-worker.mjs --apply');
  process.exit(1);
}

const account = (/[│|]\s*(.+?)\s*[│|]\s*[0-9a-f]{32}/.exec(who) ?? [])[1] ?? 'authenticated';
console.log(`✔ logged in (${account})`);

// ── 2. KV namespace ─────────────────────────────────────────────────────────

let config = fs.readFileSync(CONFIG, 'utf8');
const needsKv = config.includes('REPLACE_WITH_KV_NAMESPACE_ID');

if (!needsKv) {
  console.log('✔ KV namespace already configured');
} else if (!APPLY) {
  console.log('→ would create KV namespace RE_KV (prod + preview)');
} else {
  console.log('→ creating KV namespace RE_KV…');

  const idFrom = (output) => {
    // wrangler prints the new id in a config snippet; accept either shape.
    const m =
      /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(output) ?? /\b([0-9a-f]{32})\b/.exec(output);
    return m?.[1] ?? null;
  };

  const prodId = idFrom(wrangler(['kv', 'namespace', 'create', 'RE_KV']));
  const previewId = idFrom(wrangler(['kv', 'namespace', 'create', 'RE_KV', '--preview']));

  if (!prodId || !previewId) {
    console.error('✖ Could not parse the namespace ids from wrangler output.');
    console.error('  Create them manually and paste the ids into backend/wrangler.jsonc:');
    console.error('    npx wrangler kv namespace create RE_KV');
    console.error('    npx wrangler kv namespace create RE_KV --preview');
    process.exit(1);
  }

  config = config
    .replace('REPLACE_WITH_KV_NAMESPACE_ID', prodId)
    .replace('REPLACE_WITH_KV_PREVIEW_ID', previewId);
  fs.writeFileSync(CONFIG, config);
  console.log(`✔ KV namespace created and written to wrangler.jsonc`);
  console.log(`    id=${prodId}`);
  console.log(`    preview_id=${previewId}`);
}

// ── 3. secrets ──────────────────────────────────────────────────────────────

const vars = readDevVars();
const present = SECRET_KEYS.filter((k) => vars[k]);
const absent = SECRET_KEYS.filter((k) => !vars[k]);

console.log(`\nsecrets (from backend/.dev.vars)`);
for (const key of present) console.log(`  → ${key}`);
for (const key of absent) console.log(`  ⊘ ${key} — not set locally, skipping`);

if (vars.DODO_WEBHOOK_SECRET?.includes('DEV-ONLY') === false && vars.DODO_WEBHOOK_SECRET) {
  // Best-effort nudge; the marker lives in the comment above the value.
  const raw = fs.readFileSync(DEV_VARS, 'utf8');
  if (/DEV-ONLY placeholder/.test(raw)) {
    console.log(
      '\n  ⚠ DODO_WEBHOOK_SECRET is still the local dev placeholder.\n' +
        '    Real Dodo webhooks will be rejected until you register the endpoint\n' +
        '    and push the real key. Deploy first, then:\n' +
        '      node scripts/dodo-setup.mjs --apply --webhook-url <url>/webhooks/dodo',
    );
  }
}

if (APPLY) {
  for (const key of present) {
    const result = spawnSync('npx', ['wrangler', 'secret', 'put', key], {
      cwd: BACKEND,
      input: vars[key],
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(`✖ failed to set ${key}: ${result.stderr?.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`  ✔ ${key} set`);
  }
}

// ── 4. deploy ───────────────────────────────────────────────────────────────

if (!APPLY) {
  console.log('\n→ would deploy');
  console.log('\nDRY RUN — nothing changed. Re-run with --apply.');
  process.exit(0);
}

console.log('\ndeploying…');
let output;
try {
  output = wrangler(['deploy']);
} catch (err) {
  console.error('✖ deploy failed');
  console.error((err.stdout ?? '') + (err.stderr ?? ''));
  process.exit(1);
}

const url = /(https:\/\/[^\s]*\.workers\.dev)/.exec(output)?.[1] ?? null;
console.log(output.trim().split('\n').slice(-6).join('\n'));

console.log('\n─────────────────────────────────────────────────────────────');
if (url) {
  console.log(`Deployed: ${url}`);
  console.log('\nVerify it:');
  console.log(`  curl ${url}/healthz`);
  console.log(`  node scripts/smoke-backend.mjs --base ${url}`);
  console.log('\nThen finish the payments wiring:');
  console.log(`  node scripts/dodo-setup.mjs --apply --webhook-url ${url}/webhooks/dodo`);
  console.log('  npx wrangler secret put DODO_WEBHOOK_SECRET   # paste the printed key');
} else {
  console.log('Deployed — check the output above for the URL.');
}
console.log('\nAlso update, once the URL is known:');
console.log('  extension/.env       WXT_API_BASE=<url>');
console.log('  site/auth.html       API_BASE=<url>');
console.log('  wrangler.jsonc vars  SITE_BASE, ENVIRONMENT=production');
console.log('─────────────────────────────────────────────────────────────');
