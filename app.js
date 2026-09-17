/* ─── config ─────────────────────────────────────────────────────────── */
const BASE_CURRENCY = "USD";
const COLORS = ["#4a6880","#9e6b72","#7a8f6e","#a07a3a","#6b7a8f","#8f7a6b","#b5564a","#5a7a5e"];
const LW = window.LightweightCharts;

// Public by design — Supabase security is enforced by Row Level Security
// policies on the database, not by keeping this key secret.
const SUPABASE_URL = "https://udyelrobkhnawlpvkcbp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkeWVscm9ia2huYXdscHZrY2JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Mjk0OTEsImV4cCI6MjEwNDAwNTQ5MX0.z5eXg2GZQ8jHg7KQVZdOTXocbq8RXX7qVLfhD4fgTD4";

async function supabaseRequestOnce(path, { method = "GET", body, prefer, range } = {}) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  if (range) headers.Range = range;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// GETs are paginated (PostgREST caps rows per response) — loop with a Range
// header until a page comes back shorter than the page size.
async function supabaseRequest(path, opts = {}) {
  if (opts.method && opts.method !== "GET") return supabaseRequestOnce(path, opts);

  const pageSize = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const page = await supabaseRequestOnce(path, { ...opts, range: `${offset}-${offset + pageSize - 1}` });
    all = all.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/* ─── chart theme ────────────────────────────────────────────────────── */
const CHART_BASE = {
  autoSize: true,
  layout: {
    background: { type: 'solid', color: '#f4efe6' },
    textColor: '#9a9186',
    fontFamily: "'Commit Mono','Courier New',monospace",
    fontSize: 10,
  },
  grid: {
    vertLines: { color: '#ebe5dc' },
    horzLines: { color: '#ebe5dc' },
  },
  crosshair: {
    vertLine: { color: '#9a9186', width: 1, style: 3, labelBackgroundColor: '#5a5549' },
    horzLine: { color: '#9a9186', width: 1, style: 3, labelBackgroundColor: '#5a5549' },
  },
  rightPriceScale: {
    borderColor: '#d4cfc7',
    scaleMargins: { top: 0.1, bottom: 0.1 },
  },
  timeScale: {
    borderColor: '#d4cfc7',
    fixLeftEdge: true,
    fixRightEdge: true,
  },
  handleScroll: false,
  handleScale: false,
  localization: {
    priceFormatter: p => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`,
  },
};

const BASELINE_DEFAULTS = {
  baseValue: { type: 'price', price: 0 },
  topLineColor: '#5a7a5e',
  topFillColor1: 'rgba(90,122,94,0.18)',
  topFillColor2: 'rgba(90,122,94,0.02)',
  bottomLineColor: '#b5564a',
  bottomFillColor1: 'rgba(181,86,74,0.02)',
  bottomFillColor2: 'rgba(181,86,74,0.18)',
  lineWidth: 2,
  priceLineVisible: false,
  lastValueVisible: true,
  crosshairMarkerVisible: true,
  crosshairMarkerRadius: 4,
};

/* ─── state ──────────────────────────────────────────────────────────── */
let portfolios = [];       // active tournament only
let activeTournament = null;
let historyTournaments = []; // [{ ...tournament, portfolios }], newest first
let priceData = {};
let lwCharts = [];

/* ─── tournament windows ─────────────────────────────────────────────────
   Every price lookup is scoped to the window of the tournament being
   displayed. Previously a single module-level START_DATE held the earliest
   start across *all* tournaments, so the Sep 2026 round still rendered
   charts from 2026-06-02 (the previous round's start) and a completed
   round's "final" standings kept accruing forever. A window is
   { start, end }; `end` is inclusive, and null means "still running". ── */
function windowFor(tournament) {
  return { start: tournament.start_date, end: tournament.end_date ?? null };
}

function withinWindow(date, win) {
  return date >= win.start && (!win.end || date <= win.end);
}

// The last date a window can be scored at — a completed tournament is frozen
// at its end_date no matter how much later it's viewed.
function windowAsOf(win, asOfDate = getToday()) {
  return win.end && win.end < asOfDate ? win.end : asOfDate;
}

let activeWindow = null;

/* ─── init ───────────────────────────────────────────────────────────── */
async function loadData() {
  const [tournamentRows, participantRows, allocRows, metaRows, priceRows, tickerMetaRows] = await Promise.all([
    // `select=*` rather than naming columns: `end_date` is added by a manual
    // migration (see supabase/schema.sql), and PostgREST 400s on a named
    // column that doesn't exist yet — which would take the whole site down
    // between deploying this and running the SQL. With `*`, a pre-migration
    // database simply yields no end_date, every tournament reads as ongoing,
    // and the site keeps working until the migration lands. Two rows, so the
    // wildcard costs nothing.
    supabaseRequest("tournaments?select=*"),
    supabaseRequest("participants?select=id,name"),
    supabaseRequest("allocations?select=tournament_id,participant_id,effective_date,positions,created_at&order=effective_date.asc"),
    supabaseRequest("meta?select=fetched_at,base_currency"),
    supabaseRequest("prices?select=ticker,date,price"),
    // Same migration as end_date. Missing table resolves to null rather than
    // failing the load, so the site works before the SQL is run.
    supabaseRequest("ticker_meta?select=ticker,currency").catch(() => null),
  ]);

  activeTournament = tournamentRows.find(t => t.status === "active") ?? null;
  activeWindow = activeTournament ? windowFor(activeTournament) : null;

  const portfoliosFor = (tournamentId) => participantRows.map(p => ({
    ...p,
    allocations: allocRows
      .filter(a => a.tournament_id === tournamentId && a.participant_id === p.id)
      .map(a => ({ effective_date: a.effective_date, positions: a.positions, created_at: a.created_at })),
  }));

  portfolios = activeTournament ? portfoliosFor(activeTournament.id) : [];

  historyTournaments = tournamentRows
    .filter(t => t.status !== "active")
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    // unlike the active tournament (where showing everyone, allocated or
    // not, is the point), a completed tournament's roster is closed — a
    // participant added after it ended shouldn't appear as a phantom 0%
    .map(t => ({ ...t, portfolios: portfoliosFor(t.id).filter(p => p.allocations.length > 0) }));

  priceData = {};
  priceRows.forEach(({ ticker, date, price }) => {
    (priceData[ticker] ??= {})[date] = price;
  });

  // Populated by fetch_prices.py from Yahoo's own `currency` field. Absent
  // until the ticker_meta migration runs, in which case currencyFor() falls
  // back to the suffix guess.
  tickerCurrency = {};
  tickerMetaRows?.forEach(({ ticker, currency }) => {
    if (currency) tickerCurrency[ticker] = currency;
  });

  const meta = metaRows[0];
  document.getElementById("last-updated").textContent =
    `prices as of ${meta?.fetched_at ?? "unknown"}`;
}

async function init() {
  try {
    await loadData();
    setupNav();
    setupRebalancePage();
    renderLeaderboard();
  } catch (e) {
    console.error(e);
    document.querySelector("main").innerHTML =
      `<p class="loading">Could not load data. Check the Supabase connection.</p>`;
  }
}

/* ─── week / allocation scheduling ──────────────────────────────────────
   "Effective next Monday" is enforced purely by comparing effective_date
   strings to today (UTC date, matching how prices are dated in Supabase).
   No server-side promotion job is needed. ────────────────────────────── */
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function weekMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function nextWeekMonday(asOfDate = getToday()) {
  const d = new Date(`${weekMonday(asOfDate)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function effectiveAllocation(participant, asOfDate = getToday()) {
  const sorted = [...participant.allocations].sort((a, b) =>
    a.effective_date.localeCompare(b.effective_date) || a.created_at.localeCompare(b.created_at));
  let current = null;
  let pending = null;
  for (const a of sorted) {
    if (a.effective_date <= asOfDate) current = a;
    else { pending = a; break; }
  }
  return { current, pending };
}

// Returns { price, date } or null. The date is the actual trading day the
// price came from (not necessarily periodStart itself, e.g. if periodStart
// falls on a weekend/holiday), so callers can look up FX at the matching date
// instead of silently pairing a same-currency price with a different day's
// FX rate.
//
// The live price series always wins over a stored `baseline_price`. That
// field is a snapshot taken at submission time, so for a position carried
// into a later tournament it anchors returns to the wrong date entirely — a
// position submitted at 0.295 and worth 0.285 when the round actually opened
// was scoring a flat 0.00% instead of its real return. It survives only as a
// fallback for an instrument whose in-window prints are all non-positive —
// callers reject a ticker with no series at all before reaching this point,
// so the fallback cannot rescue one of those.
//
// A baseline of 0 is never usable: it means an already-settled prediction
// market, and dividing by it produced Infinity totals that sorted straight to
// the top of the leaderboard. Rejecting it makes the caller score the position
// as a total loss instead.
//
// The scan takes the first *positive* print rather than simply the first one.
// Checking only `dates[0]` meant a single junk row on the window's opening day
// (0, negative, or null) condemned an otherwise fully-priced instrument to
// -100%, even when it had good prices every following day. An instrument whose
// every in-window print is 0 has genuinely settled and still returns null.
function getBaselinePriceForPosition(pos, periodStart, win) {
  const series = priceData[pos.ticker];
  if (series) {
    const date = Object.keys(series)
      .filter(d => d >= periodStart && withinWindow(d, win))
      .sort()
      .find(d => series[d] > 0);
    if (date) return { price: series[date], date };
  }
  if (pos.baseline_price > 0) return { price: pos.baseline_price, date: periodStart };
  return null;
}

/* ─── nav ────────────────────────────────────────────────────────────── */
function setupNav() {
  document.querySelectorAll(".nav-link").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      showPage(a.dataset.page);
      document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
      a.classList.add("active");
    });
  });
  document.getElementById("back-btn").addEventListener("click", () => {
    showPage("leaderboard");
    document.querySelectorAll(".nav-link").forEach(l =>
      l.classList.toggle("active", l.dataset.page === "leaderboard"));
  });
}

function showPage(name) {
  destroyCharts();
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const el = document.getElementById(`page-${name}`);
  if (el) el.classList.add("active");
  if (name === "portfolios") renderPortfolios();
  if (name === "history") renderHistory();
}

/* ─── price helpers ──────────────────────────────────────────────────── */
function getDates(win) {
  const all = new Set();
  Object.values(priceData).forEach(s => Object.keys(s).forEach(d => all.add(d)));
  return [...all].filter(d => withinWindow(d, win)).sort();
}

// Some venues quote in a sub-unit of their currency, and there is no FX pair
// for a sub-unit — London in pence, Tel Aviv in agorot, Johannesburg in cents.
// Convert to the major unit and scale. This cancels out of a return ratio
// (both ends get the same divisor) but keeps the model honest, and matters the
// moment anything displays a converted level.
const SUBUNIT = { GBp: ["GBP", 100], ILA: ["ILS", 100], ZAc: ["ZAR", 100] };

// Ticker -> the currency Yahoo actually reports, recorded by fetch_prices.py.
// This is the only reliable source: a venue is not one currency. London alone
// quotes 3SMO.L in USD, SNV3.L in pence and VUSA.L in pounds, and the stored
// `currency` on a position says "USD" for all three because the rebalance form
// defaults it whenever the exchange code isn't recognised.
let tickerCurrency = {};

// Fallback for tickers the fetcher hasn't recorded yet. A suffix is a decent
// guess for single-currency venues and a bad one for London, which is why the
// recorded value wins whenever it exists.
const SUFFIX_CURRENCY = {
  ".IS": "TRY", ".SW": "CHF", ".TA": "ILA", ".L": "GBp",
  ".MI": "EUR", ".DE": "EUR", ".PA": "EUR", ".AS": "EUR", ".BR": "EUR", ".MC": "EUR",
  ".KS": "KRW", ".KQ": "KRW", ".T": "JPY", ".HK": "HKD",
  ".ST": "SEK", ".OL": "NOK", ".CO": "DKK",
  ".TO": "CAD", ".AX": "AUD", ".NS": "INR", ".SA": "BRL",
};

function currencyFor(pos) {
  const ticker = pos.ticker || "";
  if (tickerCurrency[ticker]) return tickerCurrency[ticker];
  for (const [suffix, ccy] of Object.entries(SUFFIX_CURRENCY)) {
    if (ticker.endsWith(suffix)) return ccy;
  }
  return pos.currency || BASE_CURRENCY;
}

// Currencies priced at parity because no FX series exists yet. Collected per
// computation and reported alongside the result, never as a module-level
// global: a global leaked one participant's missing rates onto everybody
// else's page and outlived the condition that set it.
function getFXRate(ccy, date, missing = null) {
  if (!ccy || ccy === BASE_CURRENCY) return 1;
  const [code, scale] = SUBUNIT[ccy] ?? [ccy, 1];
  const series = priceData[`${code}USD=X`];
  const closest = series && sortedDates(series).filter(d => d <= date).pop();
  if (!closest) {
    missing?.add(code);
    return 1 / scale;   // same units as the normal path, so parity still cancels
  }
  return series[closest] / scale;
}

// Object.keys().sort() on every FX lookup is two sorts per position per date.
// The series only changes when loadData runs, so cache it there.
const sortedDateCache = new WeakMap();
function sortedDates(series) {
  let dates = sortedDateCache.get(series);
  if (!dates) {
    dates = Object.keys(series).sort();
    sortedDateCache.set(series, dates);
  }
  return dates;
}

function getPositionUrl(pos) {
  const t = pos.ticker;
  if (!t) return null;
  if (t.startsWith("POLY:")) return `https://polymarket.com/event/${encodeURIComponent(t.split(":")[1] ?? "")}`;
  if (pos.coingecko_id)       return `https://www.coingecko.com/en/coins/${encodeURIComponent(pos.coingecko_id)}`;
  return `https://finance.yahoo.com/quote/${encodeURIComponent(t)}`;
}

// Positions are submitted through a public, unauthenticated write path
// (the Rebalance form's POST to Supabase), so every field on them is
// untrusted and must be escaped before landing in innerHTML.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function getPriceSeries(ticker, win) {
  const series = priceData[ticker];
  if (!series) return null;
  return Object.keys(series).filter(d => withinWindow(d, win)).sort()
    .map(d => ({ time: d, value: series[d] }));
}

function getReturnSeries(pos, periodStart, periodEnd, win, missing = null) {
  const series = priceData[pos.ticker];
  if (!series) return null;
  const baseline = getBaselinePriceForPosition(pos, periodStart, win);
  if (baseline == null) return null;

  const ccy     = currencyFor(pos);
  const fxBase  = getFXRate(ccy, baseline.date, missing);
  const divisor = baseline.price * fxBase;
  if (!(divisor > 0)) return null;   // never divide by zero — see the baseline resolver

  let dates = sortedDates(series).filter(d => d >= periodStart && withinWindow(d, win));
  if (periodEnd) dates = dates.filter(d => d < periodEnd);
  if (!dates.length) return null;    // delisted or not yet trading in this window

  return dates.map(d => ({
    date: d,
    ret: ((series[d] * getFXRate(ccy, d, missing)) - divisor) / divisor,
  }));
}

// Prices refresh hourly, so a freshly submitted ticker legitimately has no
// rows yet. Scoring that as a total loss would drop someone who entered
// correctly to -100% — retroactively across the whole window — until the next
// run of the fetcher. Inside this grace period an unknown ticker is treated as
// uninvested instead, and flagged in the UI. Beyond it the ticker is presumed
// wrong and the tournament's total-loss rule applies.
const PRICE_GRACE_MS = 24 * 60 * 60 * 1000;

function awaitingFirstPrices(period) {
  if (!period?.created_at) return false;
  const age = Date.now() - new Date(period.created_at).getTime();
  return age >= 0 && age < PRICE_GRACE_MS;
}

// A position is exactly one of:
//   cash     — deliberately no ticker; earns 0% but still occupies its weight
//   scored   — real price data in this window
//   awaiting — submitted within the grace period, prices not fetched yet;
//              scored 0% like cash until the grace period expires
//   dead     — unscoreable, and by tournament rule scored as a total loss
//              (unknown ticker, no prices in the window, or a settled market
//              whose baseline is 0). Previously these silently contributed 0%,
//              so a delisted holding looked like a harmless cash sleeve.
function classifyPosition(pos, periodStart, periodEnd, win, period = null, missing = null) {
  if (!pos.ticker) return { kind: "cash" };
  if (!priceData[pos.ticker]) {
    return awaitingFirstPrices(period)
      ? { kind: "awaiting", reason: "waiting for the next hourly price refresh" }
      : { kind: "dead", reason: "no price data for this ticker" };
  }
  const ret = getReturnSeries(pos, periodStart, periodEnd, win, missing);
  if (!ret) return { kind: "dead", reason: deadReason(pos, periodStart, periodEnd, win) };
  return { kind: "scored", ret };
}

// Why a position with a price series still can't be scored. Worth spelling out:
// Yahoo keeps displaying a delisted instrument's final trade as though it were
// live, so a bare "no usable price" invites the fair objection that the price
// is right there on the quote page.
function deadReason(pos, periodStart, periodEnd, win) {
  const series = priceData[pos.ticker];
  const inWindow = sortedDates(series)
    .filter(d => d >= periodStart && withinWindow(d, win) && (!periodEnd || d < periodEnd));

  if (!inWindow.length) {
    const last = sortedDates(series).at(-1);
    return last ? `stopped trading ${last}, before this round opened`
                : "no usable price in this tournament's window";
  }
  // Priced, but at zero for the whole window: an already-settled market.
  return `settled at $0 on ${inWindow[0]}, before this round opened`;
}

// Most recent point at or before `date`. Scanning forward and stopping matters:
// indexing the last element as a fallback let a position whose data starts late
// borrow a *future* return for earlier dates, quietly introducing lookahead.
function returnAsOf(ret, date) {
  let out = null;
  for (const r of ret) {
    if (r.date > date) break;
    out = r;
  }
  return out;
}

// Compounds returns across allocation periods: each period's weighted return
// is computed against its own start price, then chained onto the running
// value carried over from prior periods (equivalent to selling the old
// positions and buying the new ones at the switch-over date).
function computePortfolioReturn(participant, win, asOfDate = getToday()) {
  const dates = getDates(win);
  if (!dates.length) return { totalReturn: 0, series: [], dead: [] };

  // A completed tournament is scored as of its end_date, so its final
  // standings stop moving instead of drifting with every later price refresh.
  asOfDate = windowAsOf(win, asOfDate);

  const { current } = effectiveAllocation(participant, asOfDate);
  // Sorted ascending, tie-broken by created_at: if a participant resubmits
  // before their pending change takes effect (two rows sharing the same
  // effective_date), the later-created one is ordered last and — since its
  // periodEnd is the *next distinct* date — is the one that actually gets a
  // date range; the superseded row's range collapses to empty. This lets a
  // resubmission "replace" the prior one for display without needing to
  // update/delete the append-only allocations table.
  const periods = [...participant.allocations]
    .filter(a => a.effective_date <= asOfDate)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.created_at.localeCompare(b.created_at));

  const dead = [];
  const awaiting = [];
  const missingFX = new Set();
  let carryValue = 1;
  const series = [];

  periods.forEach((period, i) => {
    // An allocation carried over from before the window opens is still scored
    // from the window's own start, never from its original effective date.
    const periodStart = period.effective_date < win.start ? win.start : period.effective_date;
    const periodEnd   = periods[i + 1] ? periods[i + 1].effective_date : null;
    // Number(), not `|| 0`: a weight stored as the string "50" made `+` do
    // string concatenation, inflating totalWeight to 5050 and quietly
    // shrinking every penalty to a rounding error.
    const weightOf    = p => Number(p.weight) || 0;
    const totalWeight = period.positions.reduce((s, p) => s + weightOf(p), 0) || 100;

    const periodDates = dates.filter(d => d >= periodStart && (!periodEnd || d < periodEnd));
    // A resubmission on the same effective_date collapses the superseded row's
    // range to nothing. Such a row contributes no dates and so no return — and
    // it must contribute no *reporting* either. Classifying it would mark every
    // one of its positions dead (there are no prices inside an empty range) and
    // attribute another participant's discarded tickers to this one.
    if (!periodDates.length) return;

    const entries = period.positions.map(pos => ({
      pos,
      weight: weightOf(pos) / totalWeight,
      ...classifyPosition(pos, periodStart, periodEnd, win, period, missingFX),
    }));

    // Collected across every period that actually scored, not just the current
    // one. A dead position in an earlier period is baked permanently into
    // carryValue, so leaving it out meant a portfolio could carry a large
    // unexplained loss with an empty warning banner and all-green cards.
    // Deduped by ticker, tagged with the earliest period it hurt.
    const tag = period === current ? null : periodStart;
    entries.forEach(e => {
      const key = e.pos.ticker || e.pos.raw_name;
      if (e.kind === "dead" && !dead.some(d => (d.pos.ticker || d.pos.raw_name) === key)) {
        dead.push({ pos: e.pos, reason: e.reason, since: tag });
      }
      if (e.kind === "awaiting" && !awaiting.some(a => (a.pos.ticker || a.pos.raw_name) === key)) {
        awaiting.push({ pos: e.pos, reason: e.reason });
      }
    });

    let lastMultiplier = 1;
    periodDates.forEach(date => {
      let val = 0;
      for (const entry of entries) {
        if (entry.kind === "cash") continue;            // 0% return, weight still held
        if (entry.kind === "awaiting") continue;        // uninvested until prices arrive
        if (entry.kind === "dead") { val -= entry.weight; continue; }  // total loss
        const point = returnAsOf(entry.ret, date);
        if (point) val += entry.weight * point.ret;
      }
      lastMultiplier = 1 + val;
      series.push({ date, value: carryValue * lastMultiplier - 1 });
    });
    carryValue *= lastMultiplier;
  });

  return { totalReturn: series.at(-1)?.value ?? 0, series, dead, awaiting, missingFX: [...missingFX] };
}

function formatShortDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}`;
}

/* ─── leaderboard ────────────────────────────────────────────────────── */
function renderLeaderboard() {
  if (activeTournament) {
    document.getElementById("leaderboard-since").textContent = `Since ${formatShortDate(activeTournament.start_date)}`;
  }

  // Only rank people who have actually entered. Everyone else used to appear
  // as a phantom 0.00% row, which both padded the table and outranked anyone
  // genuinely down on the round. They stay on the Portfolios page and in the
  // Rebalance dropdown — removing them there would strand them permanently.
  const entered    = portfolios.filter(p => effectiveAllocation(p).current);
  const notEntered = portfolios.filter(p => !effectiveAllocation(p).current);

  const results = entered
    .map(p => {
      const { totalReturn, series, dead, awaiting } = computePortfolioReturn(p, activeWindow);
      return { p, totalReturn, series, dead, awaiting };
    })
    .sort((a, b) => b.totalReturn - a.totalReturn);

  const noteLines = [];
  if (notEntered.length) {
    noteLines.push(`${notEntered.length} of ${portfolios.length} haven't entered yet: ${notEntered.map(p => p.name).join(", ")}`);
  }
  if (results.some(r => r.dead.length)) {
    noteLines.push(`† includes a position scored as a total loss — open the row for detail`);
  }
  document.getElementById("leaderboard-note").textContent = noteLines.join(" · ");

  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";

  results.forEach(({ p, totalReturn, series, dead, awaiting }, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.classList.add("rank-1");
    const sign     = totalReturn >= 0 ? "+" : "";
    const retClass = totalReturn > 0 ? "return-pos" : totalReturn < 0 ? "return-neg" : "return-zero";
    const sparkId  = `spark-${p.id}`;

    // A loss caused by unscoreable data looks identical to a loss caused by
    // the market once it reaches the table, so mark it. Without this, a
    // position that genuinely fell 99.5% ranks *above* one that merely has no
    // prices, with nothing on the board to tell them apart.
    const flag = dead.length
      ? `<span class="return-flag" title="${escapeHtml(dead.map(d => `${d.pos.ticker || d.pos.raw_name}: ${d.reason}`).join("; "))}">†</span>`
      : awaiting.length
      ? `<span class="return-flag" title="Awaiting first price refresh">·</span>`
      : "";

    tr.innerHTML = `
      <td><span class="rank-num">${i + 1}</span></td>
      <td><span class="participant-name">${escapeHtml(p.name)}</span></td>
      <td><span class="return-val ${retClass}">${sign}${(totalReturn * 100).toFixed(2)}%</span>${flag}</td>
      <td class="sparkline-cell" id="${sparkId}"></td>
    `;
    tr.addEventListener("click", () => showDetail(p));
    tbody.appendChild(tr);
    requestAnimationFrame(() => renderSparklineSVG(document.getElementById(sparkId), series, totalReturn));
  });
}

function renderSparklineSVG(cell, series, totalReturn) {
  if (!cell || !series.length) return;
  const W = 140, H = 36, PAD = 3;
  const values = series.map(s => s.value);

  if (values.length === 1) {
    const c = totalReturn >= 0 ? '#5a7a5e' : '#b5564a';
    cell.innerHTML = `<svg width="${W}" height="${H}"><circle cx="${W/2}" cy="${H/2}" r="3" fill="${c}"/></svg>`;
    return;
  }

  const minV  = Math.min(...values);
  const maxV  = Math.max(...values);
  const range = maxV - minV || 0.0001;
  const pts   = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - minV) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const c = totalReturn >= 0 ? '#5a7a5e' : '#b5564a';
  cell.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5"
      stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* ─── detail page ────────────────────────────────────────────────────── */
function showDetail(participant, win = activeWindow) {
  destroyCharts();
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("page-detail").classList.add("active");
  document.getElementById("detail-name").textContent = participant.name;

  const { series, dead, awaiting, missingFX } = computePortfolioReturn(participant, win);

  const warn  = document.getElementById("detail-warning");
  const notes = [];
  if (dead.length) {
    const named = dead.map(d => {
      const when = d.since ? `, held from ${d.since}` : "";
      return `${d.pos.raw_name || d.pos.ticker || "unknown"} (${d.reason}${when})`;
    });
    notes.push(`${dead.length} position(s) scored as a total loss — ${named.join("; ")}`);
  }
  if (awaiting.length) {
    const named = awaiting.map(a => a.pos.ticker || a.pos.raw_name || "unknown");
    notes.push(`${awaiting.length} newly added position(s) not scored yet, awaiting the next hourly price refresh: ${named.join(", ")}`);
  }
  if (missingFX.length) {
    notes.push(`No FX rate yet for ${missingFX.join(", ")} — those holdings are shown at local-currency return until the next price refresh.`);
  }
  warn.style.display = notes.length ? "block" : "none";
  warn.textContent   = notes.join(" · ");

  requestAnimationFrame(() => {
    renderPortfolioChart(series);
    renderAllocationHistoryChart(participant, win);
    renderPositionCards(participant, win);
  });
}

function daysBetween(a, b) {
  return (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000;
}

function renderAllocationHistoryChart(participant, win = activeWindow) {
  const container = document.getElementById("chart-allocation-history");
  // Right edge of the timeline: today for a live round, the freeze date for a
  // completed one.
  const today = windowAsOf(win);
  const periods = [...participant.allocations]
    .filter(a => a.effective_date <= today)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.created_at.localeCompare(b.created_at));

  if (!periods.length) {
    container.innerHTML = `<p class="empty-state">No allocation history yet.</p>`;
    return;
  }

  const spans = periods.map((p, i) => ({
    start: p.effective_date < win.start ? win.start : p.effective_date,
    end: periods[i + 1] ? periods[i + 1].effective_date : today,
    positions: p.positions,
  }));

  // stable ticker/instrument -> color, assigned in first-seen order so a
  // given instrument keeps its color across the whole timeline
  const colorMap = {};
  let colorIdx = 0;
  spans.forEach(s => s.positions.forEach(pos => {
    const key = pos.ticker || pos.raw_name;
    if (!(key in colorMap)) colorMap[key] = COLORS[colorIdx++ % COLORS.length];
  }));

  const W = Math.max(container.clientWidth || 600, 300), H = 200, PAD_L = 4, PAD_B = 4;
  const totalDays = Math.max(daysBetween(spans[0].start, spans[spans.length - 1].end), 1);
  const xFor = d => PAD_L + (daysBetween(spans[0].start, d) / totalDays) * (W - PAD_L * 2);

  let rects = "";
  spans.forEach(s => {
    const x0 = xFor(s.start), x1 = Math.max(xFor(s.end), x0 + 1);
    const totalWeight = s.positions.reduce((sum, p) => sum + (p.weight || 0), 0) || 100;
    let yCursor = H - PAD_B;
    s.positions.forEach(pos => {
      const key = pos.ticker || pos.raw_name;
      const h = Math.max(((pos.weight || 0) / totalWeight) * (H - PAD_B * 2), 0);
      rects += `<rect x="${x0.toFixed(1)}" y="${(yCursor - h).toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${h.toFixed(1)}" fill="${colorMap[key]}" />`;
      yCursor -= h;
    });
  });

  const legend = Object.entries(colorMap).map(([key, color]) =>
    `<span class="alloc-legend-item"><span class="alloc-legend-swatch" style="background:${color}"></span>${escapeHtml(key)}</span>`
  ).join("");

  container.innerHTML = `
    <div class="chart-wrap alloc-history-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${rects}</svg>
    </div>
    <div class="alloc-legend">${legend}</div>
    <div class="alloc-history-dates">
      <span>${spans[0].start}</span><span>${today}</span>
    </div>
  `;
}

function addLeftPriceScale(chart) {
  chart.priceScale('left').applyOptions({
    visible: true,
    borderColor: '#d4cfc7',
    scaleMargins: { top: 0.1, bottom: 0.1 },
  });
}

function addPriceLine(chart, data, firstVal) {
  const minMove = firstVal < 10 ? 0.001 : 0.01;
  const series = chart.addSeries(LW.LineSeries, {
    priceScaleId: 'left',
    color: '#c4bfb6',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
    priceFormat: { type: 'price', precision: minMove === 0.001 ? 3 : 2, minMove },
  });
  series.setData(data);
}

function renderPortfolioChart(series) {
  const container = document.getElementById("chart-portfolio");
  container.innerHTML = "";
  if (!series.length) return;
  const chart = LW.createChart(container, CHART_BASE);
  lwCharts.push(chart);

  // left scale: indexed value (base 100)
  addLeftPriceScale(chart);
  addPriceLine(chart, series.map(s => ({ time: s.date, value: +(100 * (1 + s.value)).toFixed(2) })), 100);

  // right scale: % return baseline
  const baseline = chart.addSeries(LW.BaselineSeries, { ...BASELINE_DEFAULTS, priceScaleId: 'right' });
  baseline.setData(series.map(s => ({ time: s.date, value: +(s.value * 100).toFixed(4) })));
  chart.timeScale().fitContent();
}

function renderPositionCards(participant, win = activeWindow) {
  const section = document.getElementById("positions-section");
  const { current, pending } = effectiveAllocation(participant, windowAsOf(win));

  if (!current) {
    section.innerHTML = `<p class="empty-state">No allocation submitted yet.</p>`;
    return;
  }

  section.innerHTML = `
    <div class="chart-block">
      <h2>Positions</h2>
      <div class="positions-grid" id="positions-grid"></div>
    </div>
    ${pending ? `
    <div class="chart-block pending-block">
      <h2>Next week (pending) — effective ${pending.effective_date}</h2>
      <div class="positions-grid" id="positions-grid-pending"></div>
    </div>` : ""}
  `;
  renderPositionCardGrid("positions-grid", current, win);
  // `scored: false` — a pending allocation hasn't started yet, so there is no
  // return to show. Scoring it would mark every position a total loss, since
  // by definition no prices exist on or after its future effective date.
  if (pending) renderPositionCardGrid("positions-grid-pending", pending, win, false);
}

const NO_RETURN_LABEL = { pending: "not started", awaiting: "awaiting prices", cash: "cash" };

function renderPositionCardGrid(gridId, allocation, win = activeWindow, scored = true) {
  const grid = document.getElementById(gridId);
  const periodStart = allocation.effective_date;
  const start = periodStart < win.start ? win.start : periodStart;

  allocation.positions.forEach((pos, i) => {
    const state     = scored ? classifyPosition(pos, start, null, win, allocation) : { kind: "pending" };
    const totalRet  = state.kind === "scored" ? state.ret.at(-1).ret
                    : state.kind === "dead"   ? -1
                    : null;
    const color     = COLORS[i % COLORS.length];
    const chartId   = `${gridId}-chart-${i}`;
    const url       = getPositionUrl(pos);

    // A dead position reads -100%, matching how it's scored on the leaderboard,
    // rather than the old "no data" label that hid the cost entirely.
    const retLabel = totalRet === null
      ? `<span class="position-return" style="color:#9a9186" ${state.reason ? `title="${escapeHtml(state.reason)}"` : ""}>${NO_RETURN_LABEL[state.kind] ?? "cash"}</span>`
      : `<span class="position-return ${totalRet >= 0 ? "return-pos" : "return-neg"}" ${state.kind === "dead" ? `title="${escapeHtml(state.reason)}"` : ""}>${totalRet >= 0 ? "+" : ""}${(totalRet * 100).toFixed(2)}%</span>`;

    const card = document.createElement("div");
    card.className = "position-card";
    const label = escapeHtml(pos.ticker ?? pos.raw_name);
    card.innerHTML = `
      <div class="position-card-header">
        <div>
          ${url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="position-ticker-link"><span class="position-ticker">${label}</span></a>`
            : `<span class="position-ticker">${label}</span>`}
          ${pos.ticker ? `<div class="position-name">${escapeHtml(pos.raw_name)}</div>` : ""}
        </div>
        <span class="position-meta">${escapeHtml(pos.weight)}% · ${escapeHtml(pos.type)}</span>
        ${retLabel}
      </div>
      <div class="chart-wrap pos-chart-wrap" id="${chartId}"></div>
      ${pos.notes ? `<p class="td-notes" style="padding:var(--space-sm) var(--space-sm) 0">${escapeHtml(pos.notes)}</p>` : ""}
    `;
    grid.appendChild(card);

    const rawPrices = pos.ticker ? getPriceSeries(pos.ticker, win) : null;
    if (rawPrices?.length) {
      requestAnimationFrame(() => {
        const el = document.getElementById(chartId);
        if (!el) return;
        const firstPrice = rawPrices[0].value;
        const priceFormatter = firstPrice < 2
          ? p => `${(p * 100).toFixed(1)}¢`
          : p => p.toFixed(firstPrice < 10 ? 3 : 2);
        const chart = LW.createChart(el, {
          ...CHART_BASE,
          localization: { priceFormatter },
        });
        lwCharts.push(chart);
        const area = chart.addSeries(LW.AreaSeries, {
          lineColor:   color,
          topColor:    color + "38",
          bottomColor: color + "06",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });
        area.setData(rawPrices);
        chart.timeScale().fitContent();
      });
    }
  });
}

/* ─── portfolios page ────────────────────────────────────────────────── */
function renderPortfolios() {
  const grid = document.getElementById("portfolios-grid");
  grid.innerHTML = "";

  portfolios.forEach(p => {
    const { current, pending } = effectiveAllocation(p);
    const card = document.createElement("div");
    card.className = "portfolio-card";

    card.innerHTML = `
      <div class="portfolio-card-header">
        <h2>${escapeHtml(p.name)}</h2>
      </div>
      ${current ? renderAllocationTable(current.positions) : `<p class="empty-state">No allocation submitted yet.</p>`}
      ${pending ? `
        <div class="pending-allocation">
          <h3 class="pending-label">Pending — effective Mon ${pending.effective_date}</h3>
          ${renderAllocationTable(pending.positions)}
        </div>` : ""}
    `;
    grid.appendChild(card);
  });
}

function renderAllocationTable(positions) {
  const totalWeight = positions.reduce((s, pos) => s + (pos.weight || 0), 0);
  const weightOk    = Math.abs(totalWeight - 100) < 0.01;
  return `
    ${!weightOk ? `<span class="portfolio-weight-warn">weights sum to ${totalWeight.toFixed(1)}%</span>` : ""}
    <table class="portfolio-table">
      <thead><tr>
        <th>Asset</th><th>Ticker</th><th>Type</th><th>Ccy</th>
        <th style="text-align:right">Weight</th><th class="weight-bar-cell"></th><th>Notes</th>
      </tr></thead>
      <tbody>
        ${positions.map(pos => `
          <tr>
            <td>${escapeHtml(pos.raw_name)}</td>
            <td class="td-ticker">${pos.ticker
              ? `<a href="${escapeHtml(getPositionUrl(pos))}" target="_blank" rel="noopener noreferrer" class="ticker-link">${escapeHtml(pos.ticker)}</a>`
              : "—"}</td>
            <td>${escapeHtml(pos.type)}</td>
            <td class="td-ticker">${escapeHtml(currencyFor(pos))}</td>
            <td class="td-weight">${escapeHtml(pos.weight)}%</td>
            <td class="weight-bar-cell">
              <div class="weight-bar-wrap">
                <div class="weight-bar-fill" style="width:${Math.min(Number(pos.weight) || 0, 100)}%"></div>
              </div>
            </td>
            <td class="td-notes">${escapeHtml(pos.notes || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

/* ─── tournament history page ────────────────────────────────────────── */
function renderHistory() {
  const list = document.getElementById("history-list");

  if (!historyTournaments.length) {
    list.innerHTML = `<p class="empty-state">No past tournaments yet.</p>`;
    return;
  }

  list.innerHTML = historyTournaments.map(t => {
    const win = windowFor(t);
    const results = t.portfolios
      .map(p => ({ p, ...computePortfolioReturn(p, win) }))
      .sort((a, b) => b.totalReturn - a.totalReturn);

    const span = win.end
      ? `${escapeHtml(t.start_date)} → ${escapeHtml(win.end)} · final`
      : `started ${escapeHtml(t.start_date)}`;

    return `
      <div class="history-tournament">
        <div class="history-tournament-header">
          <h2>${escapeHtml(t.name)}</h2>
          <span class="subtitle">${span}</span>
        </div>
        <table class="leaderboard-table">
          <thead><tr>
            <th class="col-rank">#</th><th class="col-name">Participant</th><th class="col-return">Total Return</th>
          </tr></thead>
          <tbody>
            ${results.map(({ p, totalReturn }, i) => {
              const sign     = totalReturn >= 0 ? "+" : "";
              const retClass = totalReturn > 0 ? "return-pos" : totalReturn < 0 ? "return-neg" : "return-zero";
              return `
                <tr class="${i === 0 ? "rank-1" : ""}">
                  <td><span class="rank-num">${i + 1}</span></td>
                  <td><span class="participant-name">${escapeHtml(p.name)}</span></td>
                  <td><span class="return-val ${retClass}">${sign}${(totalReturn * 100).toFixed(2)}%</span></td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
        <div class="history-portfolios">
          ${results.map(({ p }) => {
            const { current } = effectiveAllocation(p, windowAsOf(win));
            return `
              <div class="portfolio-card">
                <div class="portfolio-card-header"><h2>${escapeHtml(p.name)}</h2></div>
                ${current ? renderAllocationTable(current.positions) : `<p class="empty-state">No allocation recorded.</p>`}
              </div>`;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
}

/* ─── rebalance page ─────────────────────────────────────────────────── */
let rebalanceParticipantId = null;
let rebalanceDraft = [];

function setupRebalancePage() {
  const select = document.getElementById("rebalance-participant");
  select.innerHTML = portfolios.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  select.addEventListener("change", () => loadRebalanceParticipant(select.value));

  document.getElementById("rebalance-add-row").addEventListener("click", () => {
    rebalanceDraft.push({ raw_name: "", ticker: "", type: "Equity", exchange: "", currency: "USD", weight: 0, notes: "" });
    renderRebalanceTable();
  });

  document.getElementById("rebalance-generate").addEventListener("click", submitRebalance);

  document.getElementById("rebalance-tbody").addEventListener("input", e => {
    const input = e.target.closest("input[data-field]");
    if (!input) return;
    const i = +input.dataset.index;
    const field = input.dataset.field;
    rebalanceDraft[i][field] = field === "weight" ? (parseFloat(input.value) || 0) : input.value;
    updateWeightSum();
  });

  document.getElementById("rebalance-tbody").addEventListener("click", e => {
    const btn = e.target.closest(".rebalance-row-remove");
    if (!btn) return;
    rebalanceDraft.splice(+btn.dataset.index, 1);
    renderRebalanceTable();
  });

  setupTickerSearch();

  if (portfolios.length) loadRebalanceParticipant(select.value);
}

/* ─── ticker search (Supabase Edge Function proxy) ───────────────────── */
let tickerSearchTimer = null;

// Yahoo exchange code -> trading currency, for picks made through the search
// box. Anything not listed here used to fall through to USD, which is how a
// basket of Swiss, Israeli and London holdings ended up priced as dollars.
// currencyFor() also infers from the ticker suffix, so this is belt-and-braces
// for instruments whose suffix we don't recognise.
const EXCHANGE_CURRENCY = {
  IST: "TRY",             // Istanbul / BIST
  KSC: "KRW", KOE: "KRW", // Korea Exchange
  MIL: "EUR",             // Borsa Italiana / Milan
  EBS: "CHF", VTX: "CHF", // SIX Swiss / Virt-X
  TLV: "ILA",             // Tel Aviv (quotes in agorot, 1/100 shekel)
  LSE: "GBp",             // London (usually pence — but see tickerCurrency)
  AMS: "EUR", PAR: "EUR", GER: "EUR", FRA: "EUR", MCE: "EUR", BRU: "EUR",
  STO: "SEK", OSL: "NOK", CPH: "DKK",
  TOR: "CAD", ASX: "AUD", NSI: "INR", SAO: "BRL",
  HKG: "HKD", JPX: "JPY",
};

const SEARCHABLE_FIELDS = 'input[data-field="ticker"], input[data-field="raw_name"]';

function setupTickerSearch() {
  const tbody = document.getElementById("rebalance-tbody");
  tbody.addEventListener("input", e => {
    const input = e.target.closest(SEARCHABLE_FIELDS);
    if (!input) return;
    const i = +input.dataset.index;
    clearTimeout(tickerSearchTimer);
    const value = input.value.trim();
    if (value.length < 2) { hideTickerSuggestions(); return; }
    tickerSearchTimer = setTimeout(() => runTickerSearch(i, input, value), 300);
  });

  document.addEventListener("click", e => {
    if (!e.target.closest(".ticker-suggestions") && !e.target.closest(SEARCHABLE_FIELDS)) {
      hideTickerSuggestions();
    }
  });
}

async function runTickerSearch(rowIndex, inputEl, value) {
  const polyMatch = value.match(/polymarket\.com\/event\/([a-z0-9-]+)/i);
  try {
    if (polyMatch) {
      const data = await marketLookup(`action=polymarket&slug=${encodeURIComponent(polyMatch[1])}`);
      showPolymarketSuggestions(rowIndex, inputEl, data);
    } else {
      const data = await marketLookup(`action=search&q=${encodeURIComponent(value)}`);
      showTickerSuggestions(rowIndex, inputEl, data);
    }
  } catch (e) {
    console.error(e);
    hideTickerSuggestions();
  }
}

async function marketLookup(query) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/market-lookup?${query}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`market-lookup failed: ${res.status}`);
  return res.json();
}

function getSuggestionsBox() {
  return document.getElementById("ticker-suggestions");
}

function positionSuggestionsBox(inputEl) {
  const box = getSuggestionsBox();
  const rect = inputEl.getBoundingClientRect();
  box.style.left = `${window.scrollX + rect.left}px`;
  box.style.top = `${window.scrollY + rect.bottom + 2}px`;
  box.style.width = `${Math.max(rect.width, 240)}px`;
  box.style.display = "block";
}

function hideTickerSuggestions() {
  const box = getSuggestionsBox();
  box.style.display = "none";
  box.innerHTML = "";
}

function showTickerSuggestions(rowIndex, inputEl, data) {
  const box = getSuggestionsBox();
  if (!data.length) {
    box.innerHTML = `<div class="ticker-suggestion-empty">No matches</div>`;
  } else {
    box.innerHTML = data.map((q, i) => `
      <div class="ticker-suggestion" data-i="${i}">
        <strong>${escapeHtml(q.symbol)}</strong> ${escapeHtml(q.name || "")}
        <span class="ticker-suggestion-meta">${escapeHtml(q.exchDisp || q.exchange || "")}</span>
      </div>
    `).join("");
    box.querySelectorAll(".ticker-suggestion").forEach(el => {
      el.addEventListener("click", () => {
        const q = data[+el.dataset.i];
        applyTickerSelection(rowIndex, {
          ticker: q.symbol,
          raw_name: q.name || q.symbol,
          exchange: q.exchDisp || q.exchange || "",
          currency: EXCHANGE_CURRENCY[q.exchange] || "USD",
          type: q.quoteType === "ETF" ? "ETF" : "Equity",
        });
        hideTickerSuggestions();
      });
    });
  }
  positionSuggestionsBox(inputEl);
}

function showPolymarketSuggestions(rowIndex, inputEl, data) {
  const box = getSuggestionsBox();
  // A settled market prices its outcomes at exactly 0 or 1. Offering those was
  // the root of the worst scoring bug in the app: picking one stored
  // `baseline_price: 0`, which the return math then divided by.
  const live = (data.outcomes ?? []).filter(o => Number(o.price) > 0 && Number(o.price) < 1);

  if (!data.outcomes?.length) {
    box.innerHTML = `<div class="ticker-suggestion-empty">No outcomes found for this market</div>`;
  } else if (!live.length) {
    box.innerHTML = `<div class="ticker-suggestion-empty">This market has already settled — pick one that's still trading</div>`;
  } else {
    box.innerHTML = live.map((o, i) => `
      <div class="ticker-suggestion" data-i="${i}">
        <strong>${escapeHtml(o.label)}</strong>
        <span class="ticker-suggestion-meta">$${Number(o.price).toFixed(3)}</span>
      </div>
    `).join("");
    box.querySelectorAll(".ticker-suggestion").forEach(el => {
      el.addEventListener("click", () => {
        const o = live[+el.dataset.i];
        applyTickerSelection(rowIndex, {
          ticker: `POLY:${data.slug}:${o.label.toUpperCase()}`,
          raw_name: data.question || data.slug,
          exchange: "polymarket",
          currency: "USD",
          type: "Prediction",
          baseline_price: o.price,
        });
        hideTickerSuggestions();
      });
    });
  }
  positionSuggestionsBox(inputEl);
}

function applyTickerSelection(rowIndex, fields) {
  Object.assign(rebalanceDraft[rowIndex], fields);
  renderRebalanceTable();
}

function loadRebalanceParticipant(id) {
  rebalanceParticipantId = id;
  const participant = portfolios.find(p => p.id === id);
  const { current, pending } = effectiveAllocation(participant);
  const source = pending ?? current;
  rebalanceDraft = source ? JSON.parse(JSON.stringify(source.positions)) : [];

  const hint = document.getElementById("rebalance-hint");
  hint.textContent = pending
    ? `Editing your existing pending change (effective ${pending.effective_date}) — generating will replace it.`
    : current
    ? `Starting from your current allocation (effective ${current.effective_date}).`
    : `No allocation yet — this will be your first submission, effective ${activeTournament.start_date}.`;

  document.getElementById("rebalance-output-block").style.display = "none";
  renderRebalanceTable();
}

function renderRebalanceTable() {
  const tbody = document.getElementById("rebalance-tbody");
  tbody.innerHTML = rebalanceDraft.map((pos, i) => `
    <tr>
      <td><input data-index="${i}" data-field="raw_name" placeholder="search name or ticker…" value="${escapeHtml(pos.raw_name ?? "")}"></td>
      <td><input data-index="${i}" data-field="ticker" placeholder="search name or ticker…" value="${escapeHtml(pos.ticker ?? "")}"></td>
      <td><input data-index="${i}" data-field="type" value="${escapeHtml(pos.type ?? "")}"></td>
      <td><input data-index="${i}" data-field="exchange" value="${escapeHtml(pos.exchange ?? "")}"></td>
      <td><input data-index="${i}" data-field="currency" value="${escapeHtml(pos.currency ?? "")}"></td>
      <td><input data-index="${i}" data-field="weight" type="number" step="0.01" min="0" value="${escapeHtml(pos.weight ?? 0)}"></td>
      <td><input data-index="${i}" data-field="notes" value="${escapeHtml(pos.notes ?? "")}"></td>
      <td><button class="rebalance-row-remove" data-index="${i}" type="button" title="Remove">✕</button></td>
    </tr>
  `).join("");
  updateWeightSum();
}

function updateWeightSum() {
  const el = document.getElementById("rebalance-weight-sum");
  const total = rebalanceDraft.reduce((s, p) => s + (parseFloat(p.weight) || 0), 0);
  const ok = Math.abs(total - 100) < 0.5;
  el.textContent = `weights sum to ${total.toFixed(1)}%`;
  el.className = `rebalance-weight-sum ${ok ? "weight-ok" : "weight-bad"}`;
  return ok;
}

// Prediction-market tickers must be the exact POLY:<slug>:<OUTCOME> shape the
// price fetcher understands. A hand-typed label like "Poly Ben Shelton:Yes"
// looks plausible in the form but is fetched as if it were a stock symbol,
// finds nothing, and now costs its full weight as a total loss.
const POLY_TICKER_RE = /^POLY:[^:]+:[^:]+$/;

async function submitRebalance() {
  const ok = updateWeightSum();
  if (!rebalanceDraft.length) { alert("Add at least one position."); return; }
  if (rebalanceDraft.some(p => !p.raw_name?.trim())) { alert("Every position needs a name."); return; }
  if (!ok) { alert("Weights must sum to 100% (± 0.5) before submitting."); return; }

  // A negative weight is a short, which this tournament doesn't model — and it
  // breaks the -100% floor outright: -50/+150 against an unscoreable position
  // scores -160%, and a negative-weight dead position *profits* from being
  // unscoreable. The sum check alone can't catch it, since -50 and +150 sum
  // to 100 perfectly well.
  if (rebalanceDraft.some(p => (Number(p.weight) || 0) < 0)) {
    alert("Weights can't be negative — this tournament is long-only.");
    return;
  }

  const badPoly = rebalanceDraft.find(p => {
    const t = (p.ticker || "").trim();
    return /poly/i.test(t) && !POLY_TICKER_RE.test(t);
  });
  if (badPoly) {
    alert(`"${badPoly.ticker}" isn't a valid Polymarket ticker.\n\nPaste the market's polymarket.com/event/… URL into the ticker box and pick an outcome from the dropdown instead of typing it by hand.`);
    return;
  }

  // Unknown tickers are scored as a total loss, so a typo is expensive. A
  // genuinely new ticker won't have prices until the next hourly refresh,
  // which is why this confirms rather than blocks.
  const unknown = rebalanceDraft.filter(p => p.ticker?.trim() && !priceData[p.ticker.trim()]);
  if (unknown.length) {
    const list = unknown.map(p => p.ticker.trim()).join(", ");
    if (!confirm(`No price history found for: ${list}\n\nIf these are new they'll fill in at the next hourly refresh. If a ticker is wrong it will be scored as a total loss (-100%) for its full weight.\n\nSubmit anyway?`)) return;
  }

  const participantForSubmit = portfolios.find(p => p.id === rebalanceParticipantId);
  const { current } = effectiveAllocation(participantForSubmit);
  // a participant's very first allocation in the active tournament always
  // starts on the tournament's shared start date, no matter when they submit
  const effectiveDate = current ? nextWeekMonday() : activeTournament.start_date;
  const positions = rebalanceDraft.map(p => {
    const pos = {
      raw_name: p.raw_name.trim(),
      type: p.type || "Equity",
      exchange: p.exchange || "",
      currency: p.currency || "USD",
      weight: parseFloat(p.weight) || 0,
      notes: p.notes || "",
    };
    if (p.ticker?.trim()) pos.ticker = p.ticker.trim();
    if (p.coingecko_id) pos.coingecko_id = p.coingecko_id;
    if (p.baseline_price != null) pos.baseline_price = p.baseline_price;
    return pos;
  });

  const btn = document.getElementById("rebalance-generate");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Submitting…";

  try {
    await supabaseRequest("allocations", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        tournament_id: activeTournament.id,
        participant_id: rebalanceParticipantId,
        effective_date: effectiveDate,
        positions,
      },
    });

    // reflect the new pending allocation everywhere immediately
    await loadData();
    loadRebalanceParticipant(rebalanceParticipantId);

    document.getElementById("rebalance-instructions").textContent =
      `Staged for ${participantForSubmit.name} — effective Mon ${effectiveDate}. It takes effect automatically at the start of that week.`;
    document.getElementById("rebalance-output-block").style.display = "block";
  } catch (e) {
    console.error(e);
    alert(`Could not submit rebalance: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

/* ─── cleanup ────────────────────────────────────────────────────────── */
function destroyCharts() {
  lwCharts.forEach(c => { try { c.remove(); } catch (_) {} });
  lwCharts = [];
}

/* ─── go ─────────────────────────────────────────────────────────────── */
init();
