#!/usr/bin/env python3
"""Restore Supabase tables from the JSONL snapshots in backups/.

Dry run by default. Nothing is written until you pass --apply, because this is
the one script in the repo that can overwrite the append-only allocation record.

  python scripts/restore.py                      # show what would change
  python scripts/restore.py --table allocations  # narrow to one table
  python scripts/restore.py --apply              # actually write

Restoring an older state means checking out the snapshot first:

  git log --oneline -- backups/allocations.jsonl     # find the commit
  git checkout <sha> -- backups/allocations.jsonl    # get that version
  python scripts/restore.py --table allocations      # inspect the diff
  python scripts/restore.py --table allocations --apply

Requires SUPABASE_SERVICE_ROLE_KEY: the anon key cannot write, which is the
whole point of the RLS setup.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT / "backups"

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Primary key per table, used to compare snapshot against live and to upsert.
KEYS = {
    "tournaments":  ("id",),
    "participants": ("id",),
    "allocations":  ("id",),
    "prices":       ("ticker", "date"),
    "meta":         ("id",),
    "ticker_meta":  ("ticker",),
}


def request(path, method="GET", body=None, prefer=None, range_header=None):
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    if range_header:
        headers["Range"] = range_header
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}", data=data,
                                 headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def fetch_all(table):
    rows, offset = [], 0
    while True:
        page = request(f"{table}?select=*", range_header=f"{offset}-{offset + 999}") or []
        rows.extend(page)
        if len(page) < 1000:
            return rows
        offset += 1000


def key_of(row, key_cols):
    return tuple(str(row.get(c)) for c in key_cols)


def main():
    if not SUPABASE_URL or not SERVICE_KEY:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
        sys.exit(1)

    apply_changes = "--apply" in sys.argv
    only = None
    if "--table" in sys.argv:
        only = sys.argv[sys.argv.index("--table") + 1]

    print("APPLYING CHANGES" if apply_changes else "DRY RUN — nothing will be written\n")

    for table, key_cols in KEYS.items():
        if only and table != only:
            continue
        path = BACKUP_DIR / f"{table}.jsonl"
        if not path.exists():
            print(f"  {table:14s} no snapshot, skipping")
            continue

        snapshot = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
        try:
            live = fetch_all(table)
        except Exception as e:
            print(f"  {table:14s} could not read live table ({e})")
            continue

        live_by_key = {key_of(r, key_cols): r for r in live}
        snap_by_key = {key_of(r, key_cols): r for r in snapshot}

        missing = [snap_by_key[k] for k in snap_by_key.keys() - live_by_key.keys()]
        changed = [snap_by_key[k] for k in snap_by_key.keys() & live_by_key.keys()
                   if snap_by_key[k] != live_by_key[k]]
        # Reported but never deleted: this script only ever adds rows back or
        # corrects them. Removing live rows that a snapshot predates would turn
        # a restore into data loss, so that stays a manual decision.
        extra = [live_by_key[k] for k in live_by_key.keys() - snap_by_key.keys()]

        print(f"  {table:14s} snapshot={len(snapshot):<6} live={len(live):<6} "
              f"missing={len(missing)} changed={len(changed)} extra-in-live={len(extra)}")

        for r in (missing + changed)[:5]:
            print(f"       would write {key_of(r, key_cols)}")
        if len(missing) + len(changed) > 5:
            print(f"       ... and {len(missing) + len(changed) - 5} more")
        if extra:
            print(f"       NOTE {len(extra)} row(s) exist live but not in the snapshot; "
                  f"left alone — delete by hand if you truly want the older state")

        if apply_changes and (missing or changed):
            rows = missing + changed
            for i in range(0, len(rows), 500):
                request(table, method="POST", body=rows[i:i + 500],
                        prefer="resolution=merge-duplicates,return=minimal")
            print(f"       wrote {len(rows)} row(s)")

    if not apply_changes:
        print("\nRe-run with --apply to write these changes.")


if __name__ == "__main__":
    main()
