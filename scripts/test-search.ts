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
  check: (result: SearchResult) => string | null; // returns error string or null if pass
}

interface SearchResult {
  results: { lcsc: string; mpn: string; manufacturer: string; description: string; score?: number }[];
  total: number;
  took_ms: number;
  query: string;
}

const tests: TestCase[] = [
  {
    name: "Exact LCSC lookup",
    query: "C22074",
    check: (r) => {
      if (r.total !== 1) return `expected total=1, got ${r.total}`;
      if (r.results[0]?.lcsc !== "C22074") return `expected first=C22074, got ${r.results[0]?.lcsc}`;
      return null;
    },
  },
  {
    name: "Multi-token: PicoBlade connector",
    query: "1.25 PicoBlade horizontal smd",
    check: (r) => {
      if (r.total === 0) return "no results";
      if (r.results[0]?.lcsc !== "C22074") return `expected first=C22074, got ${r.results[0]?.lcsc}`;
      return null;
    },
  },
  {
    name: "Range filter: LED reverse W>=70m",
    query: "led reverse W:>=70m",
    check: (r) => {
      if (r.total === 0) return "no results";
      if (!r.results[0]?.description?.toLowerCase().includes("led")) return "first result not an LED";
      return null;
    },
  },
  {
    name: "matchAll=true consistency",
    query: "led reverse W:>=70m",
    params: { matchAll: "true" },
    check: (r) => {
      if (r.total === 0) return "no results";
      if (r.results[0]?.lcsc !== "C61223") return `expected first=C61223, got ${r.results[0]?.lcsc}`;
      return null;
    },
  },
  {
    name: "Capacitor search: 100nF 0402 ceramic",
    query: "100nF 0402 ceramic",
    check: (r) => {
      if (r.total === 0) return "no results";
      if (r.took_ms > 5000) return `too slow: ${r.took_ms}ms`;
      return null;
    },
  },
  {
    name: "MPN prefix: RC0402JR",
    query: "RC0402JR",
    check: (r) => {
      if (r.total < 50) return `expected >50 results, got ${r.total}`;
      if (!r.results[0]?.mpn?.startsWith("RC0402JR")) return `first MPN doesn't start with RC0402JR: ${r.results[0]?.mpn}`;
      return null;
    },
  },
  {
    name: "MPN exact: NRF24L01",
    query: "NRF24L01",
    check: (r) => {
      if (r.total === 0) return "no results";
      if (r.results[0]?.lcsc !== "C8791") return `expected first=C8791, got ${r.results[0]?.lcsc}`;
      return null;
    },
  },
  {
    name: "Empty query returns empty",
    query: "",
    check: (r) => {
      if (r.total !== 0) return `expected total=0, got ${r.total}`;
      return null;
    },
  },
  {
    name: "Negation: LED -red",
    query: "LED reverse -red",
    check: (r) => {
      if (r.total === 0) return "no results";
      for (const p of r.results.slice(0, 10)) {
        if (p.description?.toLowerCase().includes("red")) return `result ${p.lcsc} contains 'red' but should be excluded`;
      }
      return null;
    },
  },
  {
    name: "Performance: single token should be fast",
    query: "capacitor",
    check: (r) => {
      if (r.took_ms > 2000) return `too slow: ${r.took_ms}ms`;
      return null;
    },
  },
];

async function runTest(t: TestCase): Promise<{ name: string; pass: boolean; error?: string; time_ms?: number }> {
  try {
    const params = new URLSearchParams({ q: t.query, ...t.params });
    const resp = await fetch(`${BASE_URL}/api/search?${params}`);
    if (!resp.ok) return { name: t.name, pass: false, error: `HTTP ${resp.status}` };
    const result = (await resp.json()) as SearchResult;
    const error = t.check(result);
    return { name: t.name, pass: !error, error: error ?? undefined, time_ms: result.took_ms };
  } catch (err) {
    return { name: t.name, pass: false, error: String(err) };
  }
}

async function main() {
  console.log(`Testing against ${BASE_URL}\n`);

  // Check backend is running
  try {
    const status = await fetch(`${BASE_URL}/api/status`);
    const data = await status.json() as { total_parts: number };
    console.log(`Backend has ${data.total_parts.toLocaleString()} parts\n`);
  } catch {
    console.error("ERROR: Backend not reachable. Start it first.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    const result = await runTest(t);
    const icon = result.pass ? "PASS" : "FAIL";
    const time = result.time_ms != null ? ` (${result.time_ms}ms)` : "";
    console.log(`  ${icon}  ${result.name}${time}`);
    if (result.error) console.log(`        ${result.error}`);
    if (result.pass) passed++;
    else failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
  if (failed > 0) process.exit(1);
}

main();
