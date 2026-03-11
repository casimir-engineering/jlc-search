import { describe, expect, test } from "bun:test";
import { generateLcscBomCsv, generateJlcpcbBomCsv } from "./bom.ts";
import type { BomItem } from "./bom.ts";

const items: BomItem[] = [
  { lcsc: "C22074", mpn: "CL05B104KO5NNNC", description: "100nF 16V", package: "0402", quantity: 50 },
  { lcsc: "C25725", mpn: "RC0402JR-0710KL", description: '10K "Ohm" resistor', package: "0402", quantity: 100 },
];

describe("generateLcscBomCsv", () => {
  test("produces valid CSV with header", () => {
    const csv = generateLcscBomCsv(items);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("LCSC Part Number,Quantity");
    expect(lines[1]).toBe("C22074,50");
    expect(lines[2]).toBe("C25725,100");
    expect(lines.length).toBe(3);
  });
});

describe("generateJlcpcbBomCsv", () => {
  test("produces valid CSV with header", () => {
    const csv = generateJlcpcbBomCsv(items);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Comment,Designator,Footprint,LCSC Part Number");
    expect(lines[1]).toBe("100nF 16V,CL05B104KO5NNNC,0402,C22074");
    // Second item description has comma and quotes — should be escaped
    expect(lines[2]).toContain("C25725");
    expect(lines[2]).toContain('"');
  });

  test("escapes commas and quotes in fields", () => {
    const item: BomItem = { lcsc: "C1", mpn: "X", description: 'has, comma and "quotes"', package: null, quantity: 1 };
    const csv = generateJlcpcbBomCsv([item]);
    const lines = csv.split("\n");
    expect(lines[1]).toContain('"has, comma and ""quotes"""');
  });
});
