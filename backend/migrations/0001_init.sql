-- RecruitExport initial schema (docs/04 §4).
--
-- What is deliberately absent: any table that could hold a candidate record,
-- a scraped name, an email we found, a profile URL, or a LinkedIn search query
-- (docs/04 §5, docs/08 §5). If a future migration adds one, it contradicts the
-- privacy policy and the CWS data-disclosure answers.
--
-- Access is service-role only. RLS is enabled with no permissive policies, so
-- the anon and authenticated keys can read nothing even if one leaks.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists subscriptions (
  user_id uuid primary key references users(id) on delete cascade,
  dodo_customer_id text,
  dodo_subscription_id text,
  plan text not null default 'free',       -- free | pro_monthly | pro_annual
  status text not null default 'active',   -- active | past_due | cancelled
  current_period_end timestamptz,
  updated_at timestamptz not null default now(),
  constraint subscriptions_plan_check
    check (plan in ('free', 'pro_monthly', 'pro_annual')),
  constraint subscriptions_status_check
    check (status in ('active', 'past_due', 'cancelled'))
);

create table if not exists usage_counters (
  user_id uuid not null references users(id) on delete cascade,
  period_ym text not null,                 -- '2026-09'
  rows_exported int not null default 0,
  rows_enriched int not null default 0,
  jobs_run int not null default 0,
  primary key (user_id, period_ym)
);

-- Rolling 24h ceiling (docs/03 §6). Pruned by the cleanup function below.
create table if not exists export_events (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  at timestamptz not null default now(),
  rows int not null
);
create index if not exists export_events_user_at_idx on export_events (user_id, at desc);

create table if not exists selector_configs (
  id serial primary key,
  profile_id text not null,
  config_version text not null,
  config jsonb not null,                   -- validated against the zod schema before insert
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);
-- Exactly one active config per profile.
create unique index if not exists selector_configs_one_active
  on selector_configs (profile_id) where is_active;

create table if not exists telemetry_daily (
  day date not null,
  profile_id text not null,
  config_version text not null default 'unknown',
  event text not null,
  count int not null default 0,
  extraction_rate_avg numeric,
  primary key (day, profile_id, event, config_version)
);

-- Magic-link tokens: stored hashed, single use, 15 min TTL (docs/05 §1).
create table if not exists auth_tokens (
  token_hash text primary key,
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists auth_tokens_expires_idx on auth_tokens (expires_at);

-- Quota reservations (docs/05 §4). Uncommitted ones expire without counting.
create table if not exists quota_reservations (
  job_token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  allowed_rows int not null,
  enrich_allowed boolean not null default false,
  enriched_used int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  committed_at timestamptz,
  committed_rows int,
  committed_enriched int
);
create index if not exists quota_reservations_expiry_idx on quota_reservations (expires_at);

-- Webhook idempotency by event id (docs/05 §6).
create table if not exists processed_webhooks (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

-- ── RLS: service role only, no policies ─────────────────────────────────────
alter table users              enable row level security;
alter table subscriptions      enable row level security;
alter table usage_counters     enable row level security;
alter table export_events      enable row level security;
alter table selector_configs   enable row level security;
alter table telemetry_daily    enable row level security;
alter table auth_tokens        enable row level security;
alter table quota_reservations enable row level security;
alter table processed_webhooks enable row level security;

-- ── atomic quota reservation ────────────────────────────────────────────────
-- Done in the database so two concurrent jobs cannot both pass the check.
create or replace function reserve_quota(
  p_user_id uuid,
  p_job_token text,
  p_estimated_rows int,
  p_enrich boolean,
  p_month_cap int,
  p_enrich_cap int,
  p_rolling_cap int,
  p_ttl interval
) returns table (allowed_rows int, enrich_allowed boolean, expires_at timestamptz)
language plpgsql
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_used_month int;
  v_used_enrich int;
  v_used_24h int;
  v_reserved int;
  v_allowed int;
begin
  select coalesce(rows_exported, 0), coalesce(rows_enriched, 0)
    into v_used_month, v_used_enrich
    from usage_counters
   where user_id = p_user_id and period_ym = v_period;

  v_used_month  := coalesce(v_used_month, 0);
  v_used_enrich := coalesce(v_used_enrich, 0);

  select coalesce(sum(rows), 0) into v_used_24h
    from export_events
   where user_id = p_user_id and at > now() - interval '24 hours';

  -- Live reservations count against the caps until they expire or commit, so a
  -- user cannot open ten panels and reserve the full quota ten times over.
  select coalesce(sum(allowed_rows), 0) into v_reserved
    from quota_reservations
   where user_id = p_user_id
     and committed_at is null
     and expires_at > now();

  v_allowed := least(
    p_estimated_rows,
    greatest(p_month_cap  - v_used_month - v_reserved, 0),
    greatest(p_rolling_cap - v_used_24h  - v_reserved, 0)
  );

  if v_allowed <= 0 then
    return query select 0, false, now();
    return;
  end if;

  insert into quota_reservations (job_token, user_id, allowed_rows, enrich_allowed, expires_at)
  values (
    p_job_token,
    p_user_id,
    v_allowed,
    p_enrich and (p_enrich_cap - v_used_enrich) > 0,
    now() + p_ttl
  );

  return query
    select v_allowed,
           p_enrich and (p_enrich_cap - v_used_enrich) > 0,
           now() + p_ttl;
end;
$$;

-- ── atomic commit ───────────────────────────────────────────────────────────
-- Idempotent per job token (docs/05 §4).
create or replace function commit_quota(
  p_job_token text,
  p_user_id uuid,
  p_rows int,
  p_enriched int
) returns void
language plpgsql
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_reservation quota_reservations%rowtype;
begin
  select * into v_reservation
    from quota_reservations
   where job_token = p_job_token and user_id = p_user_id
   for update;

  if not found then
    raise exception 'unknown_reservation';
  end if;

  if v_reservation.committed_at is not null then
    return; -- already counted; commit is idempotent
  end if;

  update quota_reservations
     set committed_at = now(),
         committed_rows = least(p_rows, v_reservation.allowed_rows),
         committed_enriched = p_enriched
   where job_token = p_job_token;

  insert into usage_counters (user_id, period_ym, rows_exported, rows_enriched, jobs_run)
  values (p_user_id, v_period, least(p_rows, v_reservation.allowed_rows), p_enriched, 1)
  on conflict (user_id, period_ym) do update
    set rows_exported = usage_counters.rows_exported + excluded.rows_exported,
        rows_enriched = usage_counters.rows_enriched + excluded.rows_enriched,
        jobs_run      = usage_counters.jobs_run + 1;

  if p_rows > 0 then
    insert into export_events (user_id, rows)
    values (p_user_id, least(p_rows, v_reservation.allowed_rows));
  end if;
end;
$$;

-- ── enrichment allowance, decremented transactionally (docs/05 §5) ──────────
create or replace function consume_enrichment(
  p_job_token text,
  p_user_id uuid,
  p_requested int,
  p_enrich_cap int
) returns int
language plpgsql
as $$
declare
  v_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_used int;
  v_in_flight int;
  v_grant int;
begin
  select coalesce(rows_enriched, 0) into v_used
    from usage_counters
   where user_id = p_user_id and period_ym = v_period;
  v_used := coalesce(v_used, 0);

  select coalesce(sum(enriched_used), 0) into v_in_flight
    from quota_reservations
   where user_id = p_user_id and committed_at is null and expires_at > now();

  v_grant := greatest(least(p_requested, p_enrich_cap - v_used - v_in_flight), 0);

  if v_grant > 0 then
    update quota_reservations
       set enriched_used = enriched_used + v_grant
     where job_token = p_job_token;
  end if;

  return v_grant;
end;
$$;

-- ── housekeeping (docs/08 §5 retention: usage 13 months) ────────────────────
create or replace function prune_old_rows() returns void
language sql
as $$
  delete from export_events      where at < now() - interval '30 days';
  delete from auth_tokens        where expires_at < now() - interval '1 day';
  delete from quota_reservations where expires_at < now() - interval '7 days';
  delete from processed_webhooks where processed_at < now() - interval '30 days';
  delete from usage_counters     where period_ym < to_char(now() - interval '13 months', 'YYYY-MM');
  delete from telemetry_daily    where day < (now() - interval '13 months')::date;
$$;
