import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatPart } from "../format.ts";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";
const SITE_URL = "https://jlcsearch.casimir.engineering";

export function register(server: McpServer): void {
  server.registerTool(
    "create_bom",
    {
      title: "Create & Share a BOM",
      description:
        "Create a Bill of Materials (BOM) from a list of LCSC part numbers and quantities. " +
        "Returns a shareable jlcsearch URL that opens the BOM directly in the browser, " +
        "plus a summary with pricing and stock for each part. " +
        "Use this after finding parts with search_parts to build a complete BOM.",
      inputSchema: z.object({
        parts: z
          .array(
            z.object({
              lcsc: z.string().describe("LCSC part number, e.g. 'C1525'"),
              quantity: z
                .number()
                .int()
                .min(1)
                .max(100000)
                .describe("Quantity needed"),
            })
          )
          .min(1)
          .max(500)
          .describe("List of parts with quantities for the BOM"),
      }),
    },
    async (params): Promise<CallToolResult> => {
      try {
        // Validate and normalize LCSC codes
        const valid: { lcsc: string; quantity: number }[] = [];
        const invalid: string[] = [];

        for (const p of params.parts) {
          const lcsc = p.lcsc.trim().toUpperCase();
          if (/^C\d+$/.test(lcsc)) {
            valid.push({ lcsc, quantity: p.quantity });
          } else {
            invalid.push(p.lcsc);
          }
        }

        if (valid.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No valid LCSC codes provided. Expected format: C followed by digits (e.g. C1525).${invalid.length > 0 ? ` Invalid: ${invalid.join(", ")}` : ""}`,
              },
            ],
            isError: true,
          };
        }

        // Build the share URL
        const hashParts = valid.map((p) => `${p.lcsc}:${p.quantity}`).join(",");
        const shareUrl = `${SITE_URL}/#cart=${hashParts}`;

        // Fetch part details for the summary
        const ids = valid.map((p) => p.lcsc).join(",");
        const resp = await fetch(`${BACKEND_URL}/api/parts/batch?ids=${ids}`);

        let summary = "";

        if (resp.ok) {
          const data = (await resp.json()) as { results: any[] };
          const partsMap = new Map<string, any>();
          for (const p of data.results) {
            partsMap.set(p.lcsc.toUpperCase(), p);
          }

          // Build summary table
          const lines: string[] = [];
          let totalCost = 0;

          lines.push(`BOM: ${valid.length} line item(s)\n`);

          for (const item of valid) {
            const part = partsMap.get(item.lcsc);
            if (part) {
              // Get unit price from first tier
              let unitPrice = 0;
              if (part.price_raw) {
                const firstTier = part.price_raw.split(",")[0];
                if (firstTier) {
                  const price = parseFloat(firstTier.split(":")[1] ?? "0");
                  if (isFinite(price)) unitPrice = price;
                }
              }
              const lineCost = unitPrice * item.quantity;
              totalCost += lineCost;

              const mfr = part.manufacturer ? `${part.manufacturer} ` : "";
              lines.push(`${item.lcsc} x${item.quantity} — ${mfr}${part.mpn}`);
              lines.push(`  ${part.description}`);
              lines.push(
                `  Stock: JLCPCB ${part.jlc_stock?.toLocaleString("en-US") ?? "?"} | LCSC ${part.stock?.toLocaleString("en-US") ?? "?"}`
              );
              lines.push(
                `  Unit: $${unitPrice.toFixed(4)} | Line: $${lineCost.toFixed(2)}`
              );
              if (part.jlc_stock === 0 && part.stock === 0) {
                lines.push(`  ⚠ OUT OF STOCK`);
              }
              lines.push("");
            } else {
              lines.push(`${item.lcsc} x${item.quantity} — NOT FOUND`);
              lines.push("");
            }
          }

          lines.push(`Estimated total: $${totalCost.toFixed(2)} (at lowest quantity pricing)`);

          // Report missing parts
          const notFound = valid.filter((p) => !partsMap.has(p.lcsc));
          if (notFound.length > 0) {
            lines.push(
              `\nNote: ${notFound.length} part(s) not found: ${notFound.map((p) => p.lcsc).join(", ")}`
            );
          }

          if (invalid.length > 0) {
            lines.push(
              `\nSkipped invalid codes: ${invalid.join(", ")}`
            );
          }

          summary = lines.join("\n");
        } else {
          summary = `BOM: ${valid.length} part(s) (could not fetch details)`;
        }

        const text = `${summary}\n\nShare this BOM:\n${shareUrl}`;

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: `Failed to create BOM: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
