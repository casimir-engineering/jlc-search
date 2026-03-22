import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

export function register(server: McpServer): void {
  server.registerTool(
    "list_categories",
    {
      title: "List Component Categories",
      description:
        "List all available component categories with part counts. " +
        "Use to discover valid category names for filtering in search_parts.",
      inputSchema: z.object({}),
    },
    async (): Promise<CallToolResult> => {
      try {
        const url = `${BACKEND_URL}/api/status/categories`;
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

        const categories = (await resp.json()) as Array<{
          name: string;
          count: number;
        }>;

        if (categories.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No categories found. The database may be empty.",
              },
            ],
          };
        }

        const totalParts = categories.reduce((sum, c) => sum + c.count, 0);
        const lines: string[] = [];

        lines.push(
          `${categories.length} categories (${totalParts.toLocaleString("en-US")} total parts):`
        );
        lines.push("");

        for (const cat of categories) {
          lines.push(
            `  ${cat.name} (${cat.count.toLocaleString("en-US")} parts)`
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: `Failed to list categories: ${message}. Is the backend running at ${BACKEND_URL}?`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
