-- Schema for the tournament Supabase project, as actually run in the
-- Supabase SQL Editor (in this order). Kept here as the version-controlled
-- source of truth — previously this only existed in chat history and an
-- external planning doc, with no way to reproduce or audit it from the repo.
--
-- Not wired up to `supabase db push`/migrations tooling (that needs Docker,
-- which isn't available in this environment) — this is a reference/replay
-- file. If the project ever needs to be recreated, paste this into a fresh
-- project's SQL Editor.

create table tournaments (
  id text primary key,
  name text not null,
  start_date date not null,
  -- Inclusive last scoring day. Null means the round is still running.
  -- Without this a completed tournament's "final" standings kept drifting:
  -- computePortfolioReturn had no upper bound, so every hourly price refresh
  -- silently rewrote the result of a round that had already finished.
  end_date date,
  status text not null default 'active' check (status in ('active','completed'))
);

create table participants (
  id text primary key,
  name text not null
);

create table allocations (
  id bigint generated always as identity primary key,
  tournament_id text not null references tournaments(id),
  participant_id text not null references participants(id),
  effective_date date not null,
  positions jsonb not null,
  created_at timestamptz not null default now()
);
-- Note: an earlier version of this table had a
-- `check (extract(dow from effective_date) = 1)` constraint (Monday-only
-- effective dates). It was dropped after the seed migration failed against
-- it — the site's original launch date (2026-06-02) is a Tuesday, and a
-- constraint meant to validate *new* client submissions doesn't apply to
-- historical seed data. The client (nextWeekMonday() in app.js) already
-- guarantees new submissions land on a Monday; this is not re-enforced at
-- the DB level.

create table prices (
  ticker text not null,
  date date not null,
  price numeric not null,
  primary key (ticker, date)
);

create table meta (
  id smallint primary key default 1 check (id = 1),
  fetched_at timestamptz,
  base_currency text
);

-- Weight-sum guard: app.js's updateWeightSum() already validates this
-- client-side, but since allocations.insert is open to anyone with no auth,
-- this trigger is the only real backstop against a bypassed client.
create or replace function check_allocation_weights() returns trigger as $$
declare total numeric;
begin
  select coalesce(sum((pos->>'weight')::numeric), 0) into total
  from jsonb_array_elements(new.positions) as pos;
  if total < 99.5 or total > 100.5 then
    raise exception 'positions weights must sum to ~100 (got %)', total;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger allocations_weight_check
  before insert on allocations
  for each row execute function check_allocation_weights();

alter table tournaments  enable row level security;
alter table participants enable row level security;
alter table allocations  enable row level security;
alter table prices       enable row level security;
alter table meta         enable row level security;

create policy "tournaments: public read"  on tournaments  for select using (true);
create policy "participants: public read" on participants for select using (true);
create policy "allocations: public read"  on allocations  for select using (true);
create policy "allocations: public insert" on allocations for insert with check (true);
create policy "prices: public read"       on prices       for select using (true);
create policy "meta: public read"         on meta         for select using (true);
-- No insert/update/delete policies for anon anywhere else: PostgREST
-- default-denies with RLS on and no matching permissive policy.
-- `allocations` is append-only by design (no update/delete policy at all)
-- so history can't be tampered with, only added to. `prices`/`meta` writes
-- happen only via the service_role key (used server-side in
-- .github/workflows/refresh.yml → scripts/fetch_prices.py), which bypasses
-- RLS entirely.


-- ─────────────────────────────────────────────────────────────────────────
-- Migration 2026-09-16: tournament end dates
--
-- Run this block in the Supabase SQL Editor against the existing project.
-- (The table definition above already includes end_date for a fresh replay;
-- this is the incremental version for the live database.)
-- ─────────────────────────────────────────────────────────────────────────

alter table tournaments add column if not exists end_date date;

-- The Jun–Sep 2026 round is over and its standings are final as of Sep 2.
update tournaments set end_date = '2026-09-02' where id = 't-2026-06';

-- t-2026-09 deliberately keeps end_date null — it's still running.


-- ─────────────────────────────────────────────────────────────────────────
-- Migration 2026-09-16b: authoritative per-ticker currency
--
-- A venue is not one currency. London quotes 3SMO.L in USD, SNV3.L in pence
-- and VUSA.L in pounds, and Tel Aviv quotes in agorot rather than shekels, so
-- guessing from the ticker suffix mis-prices real holdings by 100x. Yahoo
-- reports the true currency per instrument; fetch_prices.py records it here
-- once per ticker and app.js prefers it over the suffix guess.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists ticker_meta (
  ticker text primary key,
  currency text not null,
  updated_at timestamptz not null default now()
);

alter table ticker_meta enable row level security;
create policy "ticker_meta: public read" on ticker_meta for select using (true);
-- Writes only via the service_role key in fetch_prices.py, which bypasses RLS.
