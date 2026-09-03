// Proxies two public, unauthenticated finance APIs so the browser can query
// them without hitting CORS blocks (neither sets Access-Control-Allow-Origin).
//
//   GET ?action=search&q=<query>       -> Yahoo Finance ticker search
//   GET ?action=polymarket&slug=<slug> -> Polymarket event outcomes/prices

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function searchYahoo(q: string) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo search failed: ${res.status}`);
  const data = await res.json();
  return (data.quotes || []).map((item: any) => ({
    symbol: item.symbol,
    name: item.longname || item.shortname || item.symbol,
    exchange: item.exchange,
    exchDisp: item.exchDisp,
    quoteType: item.quoteType,
  }));
}

// Mirrors the parsing in scripts/fetch_prices.py's fetch_polymarket().
async function lookupPolymarket(slug: string) {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`polymarket lookup failed: ${res.status}`);
  const events = await res.json();
  if (!events.length) return { slug, question: null, outcomes: [] };

  const market = events[0].markets?.[0] ?? {};
  const outcomes: string[] = JSON.parse(market.outcomes || "[]");
  const prices: string[] = JSON.parse(market.outcomePrices || "[]");

  return {
    slug,
    question: market.question || events[0].title || slug,
    outcomes: outcomes.map((label, i) => ({ label, price: parseFloat(prices[i] ?? "0") })),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json([]);
      return json(await searchYahoo(q));
    }

    if (action === "polymarket") {
      const slug = url.searchParams.get("slug") || "";
      if (!slug) return json({ error: "missing slug" }, 400);
      return json(await lookupPolymarket(slug));
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
