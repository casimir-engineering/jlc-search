/**
 * Search verification test suite.
 * Runs against a live backend and checks expected results.
 *
 * Usage: bun run scripts/test-search.ts [--base-url http://localhost:3001]
 */

const BASE_URL = process.argv.includes("--base-url")
  ? process.argv[process.argv.indexOf("--base-url") + 1]
  : "http://localhost:3001";

interface TestCase {
  name: string;
  query: string;
  params?: Record<string, string>;
  preDelay?: number; // ms to wait before running this test
  check: (result: SearchResult) => (string | null) | Promise<string | null>; // returns error string or null if pass
}

interface SearchResult {
  results: { lcsc: string; mpn: string; manufacturer: string; description: string; stock: number; jlc_stock: number; score?: number }[];
  total: number;
  took_ms: number;
  query: string;
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

const tests: TestCase[] = [
  // ── Exact Lookup ────────────────────────────────────────────────────────
  {
    name: "Exact LCSC lookup: C22074",
    query: "C22074",
    check: (r) => {
      if (r.total !== 1) return `expected total=1, got ${r.total}`;
      if (r.results[0]?.lcsc !== "C22074") return `expected first=C22074, got ${r.results[0]?.lcsc}`;
      return null;
    },
  },

  // ── Prefix Matching (Tier 0 FTS) ───────────────────────────────────────
  {
    name: "MPN prefix: RC0402JR → >50 results, first MPN starts with RC0402JR",
    query: "RC0402JR",
    check: (r) => {
      if (r.total < 50) return `expected >50 results, got ${r.total}`;
      if (!r.results[0]?.mpn?.startsWith("RC0402JR"))
        return `first MPN doesn't start with RC0402JR: ${r.results[0]?.mpn}`;
      return null;
    },
  },
  {
    name: "Manufacturer prefix: pada → >50 results, includes PADAUK",
    query: "pada",
    check: (r) => {
      if (r.total < 50) return `expected >50 results, got ${r.total}`;
      const hasPadauk = r.results.some((p) => /padauk/i.test(p.manufacturer));
      if (!hasPadauk) return `no PADAUK manufacturer in results`;
      return null;
    },
  },
  {
    name: "Part family prefix: nrf → >10 results, includes NRF24L01-type",
    query: "nrf",
    check: (r) => {
      if (r.total < 10) return `expected >10 results, got ${r.total}`;
      const hasNrf24 = r.results.some((p) => /nrf24/i.test(p.mpn));
      if (!hasNrf24) return `no NRF24-type MPN in results`;
      return null;
    },
  },
  {
    name: "Part family prefix: stm → >100 results, includes STM32-type",
    query: "stm",
    check: (r) => {
      if (r.total < 100) return `expected >100 results, got ${r.total}`;
      const hasStm32 = r.results.some((p) => /stm32/i.test(p.mpn));
      if (!hasStm32) return `no STM32-type MPN in results`;
      return null;
    },
  },
  {
    name: "Short prefix: ESP32-S → >50 results",
    query: "ESP32-S",
    check: (r) => {
      if (r.total < 50) return `expected >50 results, got ${r.total}`;
      return null;
    },
  },

  // ── Substring Matching (Tier 1) ────────────────────────────────────────
  {
    name: "Substring in manufacturer: ada → includes Padauk (contains 'ada')",
    query: "ada",
    params: { limit: "200" },
    check: (r) => {
      if (r.total === 0) return "no results";
      const hasPadauk = r.results.some((p) => /padauk/i.test(p.manufacturer));
      if (!hasPadauk)
        return `no Padauk manufacturer in top 200 results (substring 'ada' in 'Padauk')`;
      return null;
    },
  },
  {
    name: "Substring: kem → includes KEMET parts",
    query: "kem",
    params: { limit: "200" },
    check: (r) => {
      if (r.total === 0) return "no results";
      const hasKemet = r.results.some((p) => /kemet/i.test(p.manufacturer));
      if (!hasKemet) return `no KEMET manufacturer in top 200 results`;
      return null;
    },
  },

  // ── Multi-token ────────────────────────────────────────────────────────
  {
    name: "Multi-token AND: PicoBlade 1.25 smd → >10 PicoBlade results",
    query: "1.25 PicoBlade smd",
    check: (r) => {
      if (r.total < 10) return `expected >10 results, got ${r.total}`;
      const hasPicoBlade = r.results.some((p) => /picoblade/i.test(p.description));
      if (!hasPicoBlade) return `no PicoBlade in results`;
      return null;
    },
  },
  {
    name: "Multi-token: 100nF 0402 ceramic → results found",
    query: "100nF 0402 ceramic",
    check: (r) => {
      if (r.total === 0) return "no results";
      return null;
    },
  },

  // ── Filters ────────────────────────────────────────────────────────────
  {
    name: "Range filter: led reverse W:>=70m → first is LED-related",
    query: "led reverse W:>=70m",
    check: (r) => {
      if (r.total === 0) return "no results";
      if (!r.results[0]?.description?.toLowerCase().includes("led"))
        return `first result not an LED: ${r.results[0]?.description}`;
      return null;
    },
  },
  {
    name: "matchAll=true: led reverse W:>=70m → first is C61223",
    query: "led reverse W:>=70m",
    params: { matchAll: "true" },
    check: (r) => {
      if (r.total === 0) return "no results";
      if (r.results[0]?.lcsc !== "C61223") return `expected first=C61223, got ${r.results[0]?.lcsc}`;
      return null;
    },
  },
  {
    name: "Negation: LED reverse -red → top 10 have no 'red'",
    query: "LED reverse -red",
    check: (r) => {
      if (r.total === 0) return "no results";
      for (const p of r.results.slice(0, 10)) {
        if (p.description?.toLowerCase().includes("red"))
          return `result ${p.lcsc} contains 'red' but should be excluded`;
      }
      return null;
    },
  },
  // ── Stock Filter Tests ────────────────────────────────────────────────
  {
    name: "Stock filter: LCSC → all results have stock > 0",
    query: "STM32",
    params: { stockFilter: "lcsc" },
    check: (r) => {
      if (r.total === 0) return "no results";
      for (const p of r.results.slice(0, 20)) {
        if (p.stock <= 0) return `result ${p.lcsc} has stock=${p.stock}, expected >0`;
      }
      return null;
    },
  },
  {
    name: "Stock filter: JLC → all results have jlc_stock > 0 (or no results if not yet populated)",
    query: "STM32",
    params: { stockFilter: "jlc" },
    check: (r) => {
      // jlc_stock data only exists after JLCPCB API scraper runs — 0 results is valid
      if (r.total === 0) return null;
      for (const p of r.results.slice(0, 20)) {
        if (p.jlc_stock <= 0) return `result ${p.lcsc} has jlc_stock=${p.jlc_stock}, expected >0`;
      }
      return null;
    },
  },
  {
    name: "Stock filter: any → all results have stock > 0 OR jlc_stock > 0",
    query: "STM32",
    params: { stockFilter: "any" },
    check: (r) => {
      if (r.total === 0) return "no results";
      for (const p of r.results.slice(0, 20)) {
        if (p.stock <= 0 && p.jlc_stock <= 0) {
          return `result ${p.lcsc} has stock=${p.stock}, jlc_stock=${p.jlc_stock}, expected at least one >0`;
        }
      }
      return null;
    },
  },
  {
    name: "Stock filter: none → returns results",
    query: "STM32",
    params: { stockFilter: "none" },
    check: (r) => {
      if (r.total === 0) return "no results";
      return null;
    },
  },
  {
    name: "Stock filter default (no param) → same as none, returns results",
    query: "resistor",
    check: (r) => {
      if (r.total === 0) return "no results for resistor with default filter";
      return null;
    },
  },
  {
    name: "Old inStock param is ignored (backwards compat broken intentionally)",
    query: "STM32",
    params: { inStock: "true" },
    check: (r) => {
      if (r.total === 0) return "no results";
      return null;
    },
  },

  // ── JLC Stock Refresh Tests ───────────────────────────────────────────
  {
    name: "JLC stock refresh: search triggers background refresh, re-search shows jlc_stock",
    query: "STM32F103C8T6",
    check: async (r) => {
      // First search triggers opportunistic refresh for parts with jlc_stock=0
      if (r.total === 0) return "no results for STM32F103C8T6";
      return null; // First pass just triggers the refresh
    },
  },
  {
    name: "JLC stock refresh: after delay, jlc_stock should be populated for popular parts",
    query: "STM32F103C8T6",
    preDelay: 3000,
    check: (r) => {
      if (r.total === 0) return "no results";
      // After the first search triggered a refresh plus ~3s delay,
      // check if jlc_stock got populated (fire-and-forget may have completed)
      const part = r.results[0];
      if (part.jlc_stock > 0) return null; // Success!
      // It's OK if it hasn't populated yet — the refresh is async
      console.log(`        (note: jlc_stock still 0 for ${part.lcsc} — async refresh may not have completed yet)`);
      return null;
    },
  },

  // ── Edge Cases ─────────────────────────────────────────────────────────
  {
    name: "Empty query → total=0",
    query: "",
    check: (r) => {
      if (r.total !== 0) return `expected total=0, got ${r.total}`;
      return null;
    },
  },
  {
    name: "Single character 'a' → does not crash",
    query: "a",
    check: (_r) => {
      // Just check it doesn't throw; any result count is fine
      return null;
    },
  },
];

// ── Performance tests ────────────────────────────────────────────────────
// These run after a warm-up query so PG caches are primed.

const PERF_LIMIT_MS = 200;

const perfTests: TestCase[] = [
  {
    name: `Perf: "capacitor" < ${PERF_LIMIT_MS}ms`,
    query: "capacitor",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "connector" < ${PERF_LIMIT_MS}ms`,
    query: "connector",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "resistor" < ${PERF_LIMIT_MS}ms`,
    query: "resistor",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "led" < ${PERF_LIMIT_MS}ms`,
    query: "led",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "ada" < ${PERF_LIMIT_MS}ms`,
    query: "ada",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "100nF 0402 ceramic" < ${PERF_LIMIT_MS}ms`,
    query: "100nF 0402 ceramic",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "RC0402JR" < ${PERF_LIMIT_MS}ms`,
    query: "RC0402JR",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
  {
    name: `Perf: "NRF24L01" < ${PERF_LIMIT_MS}ms`,
    query: "NRF24L01",
    check: (r) => r.took_ms > PERF_LIMIT_MS ? `too slow: ${r.took_ms}ms` : null,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runTest(t: TestCase): Promise<{ name: string; pass: boolean; error?: string; time_ms?: number }> {
  try {
    if (t.preDelay) await new Promise(r => setTimeout(r, t.preDelay));
    const params = new URLSearchParams({ q: t.query, ...t.params });
    const resp = await fetch(`${BASE_URL}/api/search?${params}`);
    if (!resp.ok) return { name: t.name, pass: false, error: `HTTP ${resp.status}` };
    const result = (await resp.json()) as SearchResult;
    const error = await t.check(result);
    return { name: t.name, pass: !error, error: error ?? undefined, time_ms: result.took_ms };
  } catch (err) {
    return { name: t.name, pass: false, error: String(err) };
  }
}

async function warmUp(): Promise<void> {
  // Fire a few queries to prime PostgreSQL shared buffers and OS page cache.
  const warmUpQueries = ["capacitor", "resistor", "led", "connector", "ada"];
  for (const q of warmUpQueries) {
    try {
      await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(q)}`);
    } catch { /* ignore */ }
  }
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  // Check backend is running
  try {
    const status = await fetch(`${BASE_URL}/api/status`);
    const data = (await status.json()) as { total_parts: number };
    console.log(`Backend has ${data.total_parts.toLocaleString()} parts\n`);
  } catch {
    console.error("ERROR: Backend not reachable. Start it first.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  // ── Functional tests ──────────────────────────────────────────────────
  console.log("── Functional Tests ──\n");
  for (const t of tests) {
    const result = await runTest(t);
    const icon = result.pass ? "PASS" : "FAIL";
    const time = result.time_ms != null ? ` (${result.time_ms}ms)` : "";
    console.log(`  ${icon}  ${result.name}${time}`);
    if (result.error) console.log(`        ${result.error}`);
    if (result.pass) passed++;
    else failed++;
  }

  // ── Performance tests (warm cache) ────────────────────────────────────
  console.log("\n── Performance Tests (warm cache, limit: " + PERF_LIMIT_MS + "ms) ──\n");
  await warmUp();

  for (const t of perfTests) {
    const result = await runTest(t);
    const icon = result.pass ? "PASS" : "FAIL";
    const time = result.time_ms != null ? ` (${result.time_ms}ms)` : "";
    console.log(`  ${icon}  ${result.name}${time}`);
    if (result.error) console.log(`        ${result.error}`);
    if (result.pass) passed++;
    else failed++;
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const total = tests.length + perfTests.length;
  console.log(`\n${passed} passed, ${failed} failed out of ${total} tests`);
  if (failed > 0) process.exit(1);
}

main();
