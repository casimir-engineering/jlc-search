import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatSearchResults } from "../format.ts";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

/** Map from input field name to the search query range token unit. */
const RANGE_UNITS: Record<string, string> = {
  voltage: "V",
  resistance: "Ohm",
  capacitance: "F",
  current: "A",
  power: "W",
  inductance: "H",
  frequency: "Hz",
};

const rangeSchema = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .optional();

export function register(server: McpServer): void {
  server.registerTool(
    "search_parts",
    {
      title: "Search Electronic Components",
      description:
        "Search the JLCPCB/LCSC electronic components database (3.5M+ parts). " +
        "Supports text search by part number, manufacturer, description, package. " +
        "Supports numeric range filters for electrical parameters. " +
        "Returns matching parts with pricing, stock, and specifications.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Search text: keywords, part numbers, manufacturers. " +
              "Examples: 'ESP32-S3', '100nF 0402 X7R', 'STM32F103'"
          ),
        voltage: rangeSchema.describe("Voltage range in volts"),
        resistance: rangeSchema.describe("Resistance in ohms"),
        capacitance: rangeSchema.describe("Capacitance in farads"),
        current: rangeSchema.describe("Current in amps"),
        power: rangeSchema.describe("Power in watts"),
        inductance: rangeSchema.describe("Inductance in henrys"),
        frequency: rangeSchema.describe("Frequency in hertz"),
        part_type: z
          .array(z.enum(["Basic", "Preferred", "Extended"]))
          .optional()
          .describe(
            "JLCPCB part type. Basic=no extra fee, Preferred=small fee, Extended=larger fee"
          ),
        stock_filter: z
          .enum(["none", "jlc", "lcsc", "any"])
          .default("any")
          .describe(
            "Stock filter. any=in stock somewhere, jlc=JLCPCB only, lcsc=LCSC only, none=include out of stock"
          ),
        category: z
          .array(z.string())
          .optional()
          .describe(
            "Category filter. Use list_categories to get valid names"
          ),
        sort: z
          .enum(["relevance", "price_asc", "price_desc", "stock_desc"])
          .default("relevance"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max results (1-50)"),
      }),
    },
    async (params): Promise<CallToolResult> => {
      try {
        // Build the query string by appending range filter tokens
        let q = params.query;

        for (const [field, unit] of Object.entries(RANGE_UNITS)) {
          const range = params[field as keyof typeof params] as
            | { min?: number; max?: number }
            | undefined;
          if (!range) continue;

          if (range.min != null && range.max != null) {
            q += ` ${unit}:${range.min}->${range.max}`;
          } else if (range.min != null) {
            q += ` ${unit}:>=${range.min}`;
          } else if (range.max != null) {
            q += ` ${unit}:<=${range.max}`;
          }
        }

        // Build URL search params
        const searchParams = new URLSearchParams();
        searchParams.set("q", q);
        searchParams.set("stockFilter", params.stock_filter);
        searchParams.set("sort", params.sort);
        searchParams.set("limit", String(params.limit));
        searchParams.set("offset", "0");
        searchParams.set("fuzzy", "true");
        searchParams.set("matchAll", "false");

        if (params.part_type) {
          for (const pt of params.part_type) {
            searchParams.append("partType", pt);
          }
        }

        if (params.category) {
          for (const cat of params.category) {
            searchParams.append("category", cat);
          }
        }

        const url = `${BACKEND_URL}/api/search?${searchParams.toString()}`;
        const resp = await fetch(url);

        if (!resp.ok) {
          const body = await resp.text();
          return {
            content: [
              {
                type: "text",
                text: `Search API error (${resp.status}): ${body}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await resp.json()) as {
          results: any[];
          total: number;
          took_ms: number;
          query: string;
        };

        if (data.results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No parts found matching "${params.query}". Try broader search terms or fewer filters.`,
              },
            ],
          };
        }

        const text = formatSearchResults(
          data.results,
          data.total,
          data.took_ms,
          params.query
        );

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: `Failed to search parts: ${message}. Is the backend running at ${BACKEND_URL}?`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
