# Tournament

A stock-picking tournament tracker. Static frontend (vanilla JS, no build step)
reading from Supabase; prices refreshed hourly by a GitHub Action.

- [index.html](index.html) / [app.js](app.js) / [style.css](style.css) — the whole site
- [scripts/fetch_prices.py](scripts/fetch_prices.py) — hourly price + FX fetcher
- [supabase/schema.sql](supabase/schema.sql) — schema and migrations, applied by hand in the SQL Editor
- [tests/scoring.test.mjs](tests/scoring.test.mjs) — `node tests/scoring.test.mjs`

## Things worth knowing before changing scoring

- **`allocations` is append-only.** No update/delete RLS policy. A resubmission on
  the same `effective_date` supersedes the earlier row by `created_at`, and the
  superseded row's date range collapses to empty. Never report or score from a
  period that covers no dates.
- **Every price lookup is scoped to a tournament window** `{start, end}`. A
  completed round freezes at its `end_date`; a null end means still running.
  There is no global start date, and reintroducing one breaks both charts and
  history.
- **A venue is not one currency.** London quotes in USD, GBP *and* pence
  depending on the instrument; Tel Aviv quotes in agorot. Trust `ticker_meta`
  (Yahoo's own `currency` field), not the ticker suffix and not the `currency`
  stored on a position — the rebalance form defaults that to USD.
- **Sub-unit codes (`GBp`, `ILA`, `ZAc`) have no FX pair.** Map to the major
  currency and divide by 100.
- **Unscoreable positions score −100%**, by tournament rule. A ticker with no
  prices yet gets a 24h grace period first, so a correct new entrant isn't
  wiped out while the fetcher catches up.
- **The database has no restorable backup except `backups/`.** The Supabase free
  tier has no point-in-time recovery. `scripts/backup.py` snapshots every table
  to JSONL daily via `.github/workflows/backup.yml`, and git history is the
  archive. `scripts/backup.py --verify` checks for drift; `scripts/restore.py`
  writes a snapshot back (dry run unless `--apply`).
- **`prices` is mutable** — `fetch_prices.py` upserts in place, so a revised
  figure overwrites the value a past leaderboard was computed from. The daily
  snapshot is the only record of what a price *was* on a given day, and so the
  only way to reproduce an old standing exactly.
- **Schema changes are manual.** There is no migrations tooling (it needs Docker).
  Add the SQL to `schema.sql` and make the client degrade gracefully when the
  column or table is absent — PostgREST 400s on a named column that doesn't
  exist, which takes the whole site down between deploy and migration.

Run `node tests/scoring.test.mjs` after touching the scoring engine. It exercises
the real `app.js` against both synthetic fixtures and live Supabase data.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
