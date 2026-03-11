import { describe, expect, test } from "bun:test";
import { encodeCartToHash, decodeCartFromHash } from "./share.ts";

describe("encodeCartToHash", () => {
  test("encodes quantities to hash", () => {
    const hash = encodeCartToHash({ C22074: 10, C25725: 5 });
    expect(hash).toContain("#cart=");
    expect(hash).toContain("C22074:10");
    expect(hash).toContain("C25725:5");
  });

  test("returns empty string for empty quantities", () => {
    expect(encodeCartToHash({})).toBe("");
  });

  test("filters out zero quantities", () => {
    expect(encodeCartToHash({ C22074: 0 })).toBe("");
  });
});

describe("decodeCartFromHash", () => {
  test("decodes hash to quantities", () => {
    const result = decodeCartFromHash("#cart=C22074:10,C25725:5");
    expect(result).toEqual({ C22074: 10, C25725: 5 });
  });

  test("returns null for non-cart hash", () => {
    expect(decodeCartFromHash("#other")).toBeNull();
    expect(decodeCartFromHash("")).toBeNull();
  });

  test("round-trips correctly", () => {
    const original = { C22074: 10, C25725: 5, C12345: 200 };
    const hash = encodeCartToHash(original);
    const decoded = decodeCartFromHash(hash);
    expect(decoded).toEqual(original);
  });
});
