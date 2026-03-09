import { Hono } from "hono";
import { getSql } from "../db.ts";

export const partRouter = new Hono();

partRouter.get("/batch", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^C\d+$/.test(s));
  if (ids.length === 0) return c.json({ results: [] });

  const sql = getSql();
  const rows = await sql`
    SELECT lcsc, mpn, manufacturer, category, subcategory, description,
           datasheet, package, joints, stock, price_raw, img, url,
           part_type, pcba_type
    FROM parts WHERE lcsc IN ${sql(ids)}
  `;

  return c.json({ results: rows });
});

partRouter.get("/:lcsc", async (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  const sql = getSql();

  const rows = await sql`
    SELECT lcsc, mpn, manufacturer, category, subcategory, description,
           datasheet, package, joints, stock, price_raw, img, url,
           part_type, pcba_type, attributes
    FROM parts WHERE lcsc = ${lcsc}
  `;

  if (rows.length === 0) {
    return c.json({ error: "Part not found" }, 404);
  }

  return c.json(rows[0]);
});
