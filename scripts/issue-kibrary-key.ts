#!/usr/bin/env bun
import { hashApiKey, insertKibraryKey } from "../backend/src/db/kibrary-keys.ts";
import { closeDb, waitForDb } from "../backend/src/db.ts";

function parseLabel(argv: string[]): string {
  const i = argv.indexOf("--label");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return "unlabeled";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main() {
  const label = parseLabel(process.argv.slice(2));

  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const rawKey = base64UrlEncode(raw);

  await waitForDb();
  const digest = hashApiKey(rawKey);
  const id = await insertKibraryKey(label, digest);

  console.log(`Kibrary API key created (id=${id}, label=${label}):`);
  console.log("");
  console.log(`    ${rawKey}`);
  console.log("");
  console.log("Save this immediately — it is shown only once. Store it in:");
  console.log("  macOS:    Keychain");
  console.log("  Linux:    libsecret (via `secret-tool store --label=\"kibrary\" service kibrary username search_raph_io`)");
  console.log("  Windows:  Credential Manager");

  await closeDb();
}

main().catch(async (err) => {
  console.error("Failed to issue Kibrary API key:", err);
  try { await closeDb(); } catch {}
  process.exit(1);
});
