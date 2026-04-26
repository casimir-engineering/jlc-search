import { Hono } from "hono";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { kibraryRouter } from "../src/routes/kibrary.ts";
import {
  insertKibraryKey,
  hashApiKey,
  revokeKey,
} from "../src/db/kibrary-keys.ts";
import { getSql } from "../src/db.ts";

const app = new Hono();
app.route("/api/kibrary", kibraryRouter);

let TEST_RAW_KEY: string;
let testKeyId: number;
let REVOKED_RAW_KEY: string;
let revokedKeyId: number;
let RATE_LIMIT_RAW_KEY: string;
let rateLimitKeyId: number;

beforeAll(async () => {
  TEST_RAW_KEY = "test-" + crypto.randomUUID();
  testKeyId = await insertKibraryKey("test-suite-active", hashApiKey(TEST_RAW_KEY));

  REVOKED_RAW_KEY = "test-revoked-" + crypto.randomUUID();
  revokedKeyId = await insertKibraryKey("test-suite-revoked", hashApiKey(REVOKED_RAW_KEY));
  await revokeKey(revokedKeyId);

  // Dedicated key for the rate-limit test so its bucket starts at full
  // capacity, independent of tokens consumed by tests 1–3.
  RATE_LIMIT_RAW_KEY = "test-rl-" + crypto.randomUUID();
  rateLimitKeyId = await insertKibraryKey("test-suite-ratelimit", hashApiKey(RATE_LIMIT_RAW_KEY));
});

afterAll(async () => {
  const sql = getSql();
  await sql`DELETE FROM kibrary_api_keys WHERE label LIKE 'test-suite-%'`;
});

describe("kibrary integration", () => {
  test("search returns enriched results", async () => {
    const res = await app.request("/api/kibrary/search?q=10k+0402", {
      headers: { Authorization: `Bearer ${TEST_RAW_KEY}` },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    for (const r of body.results) {
      expect(typeof r.lcsc).toBe("string");
      expect(typeof r.in_stock).toBe("boolean");
      expect(r.photo_url === null || typeof r.photo_url === "string").toBe(true);
    }
  });

  test("part detail includes category", async () => {
    const res = await app.request("/api/kibrary/parts/C25804", {
      headers: { Authorization: `Bearer ${TEST_RAW_KEY}` },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(typeof body.category).toBe("string");
    expect(body.category.length).toBeGreaterThan(0);
    expect(typeof body.subcategory).toBe("string");
    expect(body.subcategory.length).toBeGreaterThan(0);
  });

  test("batch endpoint returns map shape with nulls for missing", async () => {
    // Mixed case in input — handler normalizes to uppercase; response keys
    // are the canonical uppercase form (matches /parts/:lcsc behavior).
    const res = await app.request(
      "/api/kibrary/parts/batch?lcsc=C1525,c25804,Cnonexistent",
      { headers: { Authorization: `Bearer ${TEST_RAW_KEY}` } },
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.parts).toBeDefined();
    const keys = Object.keys(body.parts);
    expect(keys.length).toBe(3);
    expect(keys).toContain("C1525");
    expect(keys).toContain("C25804");
    expect(keys).toContain("CNONEXISTENT");
    expect(body.parts.CNONEXISTENT).toBeNull();
    expect(body.parts.C1525).not.toBeNull();
    expect(body.parts.C1525.lcsc).toBe("C1525");
    expect(body.parts.C25804).not.toBeNull();
    expect(body.parts.C25804.lcsc).toBe("C25804");
  });

  test("missing Authorization returns 401", async () => {
    const res = await app.request("/api/kibrary/search?q=foo");
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });

  test("revoked key returns 401", async () => {
    const res = await app.request("/api/kibrary/search?q=foo", {
      headers: { Authorization: `Bearer ${REVOKED_RAW_KEY}` },
    });
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });

  test("rate limit kicks in past 60 search requests/min", async () => {
    // Uses RATE_LIMIT_RAW_KEY so the bucket starts at full capacity (60),
    // independent of any tokens consumed by other tests against TEST_RAW_KEY.
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      const res = await app.request("/api/kibrary/search?q=cap", {
        headers: { Authorization: `Bearer ${RATE_LIMIT_RAW_KEY}` },
      });
      statuses.push(res.status);
    }
    const tail = statuses.slice(60);
    expect(tail.some((s) => s === 429)).toBe(true);
  });

  test("batch over limit returns 400", async () => {
    const lcscs = Array.from({ length: 101 }, (_, i) => `C${i + 1}`).join(",");
    const res = await app.request(`/api/kibrary/parts/batch?lcsc=${lcscs}`, {
      headers: { Authorization: `Bearer ${TEST_RAW_KEY}` },
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBeDefined();
  });
});
