# Raph Search (jlc-search)

Fast search engine for JLCPCB/LCSC electronic components. Indexes 3.5M+ parts with full-text search, numeric range filtering, datasheet property extraction, and live stock/price updates.

**Live:** [search.raph.io](https://search.raph.io)

## Features

- **3.5M+ parts** from JLCPCB and LCSC with dual-source stock tracking
- **Instant search** across part numbers, descriptions, manufacturers, and extracted attributes
- **Range filters** — `V:>25`, `Ohm:10k->100k`, `F:100n->1u`, `pads:4`
- **Category filter** — multi-select dropdown for all 96 JLCPCB categories
- **Datasheet indexing** — PDF text extraction with component-aware property parsing (42 extractors across 20+ categories)
- **Schematic & footprint previews** — rendered from EasyEDA data
- **Product photos** — 3-tier image source with rotation (JLCPCB API, LCSC CDN, wsrv.nl proxy)
- **BOM builder** — favorites list with quantity input, price tier calculation, CSV export
- **HTTPS** with Let's Encrypt auto-renewal via Nginx Proxy Manager

## Quick Start

```bash
git clone https://github.com/casimir-engineering/jlc-search.git
cd jlc-search
./setup.sh your-domain.com
```

See [SETUP.md](SETUP.md) for detailed setup instructions.

## Search Syntax

| Query | What it finds |
|-------|--------------|
| `C22074` | Exact LCSC code lookup |
| `RC0402JR-0710KL` | MPN search |
| `100nF 0402 ceramic` | Keyword search across all fields |
| `0603 Ohm:10->50` | 0603 resistors, 10–50Ω range |
| `capacitor F:100n->1u V:>25` | MLCC caps, 100nF–1µF, >25V |
| `PADAUK -OTP` | Exclude term |
| `"Thick Film"` | Exact phrase |

**Range filter units:** `V`, `Ohm`/`Ω`, `F`, `A`, `H`, `W`, `Hz`, `pads`
**SI prefixes:** `G`, `M`, `k`, `m`, `u`, `n`, `p`
**Operators:** `>`, `<`, `=`, `min->max`

## Architecture

```
PostgreSQL 17 ← parts, part_nums, datasheet_meta, ingest_meta
     ↑
Backend (Bun + Hono, port 3001) ← tiered FTS + trigram search
     ↑
Frontend (React + Vite → Nginx, port 8080)
     ↑
Nginx Proxy Manager (ports 80/443, HTTPS, Let's Encrypt)
```

See [CLAUDE.md](CLAUDE.md) for full project architecture documentation.

## Data Sources

| Source | Parts | Method |
|--------|-------|--------|
| [jlcparts mirror](https://yaqwsx.github.io/jlcparts/) | 3.2M | Hash-based incremental download |
| JLCPCB API | 3.3M | Adaptive-delay page crawler |
| LCSC API | Enrichment | MOQ, pricing, stock overlay |
| Datasheets | 6.7k+ PDFs | pdftotext + regex property extraction |

## Development

```bash
make dev          # Start PostgreSQL + backend + frontend
make download     # Download all raw data (no DB needed)
make process      # Process raw data into PostgreSQL
make datasheets   # Full datasheet pipeline
```

## Deployment

```bash
./setup.sh your-domain.com   # One-command production deploy
make configure-npm            # SSL setup via Nginx Proxy Manager
```

See [SETUP.md](SETUP.md) for the full deployment guide.

## Kibrary API (auth-gated)

Auth-gated mirror of the public search API for the [Kibrary](https://github.com/jazari-akuna/kibrary-automator) desktop client. Same backend, Bearer-key gated, per-key rate-limited.

```
GET /api/kibrary/search?q=<query>           # 60 req/min/key
GET /api/kibrary/parts/:lcsc                # 600 req/min/key
GET /api/kibrary/parts/:lcsc/photo          # 600 req/min/key
GET /api/kibrary/parts/batch?lcsc=C1,C2,…   # 600 req/min/key, 100-LCSC cap
```

All routes require `Authorization: Bearer <api-key>`. Search responses include extra `photo_url` and `in_stock` fields per result. The batch endpoint returns a keyed map (`{ parts: { "C1525": {...}, "Cmissing": null } }`), distinct from the public `/api/parts/batch` which returns an array.

Mint a key:

```bash
bun run scripts/issue-kibrary-key.ts --label kibrary-prod
```

The raw key is printed once to stdout; only its `scrypt` hash is stored in the `kibrary_api_keys` table. To revoke, set `revoked_at` on the row.

## License

MIT
