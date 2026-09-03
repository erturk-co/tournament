#!/usr/bin/env python3
"""One-off migration: turn the current data/portfolios.json and data/prices.json
into SQL insert statements to paste into the Supabase SQL Editor once, after
running the schema from the plan. Not part of ongoing operation — the site
reads from Supabase after this, not from these JSON files.

Usage: python scripts/generate_supabase_seed.py > seed.sql
"""
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"

# Force UTF-8 regardless of the console's active codepage — on Windows,
# stdout redirected with `>` otherwise silently encodes with cp1252, which
# mangles non-ASCII characters (e.g. the en-dash in tournament names) into
# bytes Postgres's strict UTF-8 parser will reject.
sys.stdout.reconfigure(encoding="utf-8")


def sql_str(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_jsonb(value):
    return sql_str(json.dumps(value)) + "::jsonb"


def sql_num(value):
    return "null" if value is None else repr(float(value))


COMPLETED_TOURNAMENT = {"id": "t-2026-06", "name": "Jun–Sep 2026", "start_date": "2026-06-02"}
ACTIVE_TOURNAMENT = {"id": "t-2026-09", "name": "Sep 2026", "start_date": "2026-09-14"}


def main():
    portfolios = json.loads((DATA / "portfolios.json").read_text(encoding="utf-8"))
    prices_raw = json.loads((DATA / "prices.json").read_text(encoding="utf-8"))

    out = []

    out.append("-- tournaments: old data is a completed tournament; the new one starts empty")
    out.append(
        f"insert into tournaments (id, name, start_date, status) values "
        f"({sql_str(COMPLETED_TOURNAMENT['id'])}, {sql_str(COMPLETED_TOURNAMENT['name'])}, "
        f"{sql_str(COMPLETED_TOURNAMENT['start_date'])}, 'completed');"
    )
    out.append(
        f"insert into tournaments (id, name, start_date, status) values "
        f"({sql_str(ACTIVE_TOURNAMENT['id'])}, {sql_str(ACTIVE_TOURNAMENT['name'])}, "
        f"{sql_str(ACTIVE_TOURNAMENT['start_date'])}, 'active');"
    )

    out.append("\n-- participants")
    for p in portfolios:
        out.append(
            f"insert into participants (id, name) values "
            f"({sql_str(p['id'])}, {sql_str(p['name'])});"
        )

    out.append("\n-- allocations (all under the completed tournament — the active one starts empty)")
    for p in portfolios:
        for alloc in p["allocations"]:
            out.append(
                f"insert into allocations (tournament_id, participant_id, effective_date, positions) values "
                f"({sql_str(COMPLETED_TOURNAMENT['id'])}, {sql_str(p['id'])}, "
                f"{sql_str(alloc['effective_date'])}, {sql_jsonb(alloc['positions'])});"
            )

    out.append("\n-- meta")
    out.append(
        f"insert into meta (id, fetched_at, base_currency) values "
        f"(1, {sql_str(prices_raw.get('fetched_at'))}, {sql_str(prices_raw.get('base_currency'))}) "
        f"on conflict (id) do update set fetched_at = excluded.fetched_at, "
        f"base_currency = excluded.base_currency;"
    )

    out.append("\n-- prices (batched)")
    rows = [
        (ticker, date, price)
        for ticker, series in prices_raw.get("prices", {}).items()
        for date, price in series.items()
    ]
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        values = ", ".join(
            f"({sql_str(t)}, {sql_str(d)}, {sql_num(p)})" for t, d, p in batch
        )
        out.append(
            f"insert into prices (ticker, date, price) values {values} "
            f"on conflict (ticker, date) do update set price = excluded.price;"
        )

    print("\n".join(out))


if __name__ == "__main__":
    main()
