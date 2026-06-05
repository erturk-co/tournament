/* ─── config ─────────────────────────────────────────────────────────── */
const START_DATE = "2026-06-02";
const BASE_CURRENCY = "USD";
const COLORS = ["#4a6880","#9e6b72","#7a8f6e","#a07a3a","#6b7a8f","#8f7a6b","#b5564a","#5a7a5e"];
const LW = window.LightweightCharts;

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
let portfolios = [];
let priceData = {};
let lwCharts = [];
let baselineOverrides = {};

/* ─── init ───────────────────────────────────────────────────────────── */
async function init() {
  try {
    const [pRes, prRes] = await Promise.all([
      fetch("data/portfolios.json"),
      fetch("data/prices.json")
    ]);
    portfolios = await pRes.json();
    const raw = await prRes.json();
    priceData = raw.prices || {};
    document.getElementById("last-updated").textContent =
      `prices as of ${raw.fetched_at ?? "unknown"}`;
    buildBaselineOverrides();
    setupNav();
    renderLeaderboard();
  } catch (e) {
    console.error(e);
    document.querySelector("main").innerHTML =
      `<p class="loading">Could not load data. Run the fetch script first.</p>`;
  }
}

function buildBaselineOverrides() {
  portfolios.forEach(p => {
    p.positions.forEach(pos => {
      if (pos.ticker && pos.baseline_price != null) {
        baselineOverrides[pos.ticker] = pos.baseline_price;
      }
    });
  });
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
}

/* ─── price helpers ──────────────────────────────────────────────────── */
function getDates() {
  const all = new Set();
  Object.values(priceData).forEach(s => Object.keys(s).forEach(d => all.add(d)));
  return [...all].filter(d => d >= START_DATE).sort();
}

function getBaselinePrice(ticker) {
  if (baselineOverrides[ticker] != null) return baselineOverrides[ticker];
  const series = priceData[ticker];
  if (!series) return null;
  const dates = Object.keys(series).filter(d => d >= START_DATE).sort();
  return dates.length ? series[dates[0]] : null;
}

function getFXRate(ccy, date) {
  if (!ccy || ccy === BASE_CURRENCY) return 1;
  const series = priceData[`${ccy}USD=X`];
  if (!series) return 1;
  const closest = Object.keys(series).sort().filter(d => d <= date).pop();
  return closest ? series[closest] : 1;
}

function getPriceSeries(ticker) {
  const series = priceData[ticker];
  if (!series) return null;
  return Object.keys(series).filter(d => d >= START_DATE).sort()
    .map(d => ({ time: d, value: series[d] }));
}

function getReturnSeries(ticker, currency) {
  const series = priceData[ticker];
  if (!series) return null;
  const baseline = getBaselinePrice(ticker);
  if (baseline == null) return null;
  const fxBase = getFXRate(currency, START_DATE);
  const dates = Object.keys(series).filter(d => d >= START_DATE).sort();
  return dates.map(d => {
    const fxNow = getFXRate(currency, d);
    const ret = ((series[d] * fxNow) - (baseline * fxBase)) / (baseline * fxBase);
    return { date: d, ret };
  });
}

function computePortfolioReturn(participant) {
  const dates = getDates();
  if (!dates.length) return { totalReturn: 0, series: [], unresolved: [] };

  const totalWeight = participant.positions.reduce((s, p) => s + (p.weight || 0), 0);
  const unresolved = participant.positions.filter(p => !p.ticker || !priceData[p.ticker]);
  const resolved   = participant.positions.filter(p =>  p.ticker &&  priceData[p.ticker]);

  // pre-compute return series per resolved position
  const posSeries = resolved.map(pos => ({
    weight: (pos.weight || 0) / (totalWeight || 100),
    ret: getReturnSeries(pos.ticker, pos.currency) ?? [],
  }));

  const series = dates.map(date => {
    let val = 0;
    for (const { weight, ret } of posSeries) {
      const entry = ret.find(r => r.date === date) ?? ret[ret.length - 1];
      if (entry) val += weight * entry.ret;
    }
    return { date, value: val };
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
    renderPositionCards(participant);
  });
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
  section.innerHTML = `
    <div class="chart-block">
      <h2>Positions</h2>
      <div class="positions-grid" id="positions-grid"></div>
    </div>`;
  const grid = document.getElementById("positions-grid");

  participant.positions.forEach((pos, i) => {
    const retSeries = pos.ticker ? getReturnSeries(pos.ticker, pos.currency) : null;
    const totalRet  = retSeries?.at(-1)?.ret ?? null;
    const color     = COLORS[i % COLORS.length];
    const chartId   = `pos-chart-${i}`;

    const retLabel = totalRet === null
      ? `<span class="position-return" style="color:#9a9186">no data</span>`
      : `<span class="position-return ${totalRet >= 0 ? "return-pos" : "return-neg"}">${totalRet >= 0 ? "+" : ""}${(totalRet * 100).toFixed(2)}%</span>`;

    const card = document.createElement("div");
    card.className = "position-card";
    card.innerHTML = `
      <div class="position-card-header">
        <div>
          <span class="position-ticker">${pos.ticker ?? pos.raw_name}</span>
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
    const totalWeight = p.positions.reduce((s, pos) => s + (pos.weight || 0), 0);
    const weightOk    = Math.abs(totalWeight - 100) < 0.01;
    const card        = document.createElement("div");
    card.className    = "portfolio-card";

    card.innerHTML = `
      <div class="portfolio-card-header">
        <h2>${p.name}</h2>
        ${!weightOk ? `<span class="portfolio-weight-warn">weights sum to ${totalWeight.toFixed(1)}%</span>` : ""}
      </div>
      <table class="portfolio-table">
        <thead><tr>
          <th>Asset</th><th>Ticker</th><th>Type</th><th>Ccy</th>
          <th style="text-align:right">Weight</th><th class="weight-bar-cell"></th><th>Notes</th>
        </tr></thead>
        <tbody>
          ${p.positions.map(pos => `
            <tr>
              <td>${pos.raw_name}</td>
              <td class="td-ticker">${pos.ticker ?? "—"}</td>
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
    grid.appendChild(card);
  });
}

/* ─── cleanup ────────────────────────────────────────────────────────── */
function destroyCharts() {
  lwCharts.forEach(c => { try { c.remove(); } catch (_) {} });
  lwCharts = [];
}

/* ─── go ─────────────────────────────────────────────────────────────── */
init();
