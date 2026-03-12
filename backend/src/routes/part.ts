import { Hono } from "hono";
import { getSql } from "../db.ts";
import { refreshFromLcsc } from "../lcsc.ts";
import { refreshJlcStock } from "../jlcpcb-stock.ts";

export const partRouter = new Hono();

partRouter.get("/batch", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").slice(0, 200).map((s) => s.trim().toUpperCase()).filter((s) => /^C\d+$/.test(s));
  if (ids.length === 0) return c.json({ results: [] });

  const sql = getSql();
  const rows = await sql`
    SELECT lcsc, mpn, manufacturer, category, subcategory, description,
           datasheet, package, joints, stock, jlc_stock, price_raw, img, url,
           part_type, pcba_type, moq
    FROM parts WHERE lcsc IN ${sql(ids)}
  `;

  for (const row of rows) {
    refreshFromLcsc((row as any).lcsc);
    if ((row as any).jlc_stock === 0) refreshJlcStock((row as any).lcsc);
  }
  return c.json({ results: rows });
});

partRouter.get("/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  if (!/^C\d+$/.test(lcsc)) return c.json({ error: "Invalid LCSC code" }, 400);
  const sql = getSql();

  const rows = await sql`
    SELECT lcsc, mpn, manufacturer, category, subcategory, description,
           datasheet, package, joints, stock, jlc_stock, price_raw, img, url,
           part_type, pcba_type, moq, attributes
    FROM parts WHERE lcsc = ${lcsc}
  `;

  if (rows.length === 0) {
    return c.json({ error: "Part not found" }, 404);
  }

  refreshFromLcsc(lcsc);
  if ((rows[0] as any).jlc_stock === 0) refreshJlcStock(lcsc);
  return c.json(rows[0]);
});
