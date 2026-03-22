import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatPart } from "../format.ts";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

export function register(server: McpServer): void {
  server.registerTool(
    "get_part",
    {
      title: "Get Part Details",
      description:
        "Get detailed information about a specific electronic component by LCSC code. " +
        "Returns full specs, pricing tiers, stock levels, and extracted attributes.",
      inputSchema: z.object({
        lcsc: z
          .string()
          .describe("LCSC part number, e.g. 'C1525'"),
      }),
    },
    async (params): Promise<CallToolResult> => {
      try {
        const lcsc = params.lcsc.trim().toUpperCase();

        if (!/^C\d+$/.test(lcsc)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid LCSC code "${params.lcsc}". Expected format: C followed by digits (e.g. C1525, C307331).`,
              },
            ],
            isError: true,
          };
        }

        const url = `${BACKEND_URL}/api/parts/${lcsc}`;
        const resp = await fetch(url);

        if (resp.status === 404) {
          return {
            content: [
              {
                type: "text",
                text: `Part ${lcsc} not found in the database.`,
              },
            ],
          };
        }

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

        const part = await resp.json();

        // Parse attributes if returned as a string
        if (typeof part.attributes === "string") {
          try {
            part.attributes = JSON.parse(part.attributes);
          } catch {
            part.attributes = null;
          }
        }

        const text = formatPart(part);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch part details: ${message}. Is the backend running at ${BACKEND_URL}?`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
