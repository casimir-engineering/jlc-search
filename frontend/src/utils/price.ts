export interface PriceTierWithRange {
  min: number;
  max: number;
  price: number;
}

// Parse "1-10:0.0052,11-50:0.0048" into structured tiers
export function parseTiersWithRanges(priceRaw: string): PriceTierWithRange[] {
  if (!priceRaw) return [];
  return priceRaw.split(",").map((tier) => {
    const [range, priceStr] = tier.split(":");
    const price = parseFloat(priceStr ?? "0");
    const [minStr, maxStr] = (range ?? "").split("-");
    const min = parseInt(minStr ?? "0", 10);
    const max = maxStr ? parseInt(maxStr, 10) : Infinity;
    return { min: isNaN(min) ? 0 : min, max: isNaN(max) ? Infinity : max, price: isNaN(price) ? 0 : price };
  }).filter((t) => t.min > 0 || t.max > 0);
}

// Get minimum order quantity — prefer explicit moq, fall back to first tier min
export function getMoq(priceRaw: string, moq?: number | null): number {
  if (moq != null && moq > 0) return moq;
  const tiers = parseTiersWithRanges(priceRaw);
  return tiers.length > 0 ? tiers[0].min : 1;
}

// Get per-unit price for a given quantity (walk tiers, use last matching)
export function getUnitPrice(priceRaw: string, qty: number): number {
  const tiers = parseTiersWithRanges(priceRaw);
  if (tiers.length === 0) return 0;
  let price = tiers[0].price;
  for (const t of tiers) {
    if (qty >= t.min) price = t.price;
  }
  return price;
}

// Get line total for a quantity
export function getLineTotal(priceRaw: string, qty: number): number {
  return qty * getUnitPrice(priceRaw, qty);
}

// Round quantity up to next MOQ multiple
export function roundToMoqMultiple(qty: number, moq: number): number {
  if (moq <= 1) return Math.max(1, qty);
  return Math.max(moq, Math.ceil(qty / moq) * moq);
}
