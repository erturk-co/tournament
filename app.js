/* ─── config ─────────────────────────────────────────────────────────── */
const START_DATE = "2026-06-02";
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

/* ─── init ───────────────────────────────────────────────────────────── */
async function loadData() {
  const [tournamentRows, participantRows, allocRows, metaRows, priceRows] = await Promise.all([
    supabaseRequest("tournaments?select=id,name,start_date,status"),
    supabaseRequest("participants?select=id,name"),
    supabaseRequest("allocations?select=tournament_id,participant_id,effective_date,positions&order=effective_date.asc"),
    supabaseRequest("meta?select=fetched_at,base_currency"),
    supabaseRequest("prices?select=ticker,date,price"),
  ]);

  activeTournament = tournamentRows.find(t => t.status === "active") ?? null;

  const portfoliosFor = (tournamentId) => participantRows.map(p => ({
    ...p,
    allocations: allocRows
      .filter(a => a.tournament_id === tournamentId && a.participant_id === p.id)
      .map(a => ({ effective_date: a.effective_date, positions: a.positions })),
  }));

  portfolios = activeTournament ? portfoliosFor(activeTournament.id) : [];

  historyTournaments = tournamentRows
    .filter(t => t.status !== "active")
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .map(t => ({ ...t, portfolios: portfoliosFor(t.id) }));

  priceData = {};
  priceRows.forEach(({ ticker, date, price }) => {
    (priceData[ticker] ??= {})[date] = price;
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
    a.effective_date.localeCompare(b.effective_date));
  let current = sorted[0] ?? null;
  let pending = null;
  for (const a of sorted) {
    if (a.effective_date <= asOfDate) current = a;
    else { pending = a; break; }
  }
  return { current, pending };
}

function getBaselinePriceForPosition(pos, periodStart) {
  if (pos.baseline_price != null) return pos.baseline_price;
  const series = priceData[pos.ticker];
  if (!series) return null;
  const dates = Object.keys(series).filter(d => d >= periodStart).sort();
  return dates.length ? series[dates[0]] : null;
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
function getDates() {
  const all = new Set();
  Object.values(priceData).forEach(s => Object.keys(s).forEach(d => all.add(d)));
  return [...all].filter(d => d >= START_DATE).sort();
}

function getFXRate(ccy, date) {
  if (!ccy || ccy === BASE_CURRENCY) return 1;
  const series = priceData[`${ccy}USD=X`];
  if (!series) return 1;
  const closest = Object.keys(series).sort().filter(d => d <= date).pop();
  return closest ? series[closest] : 1;
}

function getPositionUrl(pos) {
  const t = pos.ticker;
  if (!t) return null;
  if (t.startsWith("POLY:")) return `https://polymarket.com/event/${t.split(":")[1]}`;
  if (pos.coingecko_id)       return `https://www.coingecko.com/en/coins/${pos.coingecko_id}`;
  return `https://finance.yahoo.com/quote/${encodeURIComponent(t)}`;
}

function getPriceSeries(ticker) {
  const series = priceData[ticker];
  if (!series) return null;
  return Object.keys(series).filter(d => d >= START_DATE).sort()
    .map(d => ({ time: d, value: series[d] }));
}

function getReturnSeries(pos, periodStart, periodEnd = null) {
  const series = priceData[pos.ticker];
  if (!series) return null;
  const baseline = getBaselinePriceForPosition(pos, periodStart);
  if (baseline == null) return null;
  const fxBase = getFXRate(pos.currency, periodStart);
  let dates = Object.keys(series).filter(d => d >= periodStart).sort();
  if (periodEnd) dates = dates.filter(d => d < periodEnd);
  return dates.map(d => {
    const fxNow = getFXRate(pos.currency, d);
    const ret = ((series[d] * fxNow) - (baseline * fxBase)) / (baseline * fxBase);
    return { date: d, ret };
  });
}

// Compounds returns across allocation periods: each period's weighted return
// is computed against its own start price, then chained onto the running
// value carried over from prior periods (equivalent to selling the old
// positions and buying the new ones at the switch-over date).
function computePortfolioReturn(participant, asOfDate = getToday()) {
  const dates = getDates();
  if (!dates.length) return { totalReturn: 0, series: [], unresolved: [] };

  const { current } = effectiveAllocation(participant, asOfDate);
  const periods = [...participant.allocations]
    .filter(a => a.effective_date <= asOfDate)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date));

  let unresolved = [];
  let carryValue = 1;
  const series = [];

  periods.forEach((period, i) => {
    const periodStart = period.effective_date;
    const periodEnd   = periods[i + 1] ? periods[i + 1].effective_date : null;
    const totalWeight = period.positions.reduce((s, p) => s + (p.weight || 0), 0);
    const resolved    = period.positions.filter(p => p.ticker && priceData[p.ticker]);
    if (period === current) {
      unresolved = period.positions.filter(p => !p.ticker || !priceData[p.ticker]);
    }

    const posSeries = resolved.map(pos => ({
      weight: (pos.weight || 0) / (totalWeight || 100),
      ret: getReturnSeries(pos, periodStart, periodEnd) ?? [],
    }));

    const periodDates = dates.filter(d => d >= periodStart && (!periodEnd || d < periodEnd));
    let lastMultiplier = 1;
    periodDates.forEach(date => {
      let val = 0;
      for (const { weight, ret } of posSeries) {
        const entry = ret.find(r => r.date === date) ?? ret[ret.length - 1];
        if (entry) val += weight * entry.ret;
      }
      lastMultiplier = 1 + val;
      series.push({ date, value: carryValue * lastMultiplier - 1 });
    });
    carryValue *= lastMultiplier;
  });

  return { totalReturn: series.at(-1)?.value ?? 0, series, unresolved };
}

/* ─── leaderboard ────────────────────────────────────────────────────── */
function renderLeaderboard() {
  const results = portfolios
    .map(p => { const { totalReturn, series } = computePortfolioReturn(p); return { p, totalReturn, series }; })
    .sort((a, b) => b.totalReturn - a.totalReturn);

  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";

  results.forEach(({ p, totalReturn, series }, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.classList.add("rank-1");
    const sign     = totalReturn >= 0 ? "+" : "";
    const retClass = totalReturn > 0 ? "return-pos" : totalReturn < 0 ? "return-neg" : "return-zero";
    const sparkId  = `spark-${p.id}`;

    tr.innerHTML = `
      <td><span class="rank-num">${i + 1}</span></td>
      <td><span class="participant-name">${p.name}</span></td>
      <td><span class="return-val ${retClass}">${sign}${(totalReturn * 100).toFixed(2)}%</span></td>
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
function showDetail(participant) {
  destroyCharts();
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("page-detail").classList.add("active");
  document.getElementById("detail-name").textContent = participant.name;

  const { series, unresolved } = computePortfolioReturn(participant);

  const warn = document.getElementById("detail-warning");
  if (unresolved.length) {
    warn.style.display = "block";
    warn.textContent = `${unresolved.length} position(s) excluded from returns: ${unresolved.map(p => p.raw_name || p.ticker || "unknown").join(", ")}`;
  } else {
    warn.style.display = "none";
  }

  requestAnimationFrame(() => {
    renderPortfolioChart(series);
    renderAllocationHistoryChart(participant);
    renderPositionCards(participant);
  });
}

function daysBetween(a, b) {
  return (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000;
}

function renderAllocationHistoryChart(participant) {
  const container = document.getElementById("chart-allocation-history");
  const today = getToday();
  const periods = [...participant.allocations]
    .filter(a => a.effective_date <= today)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date));

  if (!periods.length) {
    container.innerHTML = `<p class="empty-state">No allocation history yet.</p>`;
    return;
  }

  const spans = periods.map((p, i) => ({
    start: p.effective_date,
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
    `<span class="alloc-legend-item"><span class="alloc-legend-swatch" style="background:${color}"></span>${key}</span>`
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

function renderPositionCards(participant) {
  const section = document.getElementById("positions-section");
  const { current, pending } = effectiveAllocation(participant);

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
  renderPositionCardGrid("positions-grid", current.positions, current.effective_date);
  if (pending) renderPositionCardGrid("positions-grid-pending", pending.positions, pending.effective_date);
}

function renderPositionCardGrid(gridId, positions, periodStart) {
  const grid = document.getElementById(gridId);

  positions.forEach((pos, i) => {
    const retSeries = pos.ticker ? getReturnSeries(pos, periodStart) : null;
    const totalRet  = retSeries?.at(-1)?.ret ?? null;
    const color     = COLORS[i % COLORS.length];
    const chartId   = `${gridId}-chart-${i}`;
    const url       = getPositionUrl(pos);

    const retLabel = totalRet === null
      ? `<span class="position-return" style="color:#9a9186">no data</span>`
      : `<span class="position-return ${totalRet >= 0 ? "return-pos" : "return-neg"}">${totalRet >= 0 ? "+" : ""}${(totalRet * 100).toFixed(2)}%</span>`;

    const card = document.createElement("div");
    card.className = "position-card";
    card.innerHTML = `
      <div class="position-card-header">
        <div>
          ${url
            ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="position-ticker-link"><span class="position-ticker">${pos.ticker ?? pos.raw_name}</span></a>`
            : `<span class="position-ticker">${pos.ticker ?? pos.raw_name}</span>`}
          ${pos.ticker ? `<div class="position-name">${pos.raw_name}</div>` : ""}
        </div>
        <span class="position-meta">${pos.weight}% · ${pos.type}</span>
        ${retLabel}
      </div>
      <div class="chart-wrap pos-chart-wrap" id="${chartId}"></div>
      ${pos.notes ? `<p class="td-notes" style="padding:var(--space-sm) var(--space-sm) 0">${pos.notes}</p>` : ""}
    `;
    grid.appendChild(card);

    const rawPrices = pos.ticker ? getPriceSeries(pos.ticker) : null;
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
        <h2>${p.name}</h2>
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
            <td>${pos.raw_name}</td>
            <td class="td-ticker">${pos.ticker
              ? `<a href="${getPositionUrl(pos)}" target="_blank" rel="noopener noreferrer" class="ticker-link">${pos.ticker}</a>`
              : "—"}</td>
            <td>${pos.type}</td>
            <td class="td-ticker">${pos.currency}</td>
            <td class="td-weight">${pos.weight}%</td>
            <td class="weight-bar-cell">
              <div class="weight-bar-wrap">
                <div class="weight-bar-fill" style="width:${Math.min(pos.weight, 100)}%"></div>
              </div>
            </td>
            <td class="td-notes">${pos.notes || ""}</td>
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
    const results = t.portfolios
      .map(p => ({ p, ...computePortfolioReturn(p) }))
      .sort((a, b) => b.totalReturn - a.totalReturn);

    return `
      <div class="history-tournament">
        <div class="history-tournament-header">
          <h2>${t.name}</h2>
          <span class="subtitle">started ${t.start_date}</span>
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
                  <td><span class="participant-name">${p.name}</span></td>
                  <td><span class="return-val ${retClass}">${sign}${(totalReturn * 100).toFixed(2)}%</span></td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
        <div class="history-portfolios">
          ${results.map(({ p }) => {
            const { current } = effectiveAllocation(p);
            return `
              <div class="portfolio-card">
                <div class="portfolio-card-header"><h2>${p.name}</h2></div>
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
  select.innerHTML = portfolios.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
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

const EXCHANGE_CURRENCY = {
  IST: "TRY",          // Istanbul / BIST
  KSC: "KRW", KOE: "KRW", // Korea Exchange
  MIL: "EUR",           // Borsa Italiana / Milan
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
        <strong>${q.symbol}</strong> ${q.name || ""}
        <span class="ticker-suggestion-meta">${q.exchDisp || q.exchange || ""}</span>
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
  if (!data.outcomes?.length) {
    box.innerHTML = `<div class="ticker-suggestion-empty">No outcomes found for this market</div>`;
  } else {
    box.innerHTML = data.outcomes.map((o, i) => `
      <div class="ticker-suggestion" data-i="${i}">
        <strong>${o.label}</strong>
        <span class="ticker-suggestion-meta">$${o.price.toFixed(3)}</span>
      </div>
    `).join("");
    box.querySelectorAll(".ticker-suggestion").forEach(el => {
      el.addEventListener("click", () => {
        const o = data.outcomes[+el.dataset.i];
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
      <td><input data-index="${i}" data-field="raw_name" placeholder="search name or ticker…" value="${pos.raw_name ?? ""}"></td>
      <td><input data-index="${i}" data-field="ticker" placeholder="search name or ticker…" value="${pos.ticker ?? ""}"></td>
      <td><input data-index="${i}" data-field="type" value="${pos.type ?? ""}"></td>
      <td><input data-index="${i}" data-field="exchange" value="${pos.exchange ?? ""}"></td>
      <td><input data-index="${i}" data-field="currency" value="${pos.currency ?? ""}"></td>
      <td><input data-index="${i}" data-field="weight" type="number" step="0.01" value="${pos.weight ?? 0}"></td>
      <td><input data-index="${i}" data-field="notes" value="${pos.notes ?? ""}"></td>
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

async function submitRebalance() {
  const ok = updateWeightSum();
  if (!rebalanceDraft.length) { alert("Add at least one position."); return; }
  if (rebalanceDraft.some(p => !p.raw_name?.trim())) { alert("Every position needs a name."); return; }
  if (!ok) { alert("Weights must sum to 100% (± 0.5) before submitting."); return; }

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
