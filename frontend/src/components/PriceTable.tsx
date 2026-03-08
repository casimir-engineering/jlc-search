import type { PriceTier } from "../types.ts";

export function parsePriceTiers(raw: string): PriceTier[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tier) => {
      const [range, price] = tier.split(":");
      const parsed = parseFloat(price ?? "0");
      return { range: range ?? "", price: isNaN(parsed) ? 0 : parsed };
    })
    .filter((t) => t.range);
}

interface Props {
  priceRaw: string;
}

export function PriceTable({ priceRaw }: Props) {
  const tiers = parsePriceTiers(priceRaw);
  if (tiers.length === 0) return <span className="price-na">—</span>;

  return (
    <div className="price-tiers">
      {tiers.map((t) => (
        <span key={t.range} className="price-tier">
          <span className="price-range">{t.range}</span>
          <span className="price-value">${t.price.toFixed(4)}</span>
        </span>
      ))}
    </div>
  );
}
