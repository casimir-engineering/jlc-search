import { getSql } from "./db.ts";
import { shouldRefresh, withConcurrencyLimit } from "./refresh-limiter.ts";

const JLCPCB_API = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList";

/** Fire-and-forget refresh of jlc_stock from JLCPCB API. */
export function refreshJlcStock(lcsc: string): void {
  if (!shouldRefresh("jlcpcb", lcsc)) return;
  withConcurrencyLimit("jlcpcb", () =>
    _refresh(lcsc).catch((err) => {
      if (process.env.DEBUG) console.error(`JLCPCB stock refresh ${lcsc}:`, err?.message ?? err);
    }),
  );
}

async function _refresh(lcsc: string): Promise<void> {
  const resp = await fetch(JLCPCB_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keyword: lcsc,
      pageSize: 1,
      currentPage: 1,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return;
  const data = await resp.json();
  const list = data?.data?.componentPageInfo?.list;
  if (!Array.isArray(list) || list.length === 0) return;

  // Find exact match (the API may return partial matches)
  const match = list.find((p: any) => (p.componentCode || "").toUpperCase() === lcsc.toUpperCase());
  if (!match) return;

  const jlcStock = match.stockCount ?? 0;
  const sql = getSql();
  await sql`UPDATE parts SET jlc_stock = ${jlcStock} WHERE lcsc = ${lcsc}`;
}
