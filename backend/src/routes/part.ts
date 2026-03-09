import { Hono } from "hono";
import { getDb } from "../db.ts";

export const partRouter = new Hono();

partRouter.get("/batch", (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^C\d+$/.test(s));
  if (ids.length === 0) return c.json({ results: [] });

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.query<Record<string, unknown>, unknown[]>(
    `SELECT lcsc, mpn, manufacturer, category, subcategory, description,
            datasheet, package, joints, stock, price_raw, img, url,
            part_type, pcba_type
     FROM parts WHERE lcsc IN (${placeholders})`
  ).all(...ids);

  return c.json({ results: rows });
});

partRouter.get("/:lcsc", (c) => {
  const lcsc = c.req.param("lcsc").toUpperCase();
  const db = getDb();

  const row = db.query<Record<string, unknown>, string>(
    `SELECT lcsc, mpn, manufacturer, category, subcategory, description,
            datasheet, package, joints, stock, price_raw, img, url,
            part_type, pcba_type, attributes
     FROM parts WHERE lcsc = ?`
  ).get(lcsc);

  if (!row) {
    return c.json({ error: "Part not found" }, 404);
  }

  return c.json({
    ...row,
    attributes: JSON.parse(row.attributes as string),
  });
});
