import json
import os
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    print("Run: pip install yfinance")
    sys.exit(1)

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"
START = "2026-06-02"
BASE_CURRENCY = "USD"

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

def supabase_request(path, method="GET", body=None, prefer=None, range_header=None):
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars")
        sys.exit(1)
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    if range_header:
        headers["Range"] = range_header
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None

def supabase_get_all(path):
    """GETs are paginated (PostgREST caps rows per response) — loop with a
    Range header until a page comes back shorter than the page size."""
    page_size = 1000
    offset = 0
    rows = []
    while True:
        page = supabase_request(path, range_header=f"{offset}-{offset + page_size - 1}") or []
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows

def load_allocations():
    return supabase_get_all("allocations?select=positions")

def collect_tickers(allocations):
    yf_tickers = set()
    poly_tickers = set()
    coingecko_tickers = {}  # ticker -> coingecko_id
    fx_pairs = set()
    for alloc in allocations:
        for pos in alloc["positions"]:
            t = pos.get("ticker")
            if not t:
                continue
            if t.startswith("POLY:"):
                poly_tickers.add(t)
            elif pos.get("coingecko_id"):
                coingecko_tickers[t] = pos["coingecko_id"]
            else:
                yf_tickers.add(t)
            if pos.get("currency") and pos["currency"] != BASE_CURRENCY:
                fx_pairs.add(f"{pos['currency']}USD=X")
    return sorted(yf_tickers), sorted(poly_tickers), coingecko_tickers, sorted(fx_pairs)

def fetch_yfinance(tickers, start):
    if not tickers:
        return {}
    print(f"Fetching {len(tickers)} yfinance tickers...")
    raw = yf.download(tickers, start=start, auto_adjust=True, progress=False)
    closes = raw["Close"] if "Close" in raw else raw
    # single-ticker download returns a Series, not a DataFrame
    if hasattr(closes, "to_frame"):
        closes = closes.to_frame(name=tickers[0])
    result = {}
    for t in tickers:
        if t in closes.columns:
            series = closes[t].dropna()
            result[t] = {str(d.date()): round(float(v), 6) for d, v in series.items()}
        else:
            print(f"  WARNING: no data for {t}")
    return result


def fix_recent_splits(prices, yf_tickers, start):
    """
    yfinance auto_adjust can return inconsistent data for tickers with very recent
    reverse splits — mixing pre-split and post-split prices in the same series.
    For any ticker with a split since start, re-fetch raw (unadjusted) prices and
    manually normalize everything to the post-split price basis.
    """
    import pandas as pd

    for ticker in yf_tickers:
        if ticker not in prices:
            continue
        try:
            t = yf.Ticker(ticker)
            splits = t.splits
            if splits.empty:
                continue

            recent = splits[[str(idx.date()) >= start for idx in splits.index]]
            if recent.empty:
                continue

            print(f"  {ticker}: {len(recent)} split(s) since {start} — recomputing from raw prices")

            # Re-fetch raw unadjusted prices
            hist = t.history(start=start, auto_adjust=False)
            if hist.empty:
                continue

            raw = {str(d.date()): round(float(v), 6)
                   for d, v in hist["Close"].dropna().items()}
            sorted_dates = sorted(raw)

            for split_ts, ratio in sorted(recent.items()):
                scale = round(1.0 / ratio)  # e.g. 30 for a 1-for-30 reverse split
                recorded = str(split_ts.date())

                # --- Step 1: find the natural bimodal break in the price series ---
                # A reverse split creates two distinct price clusters; the largest
                # relative gap between consecutive sorted prices marks the boundary.
                all_prices = sorted(raw.values())
                threshold = None
                max_gap = 0.0
                for i in range(1, len(all_prices)):
                    if all_prices[i - 1] > 0:
                        gap = all_prices[i] / all_prices[i - 1]
                        if gap > max_gap and gap > 2.0:
                            max_gap = gap
                            threshold = (all_prices[i - 1] + all_prices[i]) / 2

                if threshold is None:
                    print(f"    WARNING: no bimodal gap found for {ticker}, skipping split fix")
                    continue

                # --- Step 2: find the true effective date ---
                # The effective date is the first date where the price exceeds the
                # threshold AND *stays* above it for the next 3 trading days.
                # This rejects isolated yfinance data artifacts where a single day
                # briefly shows the post-split price before reverting.
                effective = recorded
                for i, d in enumerate(sorted_dates):
                    if raw[d] > threshold:
                        next_days = sorted_dates[i + 1: i + 4]
                        if all(raw[d2] > threshold for d2 in next_days) or len(next_days) < 3:
                            effective = d
                            break

                # --- Step 3: scale pre-split prices to the post-split basis ---
                # Only scale prices that are clearly still at the pre-split level
                # (< threshold); isolated artifacts that already show post-split
                # prices are left untouched so they don't get doubled.
                n_scaled = 0
                for d in sorted_dates:
                    if d < effective and raw[d] < threshold:
                        raw[d] = round(raw[d] * scale, 6)
                        n_scaled += 1

                print(f"    1:{scale} reverse split | recorded {recorded} | "
                      f"effective {effective} | threshold ${threshold:.2f} | "
                      f"{n_scaled} pre-split prices scaled")

            prices[ticker] = raw

        except Exception as e:
            print(f"  WARNING: split correction failed for {ticker}: {e}")

    return prices

def fetch_coingecko(coingecko_tickers, start, existing_prices):
    if not coingecko_tickers:
        return {}
    import time
    from datetime import datetime
    print(f"Fetching {len(coingecko_tickers)} CoinGecko tickers...")
    result = {}
    start_unix = int(datetime.strptime(start, "%Y-%m-%d").timestamp())
    end_unix = int(datetime.now().timestamp())

    for ticker, coin_id in coingecko_tickers.items():
        try:
            url = (f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart/range"
                   f"?vs_currency=usd&from={start_unix}&to={end_unix}")
            req = urllib.request.Request(url, headers={"User-Agent": "tournament-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            prices_raw = data.get("prices", [])
            series = {}
            for ts_ms, price in prices_raw:
                d = str(datetime.utcfromtimestamp(ts_ms / 1000).date())
                if d >= start:
                    series[d] = round(float(price), 6)
            if series:
                result[ticker] = series
                print(f"  {ticker} ({coin_id}): {len(series)} days")
            else:
                print(f"  WARNING: no data returned for {coin_id}")
            time.sleep(1.5)  # CoinGecko free tier rate limit
        except Exception as e:
            print(f"  WARNING: failed to fetch {coin_id}: {e}")
            if ticker in existing_prices:
                result[ticker] = existing_prices[ticker]
    return result

def fetch_polymarket(poly_tickers, existing_prices):
    if not poly_tickers:
        return {}
    print(f"Fetching {len(poly_tickers)} Polymarket positions...")
    result = {}
    today = str(date.today())

    for ticker in poly_tickers:
        # format: POLY:{slug}:{OUTCOME}
        parts = ticker.split(":", 2)
        if len(parts) != 3:
            print(f"  WARNING: bad POLY ticker format: {ticker}")
            continue
        _, slug, outcome = parts
        outcome_lower = outcome.lower()

        try:
            # Step 1: fetch event metadata from Gamma API
            url = f"https://gamma-api.polymarket.com/events?slug={slug}"
            req = urllib.request.Request(url, headers={"User-Agent": "tournament-tracker/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                events = json.loads(resp.read())

            if not events:
                print(f"  WARNING: no event found for slug {slug}")
                continue

            market = events[0].get("markets", [{}])[0]
            outcomes    = json.loads(market.get("outcomes",     "[]"))
            prices_raw  = json.loads(market.get("outcomePrices","[]"))
            token_ids   = json.loads(market.get("clobTokenIds", "[]"))

            idx = next((i for i, o in enumerate(outcomes) if o.lower() == outcome_lower), None)
            if idx is None:
                print(f"  WARNING: outcome '{outcome}' not found in {outcomes}")
                continue

            current_price = round(float(prices_raw[idx]), 6)

            # Step 2: fetch full daily price history from CLOB API
            series = {}
            if token_ids and idx < len(token_ids):
                token_id = token_ids[idx]
                hist_url = (f"https://clob.polymarket.com/prices-history"
                            f"?market={token_id}&interval=max&fidelity=1440")
                hist_req = urllib.request.Request(hist_url, headers={"User-Agent": "tournament-tracker/1.0"})
                with urllib.request.urlopen(hist_req, timeout=15) as resp:
                    hist = json.loads(resp.read())
                for entry in hist.get("history", []):
                    d = str(datetime.utcfromtimestamp(entry["t"]).date())
                    if d >= START:
                        series[d] = round(float(entry["p"]), 6)
                print(f"  {ticker}: {current_price:.4f} ({len(series)} historical days)")
            else:
                print(f"  WARNING: no clobTokenIds for {slug}, falling back to snapshot")

            # always write today's live price (CLOB history may lag by a day)
            series[today] = current_price
            result[ticker] = series

        except Exception as e:
            print(f"  WARNING: failed to fetch {ticker}: {e}")
            if ticker in existing_prices:
                result[ticker] = existing_prices[ticker]

    return result

def load_existing_prices():
    rows = supabase_get_all("prices?select=ticker,date,price")
    existing = {}
    for row in rows:
        existing.setdefault(row["ticker"], {})[row["date"]] = row["price"]
    return existing

def upsert_prices(prices):
    rows = [
        {"ticker": ticker, "date": d, "price": p}
        for ticker, series in prices.items()
        for d, p in series.items()
    ]
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        supabase_request(
            "prices", method="POST", body=batch,
            prefer="resolution=merge-duplicates,return=minimal",
        )
    return len(rows)

def upsert_meta(fetched_at, base_currency):
    supabase_request(
        "meta", method="POST",
        body={"id": 1, "fetched_at": fetched_at, "base_currency": base_currency},
        prefer="resolution=merge-duplicates,return=minimal",
    )

def main():
    allocations = load_allocations()
    yf_tickers, poly_tickers, coingecko_tickers, fx_pairs = collect_tickers(allocations)
    existing = load_existing_prices()

    prices = {}
    prices.update(fetch_yfinance(yf_tickers + fx_pairs, START))
    fix_recent_splits(prices, yf_tickers, START)
    prices.update(fetch_coingecko(coingecko_tickers, START, existing))
    prices.update(fetch_polymarket(poly_tickers, existing))

    n_rows = upsert_prices(prices)
    upsert_meta(str(date.today()), BASE_CURRENCY)
    print(f"Upserted {n_rows} price rows across {len(prices)} series into Supabase")

if __name__ == "__main__":
    main()
