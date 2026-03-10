# jlc-search

Fast offline search engine for JLCPCB/LCSC electronic components. Indexes 446k+ parts with full-text search, numeric range filtering, and attribute-enriched search.

## Quick Start

```bash
# Backend (port 3001)
cd backend && bun run src/index.ts

# Frontend (port 3000, proxies /api/ to backend)
cd frontend && bun run dev --port 3000
```

Requires a pre-built SQLite database at `data/parts.db` (see [Data Ingestion](#data-ingestion)).

## Search Syntax

### Text Search

Type keywords to search across part numbers, manufacturer names, descriptions, packages, subcategories, and flattened attributes:

| Query | What it finds |
|-------|--------------|
| `C22074` | Exact LCSC code lookup |
| `RC0402JR-0710KL` | MPN search |
| `100nF 0402 ceramic` | Keyword search across all fields |
| `10kOhm 0402` | Attribute-enriched search (resistance value) |
| `1.25 picoblade horizontal smd` | Multi-token connector search |

Text tokens are AND-matched by default with automatic fallback: unmatched tokens are dropped progressively, then OR semantics are tried.

### Range Filters

Filter parts by numeric attribute values using `UNIT:OPERATOR_VALUE` syntax. SI prefixes are supported (G, M, k, m, u, n, p):

| Syntax | Meaning |
|--------|---------|
| `V:>25` | Voltage greater than 25V |
| `V:-15->20` | Voltage between -15V and 20V |
| `Ohm:<2m` | Resistance less than 2 milliohms |
| `F:100n->1u` | Capacitance between 100nF and 1uF |
| `W:>=0.25` | Power rating at least 250mW |

**Supported units:** `V` (voltage), `Ohm` (resistance), `F` (capacitance), `A` (current), `H` (inductance), `W` (power), `Hz` (frequency), `pads` (solder pad count)

**Operators:** `>`, `>=`, `<`, `<=`, `=`, `min->max` (range)

**SI prefixes:** `G` (giga), `M` (mega), `k` (kilo), `m` (milli), `u` (micro), `n` (nano), `p` (pico)

### Combining Text and Range Filters

Text and range filters can be freely mixed. Text tokens go to FTS5, range filters go to indexed numeric lookups:

```
capacitor F:100n->1u V:>25    # MLCC capacitors, 100nF-1uF, >25V rated
Ohm:10k->100k W:>0.25         # 10k-100k resistors, >250mW
picoblade pads:4               # PicoBlade connectors with 4 solder pads
connector pads:4->8            # Connectors with 4 to 8 solder pads
```

### Logical Operators

Multiple range filters are AND-combined by default. Use `|` for OR:

```
Ohm:10k->100k W:>0.25       # resistance 10k-100k AND power >250mW
V:>50 | V:<-50               # voltage >50V OR voltage <-50V
```

### UI Filters

- **Part type:** Basic, Preferred, Extended, Mechanical
- **In stock only:** Filter to parts with stock > 0
- **Fuzzy search:** LIKE-based fallback for partial matches
- **Sort by:** Relevance, Price (asc/desc), Stock (asc/desc)
- **Pagination:** Navigate through result pages

## Architecture

```
frontend/          Vite + React SPA
backend/           Bun + Hono API server
  src/search/
    parser.ts      Query parsing, FTS query building, range filter parsing
    engine.ts      Search orchestration, BM25 ranking, boost logic
  src/routes/      API route handlers
  src/schema.ts    SQLite DDL (parts, parts_fts, part_nums tables)
ingest/            Data ingestion pipeline
  src/attrs.ts     Attribute flattening + SI formatting
  src/parser.ts    jlcparts JSON → PartRow mapping
  src/writer.ts    Bulk insert with FTS triggers
data/parts.db      SQLite database (~875MB)
```

### Search Pipeline

1. **Query parsing** — split into text tokens and range filters
2. **Range filter materialization** — pre-compute matching LCSCs into temp table
3. **FTS5 lookup** — BM25-weighted full-text search across 7 columns
4. **Smart fallback** — drop zero-match tokens, then try OR semantics
5. **Boost re-ranking** — exact match bonus, part type preference, LCSC canonical ordering
6. **Sort** — relevance (default), price, or stock

### FTS5 Column Weights

| Column | Weight | Purpose |
|--------|--------|---------|
| lcsc | 10 | LCSC part code |
| mpn | 8 | Manufacturer part number |
| description | 5 | Part description |
| subcategory | 4 | Part subcategory |
| search_text | 3 | Flattened attributes (SI values, tolerances, etc.) |
| manufacturer | 3 | Manufacturer name |
| package | 2 | Package/footprint |

## Data Ingestion

Uses [jlcparts](https://yaqwsx.github.io/jlcparts/) preprocessed data:

```bash
# Full ingest from jlcparts cache
bun run ingest/src/main.ts

# Rebuild FTS index only
bun run ingest/src/rebuild-fts.ts

# Backfill search_text from attributes
bun run ingest/src/enrich-search-text.ts

# Populate numeric range filter table
bun run ingest/src/populate-part-nums.ts
```

## Docker

```bash
docker compose up --build
```

Three services: `frontend` (nginx, port 80), `backend` (Bun, port 3001), `ingest` (one-shot).

> **Note:** Docker port forwarding may fail with UFW/nftables firewalls. Use `make dev` for local development or add `network_mode: "host"` to docker-compose services.
