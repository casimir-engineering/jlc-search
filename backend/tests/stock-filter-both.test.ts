import { Hono } from "hono";
import { describe, test, expect } from "bun:test";
import { searchRouter } from "../src/routes/search.ts";

// Minimal mount: replicate just the wiring that production uses for /api/search.
// No CORS / rate-limit middleware — those are orthogonal to the stockFilter
// behavior we're verifying.
const app = new Hono();
app.route("/api/search", searchRouter);

const QUERY = "0603 10k";
// limit=50 makes invariants 2-5 actually probe a meaningful slice; the
// no-param baseline stays at 50 so its `total` is comparable to the others.

async function getJson(path: string): Promise<any> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return res.json();
}

describe("stockFilter=both (and existing values)", () => {
  test("default behavior unchanged when stockFilter is omitted", async () => {
    const body = await getJson(
      `/api/search?q=${encodeURIComponent(QUERY)}&limit=10`,
    );
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThanOrEqual(10);
    // The default is `none`: out-of-stock parts ARE allowed in the response.
    // We don't assert any are present (the top-ranked slice may all be in
    // stock), only that the route doesn't throw and returns results.
  });

  test("stockFilter=lcsc — every result has stock > 0", async () => {
    const body = await getJson(
      `/api/search?q=${encodeURIComponent(QUERY)}&limit=50&stockFilter=lcsc`,
    );
    for (const r of body.results) {
      expect(r.stock).toBeGreaterThan(0);
    }
  });

  test("stockFilter=jlc — every result has jlc_stock > 0", async () => {
    const body = await getJson(
      `/api/search?q=${encodeURIComponent(QUERY)}&limit=50&stockFilter=jlc`,
    );
    for (const r of body.results) {
      expect(r.jlc_stock).toBeGreaterThan(0);
    }
  });

  test("stockFilter=any — every result has stock > 0 OR jlc_stock > 0", async () => {
    const body = await getJson(
      `/api/search?q=${encodeURIComponent(QUERY)}&limit=50&stockFilter=any`,
    );
    for (const r of body.results) {
      expect(r.stock > 0 || r.jlc_stock > 0).toBe(true);
    }
  });

  test("stockFilter=both — every result has stock > 0 AND jlc_stock > 0", async () => {
    const body = await getJson(
      `/api/search?q=${encodeURIComponent(QUERY)}&limit=50&stockFilter=both`,
    );
    for (const r of body.results) {
      expect(r.stock).toBeGreaterThan(0);
      expect(r.jlc_stock).toBeGreaterThan(0);
    }
  });

  test("stockFilter=both total ≤ stockFilter=any total (subset invariant)", async () => {
    const [bothBody, anyBody] = await Promise.all([
      getJson(`/api/search?q=${encodeURIComponent(QUERY)}&limit=50&stockFilter=both`),
      getJson(`/api/search?q=${encodeURIComponent(QUERY)}&limit=50&stockFilter=any`),
    ]);
    expect(bothBody.total).toBeLessThanOrEqual(anyBody.total);
  });

  test("stockFilter=garbage falls back to none (matches no-param total)", async () => {
    const [garbageBody, baselineBody] = await Promise.all([
      getJson(`/api/search?q=${encodeURIComponent(QUERY)}&limit=10&stockFilter=garbage`),
      getJson(`/api/search?q=${encodeURIComponent(QUERY)}&limit=10`),
    ]);
    expect(garbageBody.total).toBe(baselineBody.total);
  });
});
