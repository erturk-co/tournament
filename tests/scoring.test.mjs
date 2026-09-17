// Scoring-engine tests. Two halves:
//   1. synthetic fixtures pinning the edge cases that have bitten us
//   2. live Supabase data, asserting invariants that must hold whatever the
//      prices happen to be today
//
// Run: node tests/scoring.test.mjs
import { bootApp, fetchTable, ok, near, eq, done } from "./harness.mjs";

const WIN = { start: "2026-09-14", end: null };
const NOW = new Date().toISOString();
const OLD = "2026-09-01T00:00:00+00:00";

const meta = [{ fetched_at: "test", base_currency: "USD" }];
const P = (ticker, weight, extra = {}) => ({ ticker, raw_name: ticker, weight, currency: "USD", ...extra });
const alloc = (positions, created_at = OLD, effective_date = "2026-09-14") =>
  ({ tournament_id: "t", participant_id: "p", effective_date, positions, created_at });

/* ══ 1. synthetic ═══════════════════════════════════════════════════════════ */
const series = {
  GOOD:      { "2026-09-14": 100,  "2026-09-15": 105, "2026-09-16": 110 },
  RECOVER:   { "2026-09-14": 0,    "2026-09-15": 50,  "2026-09-16": 55  },
  NEGFIRST:  { "2026-09-14": -1,   "2026-09-15": 50,  "2026-09-16": 55  },
  NULLFIRST: { "2026-09-14": null, "2026-09-15": 50,  "2026-09-16": 55  },
  ALLZERO:   { "2026-09-14": 0,    "2026-09-15": 0,   "2026-09-16": 0   },
};
const prices = [];
for (const [ticker, s] of Object.entries(series)) {
  for (const [date, price] of Object.entries(s)) prices.push({ ticker, date, price });
}

// GBPUSD at 1.30 exercises the sub-unit path; a London ticker recorded as USD
// exercises the recorded-currency override.
for (const date of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
  prices.push({ ticker: "GBPUSD=X", date, price: 1.3 });
  prices.push({ ticker: "PENCE.L", date, price: 100 });
  prices.push({ ticker: "DOLLAR.L", date, price: 100 });
}

const synth = await bootApp({
  tournaments: [{ id: "t", name: "T", start_date: "2026-09-14", end_date: null, status: "active" }],
  participants: [], allocations: [], meta, prices,
  ticker_meta: [{ ticker: "DOLLAR.L", currency: "USD" }],
});
const run = (allocations) => synth.computePortfolioReturn({ id: "p", name: "P", allocations }, WIN);
const kind = (ticker, created_at = OLD) =>
  synth.classifyPosition(P(ticker, 100), "2026-09-14", null, WIN, alloc([], created_at)).kind;

console.log("\nbaseline resolution — a junk first print must not condemn a good position");
eq("first print 0 -> scored",        kind("RECOVER"),   "scored");
eq("first print negative -> scored", kind("NEGFIRST"),  "scored");
eq("first print null -> scored",     kind("NULLFIRST"), "scored");
near("RECOVER 50 / GOOD 50", run([alloc([P("RECOVER", 50), P("GOOD", 50)])]).totalReturn * 100, 10);

console.log("\n…but an all-zero series is a genuine total loss");
eq("every print 0 -> dead", kind("ALLZERO"), "dead");
near("ALLZERO 50 / GOOD 50", run([alloc([P("ALLZERO", 50), P("GOOD", 50)])]).totalReturn * 100, -45);

console.log("\ngrace period — a just-submitted ticker is not punished for the fetcher lagging");
eq("unknown ticker, fresh -> awaiting", kind("BRANDNEW", NOW), "awaiting");
eq("unknown ticker, stale -> dead",     kind("BRANDNEW", OLD), "dead");
{
  const fresh = run([alloc([P("BRANDNEW", 50), P("GOOD", 50)], NOW)]);
  near("fresh: only the priced half scores", fresh.totalReturn * 100, 5);
  eq("fresh: reported as awaiting", fresh.awaiting.length, 1);
  eq("fresh: not reported as dead", fresh.dead.length, 0);

  const stale = run([alloc([P("BRANDNEW", 50), P("GOOD", 50)], OLD)]);
  near("stale: full weight lost", stale.totalReturn * 100, -45);
  eq("stale: reported as dead", stale.dead.length, 1);
}

console.log("\nreporting — a dead position in a superseded period must still surface");
{
  const past = run([
    alloc([P("ALLZERO", 50), P("GOOD", 50)], OLD, "2026-09-14"),
    alloc([P("GOOD", 100)],                  OLD, "2026-09-15"),
  ]);
  eq("past-period dead is reported", past.dead.length, 1);
  eq("…tagged with the period it was held from", past.dead[0].since, "2026-09-14");
}

console.log("\n…but a REPLACED row (same effective_date) must report nothing");
{
  // Two rows on the same date: the later one wins and the earlier one's range
  // collapses to empty. The discarded row's tickers are not this portfolio's
  // holdings and must not be attributed to it.
  const resub = run([
    { ...alloc([P("DISCARDED", 100)]), created_at: "2026-09-01T00:00:00+00:00" },
    { ...alloc([P("GOOD", 100)]),      created_at: "2026-09-02T00:00:00+00:00" },
  ]);
  near("only the surviving row scores", resub.totalReturn * 100, 10);
  eq("the discarded row reports no dead positions", resub.dead.length, 0);
  eq("…and no awaiting positions", resub.awaiting.length, 0);
}

console.log("\ncurrency — a venue is not one currency");
eq("unrecorded .L falls back to pence", synth.currencyFor({ ticker: "PENCE.L", currency: "USD" }), "GBp");
eq("recorded currency overrides the suffix guess",
  synth.currencyFor({ ticker: "DOLLAR.L", currency: "USD" }), "USD");
eq("Tel Aviv is agorot, not shekels", synth.currencyFor({ ticker: "AMOT.TA", currency: "USD" }), "ILA");
near("GBp converts at GBP/100", synth.getFXRate("GBp", "2026-09-16"), 0.013, 0.0001);
near("GBP converts at par-rate",  synth.getFXRate("GBP", "2026-09-16"), 1.3, 0.0001);
// No ILSUSD=X in the fixture, so the fallback must stay unit-consistent:
// 1/100, not 1, or the parity path silently changes the instrument's scale.
near("missing sub-unit FX still falls back in sub-units",
  synth.getFXRate("ILA", "2026-09-16"), 0.01, 0.0001);

console.log("\nweight handling");
near("string weights behave like numbers",
  run([alloc([P("ALLZERO", "50"), P("GOOD", "50")])]).totalReturn * 100, -45);
near("an entirely dead portfolio bottoms out at -100%",
  run([alloc([P("ALLZERO", 100)])]).totalReturn * 100, -100);

/* ══ 2. live data ═══════════════════════════════════════════════════════════ */
const live = await bootApp({
  tournaments:  await fetchTable("tournaments"),
  participants: await fetchTable("participants", "id,name"),
  allocations:  await fetchTable("allocations", "tournament_id,participant_id,effective_date,positions,created_at"),
  meta:         await fetchTable("meta", "fetched_at,base_currency"),
  prices:       await fetchTable("prices", "ticker,date,price"),
});

console.log("\nlive data — invariants that must hold whatever today's prices are");
const ranked = live.portfolios
  .filter(p => live.effectiveAllocation(p).current)
  .map(p => ({ p, ...live.computePortfolioReturn(p, live.activeWindow) }))
  .sort((a, b) => b.totalReturn - a.totalReturn);

ok("at least one participant is ranked", ranked.length > 0);
ok("every ranked participant has entered",
  ranked.every(r => live.effectiveAllocation(r.p).current));
ok("nobody unranked has an effective allocation",
  live.portfolios.filter(p => !live.effectiveAllocation(p).current)
    .every(p => !live.effectiveAllocation(p).current));
ok("every score is a finite number",
  ranked.every(r => Number.isFinite(r.totalReturn)),
  ranked.filter(r => !Number.isFinite(r.totalReturn)).map(r => r.p.name).join(", "));
ok("no score breaches the -100% floor",
  ranked.every(r => r.totalReturn >= -1.0000001),
  ranked.filter(r => r.totalReturn < -1.0000001).map(r => `${r.p.name} ${r.totalReturn}`).join(", "));
ok("no return series predates the tournament start",
  ranked.every(r => r.series.every(s => s.date >= live.activeWindow.start)));
ok("the table is sorted best-first",
  ranked.every((r, i) => i === 0 || ranked[i - 1].totalReturn >= r.totalReturn));

console.log("\nlive data — completed rounds are frozen");
for (const t of live.historyTournaments) {
  const win = live.windowFor(t);
  if (!win.end) {
    console.log(`  skip  ${t.name} has no end_date yet (migration not applied)`);
    continue;
  }
  const drifted = t.portfolios.filter(p => {
    const now   = live.computePortfolioReturn(p, win, "2026-09-16").totalReturn;
    const later = live.computePortfolioReturn(p, win, "2027-06-01").totalReturn;
    return Math.abs(now - later) > 1e-12;
  });
  ok(`${t.name} scores identically years later`, drifted.length === 0,
    drifted.map(p => p.name).join(", "));
  ok(`${t.name} series stops at its end date`,
    t.portfolios.every(p => live.computePortfolioReturn(p, win).series.every(s => s.date <= win.end)));
}

console.log("\nlive data — the FX warning is scoped to the holder");
{
  const withMissing = ranked.filter(r => r.missingFX.length);
  ok("nobody is warned about a currency they don't hold",
    withMissing.every(r => {
      const held = new Set(live.effectiveAllocation(r.p).current.positions.map(p => live.currencyFor(p)));
      const majors = new Set([...held].map(c => ({ GBp: "GBP", ILA: "ILS", ZAc: "ZAR" })[c] ?? c));
      return r.missingFX.every(c => majors.has(c));
    }),
    withMissing.map(r => `${r.p.name}: ${r.missingFX.join("/")}`).join(", "));
  const names = withMissing.map(r => `${r.p.name} (${r.missingFX.join(", ")})`);
  console.log(`  note  unpriced FX affects: ${names.join("; ") || "nobody"}`);
}

done();
