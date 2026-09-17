// Boots the real app.js in a stubbed browser so the scoring engine can be
// tested without a browser or a build step. Everything the tests assert runs
// through the actual shipped code, not a reimplementation of it.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "tests", ".cache");

const SUPABASE_URL = "https://udyelrobkhnawlpvkcbp.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkeWVscm9ia2huYXdscHZrY2JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Mjk0OTEsImV4cCI6MjEwNDAwNTQ5MX0.z5eXg2GZQ8jHg7KQVZdOTXocbq8RXX7qVLfhD4fgTD4";

// Live rows, cached on disk so a test run isn't at the mercy of the network.
// Delete tests/.cache to refresh.
export async function fetchTable(name, select = "*") {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));

  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?select=${select}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, Range: `${offset}-${offset + 999}` },
    });
    if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

function stubElement() {
  return {
    textContent: "", innerHTML: "", value: "", disabled: false, clientWidth: 600,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, closest: () => null,
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 100 }),
  };
}

// Loads app.js against the supplied tables and returns its internals.
// `tables` maps PostgREST table name -> rows.
export async function bootApp(tables) {
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, stubElement()); return els.get(id); },
    createElement: stubElement,
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
    addEventListener() {},
  };

  async function fakeFetch(url, opts = {}) {
    const table = String(url).split("/rest/v1/")[1]?.split("?")[0];
    let rows = tables[table];
    if (!rows) throw new Error(`no fixture for table "${table}"`);
    const range = opts.headers?.Range;
    if (range) {
      const [a, b] = range.split("-").map(Number);
      rows = rows.slice(a, b + 1);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  }

  const ctx = vm.createContext({
    document, window: { LightweightCharts: {} }, fetch: fakeFetch,
    requestAnimationFrame: () => {}, setTimeout, clearTimeout, console,
    alert: () => {}, confirm: () => true,
    JSON, Math, Date, Object, Set, Map, Number, String, Array,
    parseFloat, parseInt, Error, Promise, isNaN,
  });

  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8")
    // app.js self-starts on load; the tests drive loadData themselves.
    .replace(/\ninit\(\);\s*$/, "\n")
    + `\nglobalThis.__boot = async () => { await loadData();
         return { portfolios, activeTournament, historyTournaments, activeWindow,
                  computePortfolioReturn, effectiveAllocation, classifyPosition,
                  windowFor, currencyFor, missingFXCodes }; };`;

  vm.runInContext(src, ctx, { filename: "app.js" });
  return ctx.__boot();
}

/* ─── tiny assertion helpers ─────────────────────────────────────────────── */
export const failures = [];

export function ok(name, condition, detail = "") {
  const pass = Boolean(condition);
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name}${detail && !pass ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(name);
  return pass;
}

export function near(name, got, want, tol = 0.01) {
  const pass = Number.isFinite(got) && Math.abs(got - want) <= tol;
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name.padEnd(54)} ${Number(got).toFixed(2)} (want ${want})`);
  if (!pass) failures.push(name);
  return pass;
}

export function eq(name, got, want) {
  const pass = got === want;
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name.padEnd(54)} ${got} (want ${want})`);
  if (!pass) failures.push(name);
  return pass;
}

export function done() {
  console.log();
  if (failures.length) {
    console.log(`FAILED (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("PASSED");
}
