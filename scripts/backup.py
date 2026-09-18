#!/usr/bin/env python3
"""Snapshot every Supabase table into backups/ as JSONL, for version control.

Why this exists:

  1. There is no restorable backup otherwise. The Supabase free tier has no
     point-in-time recovery, so a dropped table or a bad service-role write is
     unrecoverable. Committing the snapshot to git gives free, versioned,
     off-site backups with full history.

  2. `prices` is mutable. fetch_prices.py upserts with merge-duplicates, so a
     revised figure from Yahoo silently overwrites the value a past leaderboard
     was computed from. Without a dated snapshot you cannot reproduce last
     week's standings exactly. Git history of this file is that record.

JSONL with sorted keys and one row per line, deliberately: git deltas it well,
so a daily commit of a mostly-unchanged table costs almost nothing, and a diff
shows exactly which rows changed.

Usage:  python scripts/backup.py            # write snapshots
        python scripts/backup.py --verify   # check snapshots match the database
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT / "backups"

SUPABASE_URL = os.environ.get("SUPABASE_URL")
# Read-only work, so the anon key is enough; the service-role key is accepted
# too (the workflow already has it) but nothing here writes to the database.
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY")

# Ordered by the column that makes each table's snapshot stable across runs, so
# an unchanged table produces a byte-identical file and therefore no commit.
TABLES = {
    "tournaments":  "id",
    "participants": "id",
    "allocations":  "id",
    "prices":       "ticker,date",
    "meta":         "id",
    "ticker_meta":  "ticker",
}


def fetch_all(table, order):
    rows, offset, page_size = [], 0, 1000
    while True:
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/{table}?select=*&order={order}",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Range": f"{offset}-{offset + page_size - 1}",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            page = json.loads(resp.read() or "[]")
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size


def serialize(rows):
    """Deterministic: sorted keys, one row per line, trailing newline."""
    return "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in rows)


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)")
        sys.exit(1)

    verify = "--verify" in sys.argv
    BACKUP_DIR.mkdir(exist_ok=True)
    failures, summary = [], []

    for table, order in TABLES.items():
        try:
            rows = fetch_all(table, order)
        except Exception as e:
            # A table that doesn't exist yet (ticker_meta before its migration)
            # is not a backup failure.
            print(f"  {table:14s} SKIP ({e})")
            continue

        payload = serialize(rows)
        path = BACKUP_DIR / f"{table}.jsonl"

        if verify:
            on_disk = path.read_text(encoding="utf-8") if path.exists() else ""
            if on_disk == payload:
                print(f"  {table:14s} OK    {len(rows):>6} rows")
            else:
                disk_rows = len([l for l in on_disk.splitlines() if l.strip()])
                print(f"  {table:14s} DRIFT  snapshot={disk_rows} rows, database={len(rows)} rows")
                failures.append(table)
        else:
            path.write_text(payload, encoding="utf-8")
            print(f"  {table:14s} {len(rows):>6} rows -> {path.relative_to(ROOT)}")
        summary.append((table, len(rows)))

    if verify and failures:
        print(f"\nSnapshots are stale for: {', '.join(failures)}")
        print("Run `python scripts/backup.py` to refresh them.")
        sys.exit(1)

    total = sum(n for _, n in summary)
    print(f"\n{'Verified' if verify else 'Backed up'} {len(summary)} tables, {total} rows total")


if __name__ == "__main__":
    main()
