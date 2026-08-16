/**
 * Integration tests for the quota functions in migrations/0001_init.sql.
 *
 * These run against a REAL Postgres, because the whole point of putting the
 * arithmetic in plpgsql (docs/04 §4.2) is atomicity — and you cannot test
 * atomicity against a mock.
 *
 * Skipped unless TEST_DATABASE_URL is set, so the normal `pnpm test` stays
 * dependency-free:
 *
 *   docker run -d --name re-pgtest -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres pnpm test
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '@recruitexport/shared';

const URL = process.env.TEST_DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sql: any;

const FREE = PLAN_LIMITS.free;
const PRO = PLAN_LIMITS.pro_monthly;

interface ReserveArgs {
  userId: string;
  jobToken: string;
  rows: number;
  enrich?: boolean;
  monthCap?: number;
  enrichCap?: number;
  rollingCap?: number;
  ttl?: string;
}

async function reserve(a: ReserveArgs) {
  const [row] = await sql.unsafe(
    `select * from reserve_quota($1,$2,$3,$4,$5,$6,$7,$8::interval)`,
    [
      a.userId,
      a.jobToken,
      a.rows,
      a.enrich ?? false,
      a.monthCap ?? PRO.rowsPerMonth,
      a.enrichCap ?? PRO.enrichedRowsPerMonth,
      a.rollingCap ?? PRO.rowsPerRolling24h,
      a.ttl ?? '2 hours',
    ],
  );
  return row as { allowed_rows: number; enrich_allowed: boolean; expires_at: string };
}

async function commit(jobToken: string, userId: string, rows: number, enriched = 0) {
  await sql.unsafe(`select commit_quota($1,$2,$3,$4)`, [jobToken, userId, rows, enriched]);
}

async function usage(userId: string) {
  const [row] = await sql.unsafe(
    `select rows_exported, rows_enriched, jobs_run from usage_counters
      where user_id = $1 and period_ym = to_char(now() at time zone 'utc','YYYY-MM')`,
    [userId],
  );
  return row ?? { rows_exported: 0, rows_enriched: 0, jobs_run: 0 };
}

async function makeUser(email: string): Promise<string> {
  const [row] = await sql.unsafe(
    `insert into users (email) values ($1) returning id`,
    [email],
  );
  return row.id as string;
}

describe.skipIf(!URL)('quota functions (real Postgres)', () => {
  let userId: string;
  let counter = 0;

  /**
   * job_token is a global primary key, so tests must not share literals.
   * Stable within a test (reserve and commit need the same token), unique
   * across tests and across runs against a persistent database.
   */
  const run = Date.now().toString(36);
  const tok = (label: string) => `jt_${run}_${counter}_${label}`;

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL as string, { ssl: false, max: 1, onnotice: () => {} });
    const migration = readFileSync(
      resolve(import.meta.dirname, '../migrations/0001_init.sql'),
      'utf8',
    );
    await sql.unsafe(migration);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    counter += 1;
    // A fresh user per test keeps the counters isolated without truncating.
    userId = await makeUser(`user${counter}-${Date.now()}@example.invalid`);
  });

  describe('reserve_quota', () => {
    it('grants exactly what was asked for when there is room', async () => {
      const result = await reserve({ userId, jobToken: tok('1'), rows: 200 });
      expect(result.allowed_rows).toBe(200);
    });

    it('clamps to the monthly cap for a free user', async () => {
      const result = await reserve({
        userId,
        jobToken: tok('free'),
        rows: 1000,
        monthCap: FREE.rowsPerMonth,
        rollingCap: FREE.rowsPerRolling24h,
      });
      expect(result.allowed_rows).toBe(50);
    });

    it('clamps to the rolling-24h ceiling even when the month has room', async () => {
      await reserve({ userId, jobToken: tok('a'), rows: 900 });
      await commit(tok('a'), userId, 900);
      const result = await reserve({ userId, jobToken: tok('b'), rows: 500 });
      // 1000/24h cap, 900 already exported today.
      expect(result.allowed_rows).toBe(100);
    });

    it('refuses to grant enrichment when the allowance is spent', async () => {
      const result = await reserve({
        userId,
        jobToken: tok('noenrich'),
        rows: 10,
        enrich: true,
        enrichCap: 0,
      });
      expect(result.enrich_allowed).toBe(false);
    });

    it('grants enrichment when the plan allows it', async () => {
      const result = await reserve({ userId, jobToken: tok('enrich'), rows: 10, enrich: true });
      expect(result.enrich_allowed).toBe(true);
    });

    it('returns 0 rather than a negative grant when the quota is gone', async () => {
      await reserve({ userId, jobToken: tok('x'), rows: 2000 });
      await commit(tok('x'), userId, 2000);
      const result = await reserve({ userId, jobToken: tok('y'), rows: 100 });
      expect(result.allowed_rows).toBe(0);
    });

    /**
     * The reason this logic is in the database at all (docs/04 §4.2): two panels
     * reserving at once must not both be granted the full remaining allowance.
     */
    it('counts live reservations against the cap, so parallel jobs cannot double-claim', async () => {
      const first = await reserve({
        userId,
        jobToken: tok('p1'),
        rows: 50,
        monthCap: FREE.rowsPerMonth,
        rollingCap: FREE.rowsPerRolling24h,
      });
      const second = await reserve({
        userId,
        jobToken: tok('p2'),
        rows: 50,
        monthCap: FREE.rowsPerMonth,
        rollingCap: FREE.rowsPerRolling24h,
      });
      expect(first.allowed_rows).toBe(50);
      expect(second.allowed_rows).toBe(0);
    });

    it('holds up under genuinely concurrent reservations', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          reserve({
            userId,
            jobToken: tok(`c${i}`),
            rows: 20,
            monthCap: FREE.rowsPerMonth,
            rollingCap: FREE.rowsPerRolling24h,
          }),
        ),
      );
      const total = results.reduce((sum, r) => sum + r.allowed_rows, 0);
      expect(total).toBeLessThanOrEqual(FREE.rowsPerMonth);
    });

    it('does not count an EXPIRED reservation against the cap', async () => {
      await reserve({
        userId,
        jobToken: tok('expired'),
        rows: 50,
        monthCap: FREE.rowsPerMonth,
        rollingCap: FREE.rowsPerRolling24h,
        ttl: '-1 hours',
      });
      const result = await reserve({
        userId,
        jobToken: tok('after'),
        rows: 50,
        monthCap: FREE.rowsPerMonth,
        rollingCap: FREE.rowsPerRolling24h,
      });
      // The abandoned job's rows are released — docs/05 §4.
      expect(result.allowed_rows).toBe(50);
    });
  });

  describe('commit_quota', () => {
    it('records the actual rows, not the reservation', async () => {
      await reserve({ userId, jobToken: tok('c1'), rows: 200 });
      await commit(tok('c1'), userId, 137, 100);
      expect(await usage(userId)).toMatchObject({
        rows_exported: 137,
        rows_enriched: 100,
        jobs_run: 1,
      });
    });

    it('is idempotent, so the offline retry queue can safely replay', async () => {
      await reserve({ userId, jobToken: tok('c2'), rows: 100 });
      await commit(tok('c2'), userId, 50, 10);
      await commit(tok('c2'), userId, 50, 10);
      await commit(tok('c2'), userId, 50, 10);
      expect(await usage(userId)).toMatchObject({ rows_exported: 50, jobs_run: 1 });
    });

    it('never counts more than was reserved, even if the client over-reports', async () => {
      await reserve({ userId, jobToken: tok('c3'), rows: 10 });
      await commit(tok('c3'), userId, 9999, 0);
      expect((await usage(userId)).rows_exported).toBe(10);
    });

    it('accumulates across jobs in the same month', async () => {
      await reserve({ userId, jobToken: tok('c4'), rows: 100 });
      await commit(tok('c4'), userId, 40);
      await reserve({ userId, jobToken: tok('c5'), rows: 100 });
      await commit(tok('c5'), userId, 60);
      expect(await usage(userId)).toMatchObject({ rows_exported: 100, jobs_run: 2 });
    });

    it('writes an export_event so the rolling window sees it', async () => {
      await reserve({ userId, jobToken: tok('c6'), rows: 100 });
      await commit(tok('c6'), userId, 75);
      const [row] = await sql.unsafe(
        `select coalesce(sum(rows),0)::int as total from export_events
          where user_id = $1 and at > now() - interval '24 hours'`,
        [userId],
      );
      expect(row.total).toBe(75);
    });

    it('writes no export_event for a zero-row job', async () => {
      await reserve({ userId, jobToken: tok('c7'), rows: 100 });
      await commit(tok('c7'), userId, 0);
      const [row] = await sql.unsafe(
        `select count(*)::int as n from export_events where user_id = $1`,
        [userId],
      );
      expect(row.n).toBe(0);
    });

    it('rejects a commit for a reservation that does not exist', async () => {
      await expect(commit(tok('nope'), userId, 10)).rejects.toThrow(/unknown_reservation/);
    });
  });

  describe('consume_enrichment', () => {
    async function consume(jobToken: string, requested: number, cap = PRO.enrichedRowsPerMonth) {
      const [row] = await sql.unsafe(`select consume_enrichment($1,$2,$3,$4) as granted`, [
        jobToken,
        userId,
        requested,
        cap,
      ]);
      return row.granted as number;
    }

    it('grants the full batch when the allowance is untouched', async () => {
      await reserve({ userId, jobToken: tok('e1'), rows: 100, enrich: true });
      expect(await consume(tok('e1'), 25)).toBe(25);
    });

    it('decrements across successive batches within one job', async () => {
      await reserve({ userId, jobToken: tok('e2'), rows: 100, enrich: true });
      expect(await consume(tok('e2'), 25, 60)).toBe(25);
      expect(await consume(tok('e2'), 25, 60)).toBe(25);
      // Only 10 of the third batch are covered — the rest come back "skipped".
      expect(await consume(tok('e2'), 25, 60)).toBe(10);
      expect(await consume(tok('e2'), 25, 60)).toBe(0);
    });

    it('never grants a negative amount', async () => {
      await reserve({ userId, jobToken: tok('e3'), rows: 10, enrich: true });
      expect(await consume(tok('e3'), 25, 0)).toBe(0);
    });

    it('counts enrichment already committed this month', async () => {
      await reserve({ userId, jobToken: tok('e4'), rows: 100, enrich: true });
      await commit(tok('e4'), userId, 100, 90);
      await reserve({ userId, jobToken: tok('e5'), rows: 100, enrich: true });
      expect(await consume(tok('e5'), 25, 100)).toBe(10);
    });
  });

  describe('schema guarantees', () => {
    it('allows only one active selector config per profile', async () => {
      const profile = `test_profile_${run}_${counter}`;
      await sql.unsafe(
        `insert into selector_configs (profile_id, config_version, config, is_active)
         values ($1,'v1','{}'::jsonb,true)`,
        [profile],
      );
      await expect(
        sql.unsafe(
          `insert into selector_configs (profile_id, config_version, config, is_active)
           values ($1,'v2','{}'::jsonb,true)`,
          [profile],
        ),
      ).rejects.toThrow();
    });

    it('rejects an invalid plan or status', async () => {
      const [u] = await sql.unsafe(`insert into users (email) values ($1) returning id`, [
        `badplan-${run}-${counter}@example.invalid`,
      ]);
      await expect(
        sql.unsafe(`insert into subscriptions (user_id, plan) values ($1,'enterprise')`, [u.id]),
      ).rejects.toThrow();
      await expect(
        sql.unsafe(`insert into subscriptions (user_id, status) values ($1,'vibing')`, [u.id]),
      ).rejects.toThrow();
    });

    it('makes webhook idempotency a primary-key conflict', async () => {
      const eventId = `evt_dup_${run}_${counter}`;
      await sql.unsafe(`insert into processed_webhooks (event_id) values ($1)`, [eventId]);
      await expect(
        sql.unsafe(`insert into processed_webhooks (event_id) values ($1)`, [eventId]),
      ).rejects.toThrow();
    });

    it('has RLS enabled on every table, with no permissive policies', async () => {
      const rows = await sql.unsafe(
        `select relname, relrowsecurity from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r'
            and relname <> 'schema_migrations'`,
      );
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      }
      const [policies] = await sql.unsafe(
        `select count(*)::int as n from pg_policies where schemaname = 'public'`,
      );
      expect(policies.n).toBe(0);
    });

    it('stores no table that could hold candidate data (docs/04 §5)', async () => {
      const rows = await sql.unsafe(
        `select column_name, table_name from information_schema.columns
          where table_schema = 'public'`,
      );
      const forbidden = /full_name|first_name|last_name|headline|profile_url|candidate|linkedin/i;
      const offenders = rows.filter((r: { column_name: string }) => forbidden.test(r.column_name));
      expect(offenders).toEqual([]);
    });
  });
});
