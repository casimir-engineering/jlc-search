import { describe, expect, test } from "bun:test";
import { parseTiersWithRanges, getMoq, getUnitPrice, getLineTotal, roundToMoqMultiple } from "./price.ts";

describe("parseTiersWithRanges", () => {
  test("parses standard tier string", () => {
    const tiers = parseTiersWithRanges("1-9:0.0072,10-29:0.0058,30-99:0.005");
    expect(tiers).toEqual([
      { min: 1, max: 9, price: 0.0072 },
      { min: 10, max: 29, price: 0.0058 },
      { min: 30, max: 99, price: 0.005 },
    ]);
  });

  test("returns empty for empty string", () => {
    expect(parseTiersWithRanges("")).toEqual([]);
  });
});

describe("getMoq", () => {
  test("returns first tier min", () => {
    expect(getMoq("5-9:0.01,10-49:0.008")).toBe(5);
  });

  test("returns 1 for empty price", () => {
    expect(getMoq("")).toBe(1);
  });

  test("explicit moq takes priority over tier", () => {
    expect(getMoq("1-9:0.01", 100)).toBe(100);
  });

  test("null moq falls back to tier", () => {
    expect(getMoq("1-9:0.01", null)).toBe(1);
  });

  test("zero moq falls back to tier", () => {
    expect(getMoq("1-9:0.01", 0)).toBe(1);
  });
});

describe("getUnitPrice", () => {
  const raw = "1-9:0.0072,10-29:0.0058,30-99:0.005";

  test("returns first tier price for small qty", () => {
    expect(getUnitPrice(raw, 1)).toBe(0.0072);
    expect(getUnitPrice(raw, 9)).toBe(0.0072);
  });

  test("returns second tier price for mid qty", () => {
    expect(getUnitPrice(raw, 10)).toBe(0.0058);
    expect(getUnitPrice(raw, 29)).toBe(0.0058);
  });

  test("returns last tier price for large qty", () => {
    expect(getUnitPrice(raw, 30)).toBe(0.005);
    expect(getUnitPrice(raw, 100)).toBe(0.005);
  });

  test("returns 0 for empty price", () => {
    expect(getUnitPrice("", 10)).toBe(0);
  });
});

describe("getLineTotal", () => {
  test("multiplies qty by unit price", () => {
    const raw = "1-9:0.01,10-49:0.008";
    expect(getLineTotal(raw, 10)).toBeCloseTo(0.08, 6);
    expect(getLineTotal(raw, 5)).toBeCloseTo(0.05, 6);
  });
});

describe("roundToMoqMultiple", () => {
  test("rounds up to MOQ multiple", () => {
    expect(roundToMoqMultiple(7, 5)).toBe(10);
    expect(roundToMoqMultiple(10, 5)).toBe(10);
    expect(roundToMoqMultiple(11, 5)).toBe(15);
  });

  test("returns at least MOQ", () => {
    expect(roundToMoqMultiple(1, 5)).toBe(5);
    expect(roundToMoqMultiple(0, 5)).toBe(5);
  });

  test("handles MOQ of 1", () => {
    expect(roundToMoqMultiple(3, 1)).toBe(3);
    expect(roundToMoqMultiple(0, 1)).toBe(1);
  });
});
