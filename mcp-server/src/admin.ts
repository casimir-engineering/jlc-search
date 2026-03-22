#!/usr/bin/env bun
/**
 * CLI for MCP API key management.
 *
 * Usage:
 *   bun run mcp-server/src/admin.ts create --name "My Key" [--tier free]
 *   bun run mcp-server/src/admin.ts list
 *   bun run mcp-server/src/admin.ts revoke --id <key-id>
 */

import { getSql, waitForDb, closeDb } from "./db.ts";
import { generateApiKey } from "./patreon.ts";

const args = process.argv.slice(2);
const command = args[0];

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  await waitForDb();
  const sql = getSql();

  switch (command) {
    case "create": {
      const name = getArg("--name");
      if (!name) {
        console.error("Usage: admin.ts create --name \"My Key\" [--tier free]");
        process.exit(1);
      }
      const tier = getArg("--tier") ?? "free";
      const id = crypto.randomUUID();
      const { key, hash } = generateApiKey();
      const keyHash = await hash;

      await sql`
        INSERT INTO mcp_api_keys (id, key_hash, name, tier)
        VALUES (${id}, ${keyHash}, ${name}, ${tier})
      `;

      console.log("API key created successfully:");
      console.log(`  ID:   ${id}`);
      console.log(`  Name: ${name}`);
      console.log(`  Tier: ${tier}`);
      console.log(`  Key:  ${key}`);
      console.log("");
      console.log("Save this key now. It cannot be retrieved later.");
      break;
    }

    case "list": {
      const rows = await sql`
        SELECT id, name, tier, is_active, patreon_member_id, created_at
        FROM mcp_api_keys
        ORDER BY created_at DESC
      `;

      if (rows.length === 0) {
        console.log("No API keys found.");
        break;
      }

      console.log(`${rows.length} API key(s):\n`);
      for (const row of rows) {
        const status = row.is_active ? "active" : "revoked";
        const patreon = row.patreon_member_id ? ` (Patreon: ${row.patreon_member_id})` : "";
        const created = new Date(row.created_at as string).toISOString().slice(0, 10);
        console.log(`  ${row.id}  ${row.name}  tier=${row.tier}  ${status}  ${created}${patreon}`);
      }
      break;
    }

    case "revoke": {
      const id = getArg("--id");
      if (!id) {
        console.error("Usage: admin.ts revoke --id <key-id>");
        process.exit(1);
      }

      const result = await sql`
        UPDATE mcp_api_keys SET is_active = false WHERE id = ${id} RETURNING id, name
      `;

      if (result.length === 0) {
        console.error(`No key found with ID: ${id}`);
        process.exit(1);
      }

      console.log(`Revoked key: ${result[0].name} (${result[0].id})`);
      break;
    }

    default:
      console.error("Usage: admin.ts <create|list|revoke> [options]");
      console.error("");
      console.error("Commands:");
      console.error("  create --name \"My Key\" [--tier free]   Create a new API key");
      console.error("  list                                   List all API keys");
      console.error("  revoke --id <key-id>                   Revoke an API key");
      process.exit(1);
  }

  await closeDb();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
