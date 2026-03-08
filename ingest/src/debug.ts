// Debug: test parseComponent on real data
import { gunzipSync } from "bun";
import { parseComponent } from "./parser.ts";

const BASE = "https://yaqwsx.github.io/jlcparts";

async function main() {
  const indexRes = await fetch(`${BASE}/data/index.json`);
  const index = await indexRes.json() as {
    categories: Record<string, Record<string, { sourcename: string }>>
  };

  const [cat, subcats] = Object.entries(index.categories)[0];
  const [subcat, meta] = Object.entries(subcats)[0];

  const res = await fetch(`${BASE}/data/${meta.sourcename}.json.gz`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const decompressed = gunzipSync(buf);
  const data = JSON.parse(new TextDecoder().decode(decompressed)) as {
    schema: string[];
    components: unknown[][];
  };

  console.log(`Parsing: ${cat} / ${subcat}, ${data.components.length} parts`);

  const parsed = parseComponent(data.schema, data.components[0], cat, subcat);
  console.log("\nParsed first component:");
  for (const [k, v] of Object.entries(parsed)) {
    const display = k === "attributes" ? "(JSON blob)" : JSON.stringify(v);
    const type = typeof v;
    const ok = v === null || ["string", "number", "boolean"].includes(type) ? "✓" : "✗ OBJECT!";
    console.log(`  ${ok} ${k} (${type}): ${display?.slice(0, 80)}`);
  }
}

main().catch(console.error);
