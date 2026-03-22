import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatComparisonTable } from "../format.ts";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

export function register(server: McpServer): void {
  server.registerTool(
    "compare_parts",
    {
      title: "Compare Parts Side-by-Side",
      description:
        "Compare up to 10 electronic components side by side. " +
        "Useful for evaluating alternatives by specs, pricing, and availability.",
      inputSchema: z.object({
        lcsc_codes: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe(
            "LCSC part numbers to compare, e.g. ['C1525', 'C307331']"
          ),
      }),
    },
    async (params): Promise<CallToolResult> => {
      try {
        // Validate and normalize all codes
        const codes: string[] = [];
        const invalid: string[] = [];

        for (const raw of params.lcsc_codes) {
          const code = raw.trim().toUpperCase();
          if (/^C\d+$/.test(code)) {
            codes.push(code);
          } else {
            invalid.push(raw);
          }
        }

        if (invalid.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid LCSC code(s): ${invalid.join(", ")}. Expected format: C followed by digits (e.g. C1525).`,
              },
            ],
            isError: true,
          };
        }

        if (codes.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: "At least 2 valid LCSC codes are required for comparison.",
              },
            ],
            isError: true,
          };
        }

        const url = `${BACKEND_URL}/api/parts/batch?ids=${codes.join(",")}`;
        const resp = await fetch(url);

        if (!resp.ok) {
          const body = await resp.text();
          return {
            content: [
              {
                type: "text",
                text: `API error (${resp.status}): ${body}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await resp.json()) as { results: any[] };
        const parts = data.results;

        if (parts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `None of the requested parts were found: ${codes.join(", ")}`,
              },
            ],
          };
        }

        // Report any codes that were not found
        const foundCodes = new Set(
          parts.map((p: any) => p.lcsc.toUpperCase())
        );
        const notFound = codes.filter((c) => !foundCodes.has(c));

        // Parse attributes if returned as strings
        for (const part of parts) {
          if (typeof part.attributes === "string") {
            try {
              part.attributes = JSON.parse(part.attributes);
            } catch {
              part.attributes = null;
            }
          }
        }

        // Order results to match input order
        const ordered = codes
          .map((c) =>
            parts.find((p: any) => p.lcsc.toUpperCase() === c)
          )
          .filter(Boolean);

        let text = formatComparisonTable(ordered);

        if (notFound.length > 0) {
          text += `\n\nNote: ${notFound.length} part(s) not found: ${notFound.join(", ")}`;
        }

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: `Failed to compare parts: ${message}. Is the backend running at ${BACKEND_URL}?`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
