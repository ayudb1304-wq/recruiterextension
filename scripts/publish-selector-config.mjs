/**
 * Publish a selector config to Supabase (docs/02 §3.3 — the maintenance loop).
 *
 * This is the hot-fix path: telemetry shows extraction degrading → you fix the
 * selectors in config.snapshot.json → run this → every extension picks it up
 * within 5 minutes. No Chrome Web Store review involved.
 *
 * The config is validated against the SAME zod schema the extension uses before
 * anything is written, so a typo cannot be published and break every user.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *     node scripts/publish-selector-config.mjs <profileId> [--file <path>] [--apply]
 *
 *   node scripts/publish-selector-config.mjs salesnav_people_search           # validate only
 *   node scripts/publish-selector-config.mjs salesnav_people_search --apply   # publish
 *
 * Publishing deactivates the previous config for that profile in the same step,
 * so exactly one is live at a time (enforced by a unique index too).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PROFILE_ID = args.find((a) => !a.startsWith('--'));

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const FILE = resolve(
  ROOT,
  valueOf('--file') ?? 'extension/lib/extraction/config.snapshot.json',
);

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!PROFILE_ID) {
  console.error('usage: node scripts/publish-selector-config.mjs <profileId> [--file <path>] [--apply]');
  console.error('  profileId: salesnav_people_search | recruiter_search');
  process.exit(1);
}

// ── validate against the extension's own schema ─────────────────────────────
// Importing the real schema (rather than re-describing it here) is the point:
// the thing that gates publishing is the thing that gates loading.

let parseSelectorConfig;
try {
  ({ parseSelectorConfig } = await import(
    resolve(ROOT, 'extension/lib/extraction/config-schema.ts')
  ));
} catch {
  console.error('Could not load the zod schema directly (TypeScript).');
  console.error('Run this through the workspace tooling instead:\n');
  console.error('  npx tsx scripts/publish-selector-config.mjs ' + args.join(' '));
  process.exit(1);
}

const raw = JSON.parse(readFileSync(FILE, 'utf8'));
const parsed = parseSelectorConfig(raw);

if (!parsed.ok) {
  console.error(`✖ ${FILE} is invalid: ${parsed.issue}`);
  console.error('\nNothing was published. Fix the config and try again.');
  process.exit(1);
}

const config = parsed.config;
const profile = config.profiles[PROFILE_ID];

if (!profile) {
  console.error(`✖ ${FILE} has no profile "${PROFILE_ID}".`);
  console.error(`  available: ${Object.keys(config.profiles).join(', ')}`);
  process.exit(1);
}

console.log(`✔ config valid — version ${config.configVersion}, profile ${PROFILE_ID}`);
console.log(`  ${profile.fields.length} fields, ${profile.probes.length} detection probes`);

const tierCounts = { 1: 0, 2: 0, 3: 0 };
for (const field of profile.fields) {
  for (const strategy of field.strategies) tierCounts[strategy.tier] += 1;
}
console.log(
  `  strategies by tier — 1: ${tierCounts[1]}, 2: ${tierCounts[2]}, 3: ${tierCounts[3]}`,
);

if (config.configVersion === '0.0.0-seed') {
  console.warn(
    '\n⚠ This is the UNVERIFIED SEED config. It has never been checked against a\n' +
      '  real LinkedIn page. Publishing it makes every install use selectors that\n' +
      '  are guesses. Capture a fixture first (docs/03 §7).',
  );
  if (APPLY) {
    console.error('\nRefusing to publish the seed. Bump configVersion once it is real.');
    process.exit(1);
  }
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing published. Re-run with --apply.');
  process.exit(0);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('\nSUPABASE_URL and SUPABASE_SERVICE_KEY must be set to publish.');
  process.exit(1);
}

// ── publish ─────────────────────────────────────────────────────────────────

const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'content-type': 'application/json',
};

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Deactivate first: the unique partial index allows only one active row per
// profile, so inserting before deactivating would be rejected.
await rest(`/selector_configs?profile_id=eq.${encodeURIComponent(PROFILE_ID)}&is_active=is.true`, {
  method: 'PATCH',
  body: JSON.stringify({ is_active: false }),
});

const [inserted] = await rest('/selector_configs', {
  method: 'POST',
  headers: { prefer: 'return=representation' },
  body: JSON.stringify({
    profile_id: PROFILE_ID,
    config_version: config.configVersion,
    config: profile,
    is_active: true,
  }),
});

console.log(`\n✔ published config #${inserted.id} (${config.configVersion}) for ${PROFILE_ID}`);
console.log('  Extensions pick it up within 5 minutes (edge cache + alarm poll).');
console.log('\nTo roll back, reactivate the previous row:');
console.log(
  `  update selector_configs set is_active = (id = <previous_id>) where profile_id = '${PROFILE_ID}';`,
);
