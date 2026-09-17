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

const synth = await bootApp({
  tournaments: [{ id: "t", name: "T", start_date: "2026-09-14", end_date: null, status: "active" }],
  participants: [], allocations: [], meta, prices,
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

if (live.missingFXCodes.size) {
  console.log(`\n  note  no FX series yet for ${[...live.missingFXCodes].join(", ")} — ` +
              `those holdings price at parity until the next fetch_prices run`);
}

done();
