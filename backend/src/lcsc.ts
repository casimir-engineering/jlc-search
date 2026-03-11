import { getSql } from "./db.ts";

const LCSC_API = "https://wmsc.lcsc.com/ftps/wm/product/detail";

/** Fire-and-forget refresh of moq, price_raw, stock from LCSC API. */
export function refreshFromLcsc(lcsc: string): void {
  _refresh(lcsc).catch((err) => {
    if (process.env.DEBUG) console.error(`LCSC refresh ${lcsc}:`, err?.message ?? err);
  });
}

async function _refresh(lcsc: string): Promise<void> {
  const resp = await fetch(`${LCSC_API}?productCode=${lcsc}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return;
  const data = await resp.json();
  const r = data?.result;
  if (!r) return;

  const moq = r.minBuyNumber > 0 ? r.minBuyNumber : null;
  const stock = r.stockNumber ?? null;

  let priceRaw: string | null = null;
  if (Array.isArray(r.productPriceList) && r.productPriceList.length > 0) {
    priceRaw = r.productPriceList
      .sort((a: any, b: any) => a.ladder - b.ladder)
      .map((t: any, idx: number, arr: any[]) => {
        const end = idx < arr.length - 1 ? arr[idx + 1].ladder - 1 : "";
        return `${t.ladder}-${end}:${t.usdPrice}`;
      })
      .join(",");
  }

  const sql = getSql();
  if (moq != null || priceRaw != null) {
    await sql`
      UPDATE parts SET
        moq = COALESCE(${moq}, moq),
        price_raw = COALESCE(${priceRaw}, price_raw),
        stock = COALESCE(${stock}, stock)
      WHERE lcsc = ${lcsc}
    `;
  }
}
