/**
 * Migration runner for the Supabase Postgres database (docs/04 §4).
 *
 * Applies every .sql file in backend/migrations, in filename order, exactly
 * once. Each file runs inside a transaction, and applied files are recorded in
 * a `schema_migrations` table — so re-running is safe and a failed migration
 * leaves nothing half-applied.
 *
 * Two credential routes, because the Supabase SERVICE KEY cannot run DDL (it
 * goes through PostgREST, which only does data operations):
 *
 *   A. DATABASE_URL — the Postgres connection string.
 *      Supabase dashboard → Project Settings → Database → Connection string →
 *      URI. Use the "Session pooler" URI if you are behind IPv4-only network.
 *
 *   B. SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF — a personal access token.
 *      Supabase dashboard → Account → Access Tokens (starts `sbp_`).
 *      Runs the SQL through the Management API instead.
 *
 * Put whichever you have in the gitignored `.env` at the repo root, then:
 *
 *   node scripts/db-migrate.mjs            # show what would run
 *   node scripts/db-migrate.mjs --apply    # run it
 *   node scripts/db-migrate.mjs --status   # what is already applied
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = resolve(ROOT, 'backend/migrations');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STATUS_ONLY = args.includes('--status');

// ── .env loading (no dependency; only reads, never writes) ──────────────────

function loadEnv() {
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue; // real env wins
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadEnv();

const { DATABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF } = process.env;

// ── migration files ─────────────────────────────────────────────────────────

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files in ${MIGRATIONS_DIR}`);
  process.exit(1);
}

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

console.log(`Migrations in ${basename(MIGRATIONS_DIR)}/:`);
for (const file of files) {
  const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
  console.log(`  ${file}  (${sql.split('\n').length} lines, ${checksum(sql)})`);
}

// ── driver selection ────────────────────────────────────────────────────────

const MODE = DATABASE_URL
  ? 'postgres'
  : SUPABASE_ACCESS_TOKEN && SUPABASE_PROJECT_REF
    ? 'management-api'
    : null;

if (!MODE) {
  console.error('\nNo database credentials found.\n');
  console.error('Add ONE of these to the gitignored .env at the repo root:\n');
  console.error('  # A: connection string (Settings → Database → Connection string → URI)');
  console.error('  DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres\n');
  console.error('  # B: personal access token (Account → Access Tokens)');
  console.error('  SUPABASE_ACCESS_TOKEN=sbp_...');
  console.error('  SUPABASE_PROJECT_REF=ydofetvwqkbsdbkbqkmn\n');
  console.error('The SUPABASE_SERVICE_KEY alone cannot do this — it goes through');
  console.error('PostgREST, which runs data operations, not DDL.');
  process.exit(1);
}

console.log(`\nDriver: ${MODE}`);

// ── the two drivers ─────────────────────────────────────────────────────────

async function withManagementApi(handler) {
  const endpoint = `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`;
  const run = async (query) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
    try {
      return text ? JSON.parse(text) : [];
    } catch {
      return [];
    }
  };
  return handler(run);
}

async function withPostgres(handler) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(DATABASE_URL, {
    ssl: 'require',
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
    onnotice: () => {},
  });
  const run = async (query) => sql.unsafe(query);
  try {
    return await handler(run);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const withDb = MODE === 'postgres' ? withPostgres : withManagementApi;

// ── the run ─────────────────────────────────────────────────────────────────

await withDb(async (run) => {
  await run(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
    -- Supabase exposes the whole public schema through PostgREST, so even a
    -- bookkeeping table needs RLS on with no policies — otherwise the anon key
    -- can enumerate it. Matches every other table in 0001_init.sql.
    alter table schema_migrations enable row level security;
  `);

  const appliedRows = await run('select filename, checksum from schema_migrations');
  const applied = new Map(
    (Array.isArray(appliedRows) ? appliedRows : []).map((r) => [r.filename, r.checksum]),
  );

  console.log(`\nAlready applied: ${applied.size}`);
  for (const [filename, sum] of applied) console.log(`  ✔ ${filename} (${sum})`);

  const pending = files.filter((f) => !applied.has(f));

  // A file that changed after being applied is a real problem worth shouting
  // about — the database no longer matches what the repo says it does.
  for (const file of files) {
    if (!applied.has(file)) continue;
    const current = checksum(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'));
    if (current !== applied.get(file)) {
      console.warn(
        `\n⚠ ${file} changed since it was applied (${applied.get(file)} → ${current}).` +
          `\n  Write a NEW migration instead of editing an applied one.`,
      );
    }
  }

  if (STATUS_ONLY) return;

  if (pending.length === 0) {
    console.log('\nNothing to apply — the database is up to date.');
    return;
  }

  console.log(`\nPending: ${pending.length}`);
  for (const file of pending) console.log(`  → ${file}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was applied. Re-run with --apply.');
    return;
  }

  for (const file of pending) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`\nApplying ${file}… `);
    // One transaction per file: a failure rolls the whole file back rather than
    // leaving the schema halfway.
    await run(`begin;\n${sql}\ncommit;`).catch(async (err) => {
      await run('rollback;').catch(() => {});
      throw new Error(`${file} failed: ${err.message}`);
    });
    await run(
      `insert into schema_migrations (filename, checksum) values ('${file}', '${checksum(sql)}')
       on conflict (filename) do update set checksum = excluded.checksum, applied_at = now();`,
    );
    console.log('done');
  }

  console.log('\n✔ All migrations applied.');
  console.log('\nNext: verify with');
  console.log('  node scripts/db-migrate.mjs --status');
}).catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
