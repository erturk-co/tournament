import json
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

def load_portfolios():
    with open(DATA / "portfolios.json") as f:
        return json.load(f)

def collect_tickers(portfolios):
    yf_tickers = set()
    poly_tickers = set()
    coingecko_tickers = {}  # ticker -> coingecko_id
    fx_pairs = set()
    for p in portfolios:
        for pos in p["positions"]:
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
    path = DATA / "prices.json"
    if path.exists():
        with open(path) as f:
            return json.load(f).get("prices", {})
    return {}

def main():
    portfolios = load_portfolios()
    yf_tickers, poly_tickers, coingecko_tickers, fx_pairs = collect_tickers(portfolios)
    existing = load_existing_prices()

    prices = {}
    prices.update(fetch_yfinance(yf_tickers + fx_pairs, START))
    prices.update(fetch_coingecko(coingecko_tickers, START, existing))
    prices.update(fetch_polymarket(poly_tickers, existing))

    out = {
        "fetched_at": str(date.today()),
        "start_date": START,
        "base_currency": BASE_CURRENCY,
        "prices": prices
    }

    out_path = DATA / "prices.json"
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {out_path} ({len(prices)} series)")

if __name__ == "__main__":
    main()
