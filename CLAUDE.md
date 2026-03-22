# CLAUDE.md — jlc-search Project Architecture

## Overview

jlc-search is a fast offline search engine for JLCPCB/LCSC electronic components (446k+ parts). PostgreSQL backend, React/Vite frontend, Bun runtime. Full-text search with numeric range filtering, dual-source stock tracking, and datasheet indexing.

## Tech Stack

- **Backend**: Bun + Hono (HTTP) + PostgreSQL (pg_trgm + tsvector)
- **Frontend**: React 18 + Vite, CSS (no Tailwind)
- **Ingest**: Bun scripts with download/process separation
- **Deploy**: Docker Compose (PostgreSQL, backend, frontend, nginx proxy manager)

## Directory Structure

```
jlc-search/
├── backend/src/           # API server (Bun + Hono)
│   ├── index.ts           # Server bootstrap, CORS, rate limiting
│   ├── db.ts              # PostgreSQL connection pool
│   ├── schema.ts          # DDL: parts, part_nums, datasheet_meta, ingest_meta tables
│   ├── types.ts           # PartRow, PartSummary, SearchParams, SearchResponse
│   ├── search/
│   │   ├── engine.ts      # Search orchestration: FTS + trigram + boosting + pagination
│   │   └── parser.ts      # Query parser: tokens, phrases, ranges (V:>25), negations
│   ├── routes/
│   │   ├── search.ts      # GET /api/search — main search endpoint
│   │   ├── part.ts        # GET /api/parts/:lcsc, /api/parts/batch
│   │   ├── status.ts      # GET /api/status — DB stats
│   │   ├── img.ts         # GET /api/img/:lcsc — image proxy (LCSC CDN, cached)
│   │   ├── fp.ts          # GET /api/fp/:lcsc — footprint SVG (EasyEDA → KiCad style)
│   │   ├── sch.ts         # GET /api/sch/:lcsc — schematic SVG
│   │   └── pcba.ts        # GET /api/pcba/:lcsc — PCBA assembly info
│   ├── refresh-limiter.ts # Rate limiting for background API refreshes
│   ├── lcsc.ts            # Fire-and-forget LCSC stock/price refresh
│   └── jlcpcb-stock.ts    # Fire-and-forget JLCPCB stock refresh
│
├── frontend/src/           # React SPA
│   ├── App.tsx            # Main: search, favorites, cart, BOM mode
│   ├── api.ts             # HTTP client: searchParts(), fetchPartsByIds()
│   ├── types.ts           # Frontend types
│   ├── hooks/
│   │   ├── useSearch.ts   # Search state, debounce, pagination, URL sync
│   │   ├── usePersistedFilters.ts  # localStorage filter persistence
│   │   ├── useFavorites.ts         # Favorite parts (localStorage)
│   │   ├── useCart.ts              # Shopping cart with MOQ rounding
│   │   └── useLiveRefresh.ts      # Real-time stock/price updates
│   ├── components/
│   │   ├── SearchBar.tsx, FilterBar.tsx, ResultsList.tsx, PartCard.tsx
│   │   ├── PriceTable.tsx, CartSummary.tsx, StatusBar.tsx
│   │   └── ...
│   └── utils/
│       ├── price.ts       # Price tier parsing and calculation
│       ├── share.ts       # BOM URL encoding/decoding
│       └── bom.ts         # BOM CSV export/import
│
├── ingest/src/             # Data ingestion pipeline
│   ├── # --- Download phase (no DB needed) ---
│   ├── downloader.ts      # HTTP fetch + atomic file write helpers
│   ├── download-jlcparts.ts   # jlcparts mirror → data/raw/jlcparts/
│   ├── download-jlcpcb.ts    # JLCPCB API → data/raw/jlcpcb-api/pages/
│   ├── download-lcsc.ts      # LCSC enrichment → data/raw/lcsc/enrichment.ndjson
│   ├── download-datasheets.ts # PDF download + text extraction → data/raw/datasheets/
│   ├── export-datasheet-urls.ts # DB → data/raw/datasheets/urls.ndjson
│   │
│   ├── # --- Process phase (needs PostgreSQL) ---
│   ├── process-jlcparts.ts   # Raw jlcparts files → PostgreSQL
│   ├── process-jlcpcb.ts     # JLCPCB pages + LCSC enrichment → PostgreSQL
│   ├── process-datasheets.ts  # Extracted text → properties + keywords → DB
│   │
│   ├── # --- Backward-compatible wrappers ---
│   ├── ingest.ts          # download-jlcparts → process-jlcparts
│   ├── jlcpcb-api.ts      # download-jlcpcb → download-lcsc → process-jlcpcb
│   │
│   ├── # --- Shared modules ---
│   ├── storage.ts         # Path constants for data/raw/ structure
│   ├── reader.ts          # File I/O: read index, manifests, NDJSON, gzipped data
│   ├── writer.ts          # DB writes: bulkInsertParts, bulkUpdateStock, search trigger mgmt
│   ├── types.ts           # PartRow, JlcpartsIndex, manifests, DatasheetMeta, etc.
│   ├── parser.ts          # jlcparts JSON array → PartRow
│   ├── attrs.ts           # Attribute extraction: SI units, numeric values, search text
│   ├── component-text.ts  # Source-agnostic text → properties (datasheets, descriptions)
│   ├── pdf-extract.ts     # pdftotext/pdfinfo wrapper (Bun.spawn)
│   ├── jlcpcb-shared.ts   # JLCPCB API types, constants, fetchPage, convertPart
│   └── chinese-dict.ts    # Chinese→English translation (291 entries)
│
├── scripts/                # One-off migration and backfill scripts
│   ├── migrate-sqlite-to-pg.ts    # SQLite → PostgreSQL migration
│   ├── backfill-jlc-stock.ts      # Bulk backfill jlc_stock from JLCPCB API
│   ├── fix-pcba-types.ts          # Update pcba_type from JLCPCB API
│   ├── test-ingest.ts, test-search.ts  # Integration tests
│   └── ...
│
├── .claude/commands/
│   └── scrape.md          # /scrape slash command: parallel ingestion orchestrator
│
├── data/                   # All runtime data (gitignored)
│   ├── raw/               # Downloaded raw data
│   │   ├── jlcparts/      # index.json, hashes.json, categories/*.json.gz
│   │   ├── jlcpcb-api/    # manifest.json, pages/{slug}/page-NNN.json
│   │   ├── lcsc/          # enrichment.ndjson
│   │   └── datasheets/    # urls.ndjson, manifest.json, {LCSC}.txt
│   └── img/               # Cached product images ({LCSC}.jpg)
│
├── docker-compose.yml     # Services: db, backend, frontend, npm, ingest
├── Makefile               # dev, pg, download, process, ingest, datasheets, build, deploy
└── .env.example           # DATABASE_URL, POSTGRES_PASSWORD, ALLOWED_ORIGINS, DOMAIN
```

## Database Schema

### `parts` — Main table (PK: `lcsc`)
Core: `lcsc`, `mpn`, `manufacturer`, `category`, `subcategory`, `description`, `package`
Stock: `stock` (LCSC), `jlc_stock` (JLCPCB)
Pricing: `price_raw` ("1-10:0.005,11-50:0.004,..."), `moq`
Classification: `part_type` (Basic/Preferred/Extended), `pcba_type` (Standard/Economic+Standard)
Assets: `datasheet` (URL), `img` (filename), `url` (product page)
Search: `attributes` (JSONB), `search_text`, `search_vec` (tsvector), `full_text` (trigram)
Indexes: GIN(search_vec), GIN trigram(mpn, manufacturer, full_text), B-tree(part_type, stock, jlc_stock, category)
Trigger: `trg_parts_search_vec` builds weighted tsvector on INSERT/UPDATE

### `part_nums` — Numeric attributes for range filtering
`lcsc`, `unit` (V/Ohm/F/A/H/W/Hz), `value` (double precision)
Indexes: (unit, value), (lcsc)

### `datasheet_meta` — Datasheet extraction tracking
`lcsc` (PK, FK→parts), `extracted_at`, `page_count`, `char_count`, `props_found`

### `ingest_meta` — Ingestion progress tracking
PK: (category, subcategory), `sourcename`, `datahash`, `stockhash`, `ingested_at`

## Search Architecture

4-tier search with client-side boost re-ranking:
1. **Tier 0**: PostgreSQL FTS prefix match on `search_vec` (weighted A-D)
2. **Tier 0.5**: N-1 token fallback (drops longest token)
3. **Tier 1a**: Manufacturer trigram substring (ILIKE)
4. **Tier 1b**: Full-text trigram substring (ILIKE on `full_text`)

Boost factors: exact LCSC (+1000), exact MPN (+800), MPN prefix (+400), part type bonus, LCSC recency

Filters: `partType[]`, `stockFilter` (none/jlc/lcsc/any), `economic`, range filters via `part_nums`

## Ingestion Pipeline

Three data sources, each with download→process separation:

```
Source              Download Script          Raw Storage                    Process Script
─────────────────────────────────────────────────────────────────────────────────────────
jlcparts mirror     download-jlcparts.ts     data/raw/jlcparts/            process-jlcparts.ts
JLCPCB API          download-jlcpcb.ts       data/raw/jlcpcb-api/pages/    process-jlcpcb.ts
LCSC enrichment     download-lcsc.ts         data/raw/lcsc/enrichment.ndjson (merged in process-jlcpcb)
Datasheets          download-datasheets.ts   data/raw/datasheets/*.txt     process-datasheets.ts
```

Download phase: network-only, no DB. Supports `--fresh`, `--limit`, `--category`, resume via manifests/hashes.
Process phase: reads from disk, writes to PostgreSQL. Crash recovery via `ingest_meta` hash tracking.

## Makefile Targets

```
make dev              # PostgreSQL + backend + frontend (local dev)
make pg               # Start PostgreSQL only
make download         # Download all sources (no DB needed)
make process          # Process all sources (needs pg)
make ingest           # Docker ingest container (backward compat)
make datasheets       # export-datasheet-urls → download-datasheets → process-datasheets
make build / up / down  # Docker compose operations
make deploy           # Production deployment
```

## Key Patterns

- **Upserts**: All inserts use `ON CONFLICT (lcsc) DO UPDATE` — safe to run any source in any order
- **Search trigger**: Disabled during bulk inserts, rebuilt after — `disableSearchTrigger()` / `enableSearchTrigger()` / `rebuildSearchVectors()`
- **SIGINT handling**: All scripts trap Ctrl+C, finish in-flight work, save progress
- **Atomic file writes**: Download to `.tmp` then rename for crash safety
- **Image proxy**: On-demand fetch from LCSC CDN with 24h cooldown on failures
- **Fire-and-forget refresh**: Part detail requests trigger background LCSC/JLCPCB API calls (rate-limited, deduped)

## Component Text Extraction (`component-text.ts`)

Source-agnostic extractor: works with datasheets, descriptions, or any text.
Category-specific regex extractors (42 functions, 4036 lines):
- **Resistors**: tolerance (most-frequent), TCR, power rating, max voltage
- **Capacitors**: ESR, dissipation factor, ripple current, temp coeff keywords (X7R/C0G/NP0)
- **Inductors**: DCR/RDC, Isat, Irms, SRF (inline + table scanner for multi-line headers)
- **Diodes**: VF, VRRM, VBR, VZ (Zener), trr, IF(AV)
- **Transistors/MOSFETs**: VDS, RDS(on), Qg, Id, Vgs(th)
- **ICs**: Vcc range (widest-range logic), Iq, protocol keywords
- **Connectors**: current/voltage rating, pitch, contact resistance, mating cycles, IP rating
- **Circuit Protection**: TVS (VRWM, VBR, VC, IPP), fuses (rated current, I²t), PTC (hold/trip), varistors (V1mA, energy), GDT (sparkover)
- **Crystals/Oscillators**: frequency, load capacitance, tolerance/stability (ppm), ESR, supply voltage
- **Optoelectronics**: VF, wavelength, luminous intensity, viewing angle, CTR, isolation, dark current, color keywords
- **Sensors**: NTC (R25, B-value), temperature accuracy, pressure range, Hall (BOP/BRP), current sensitivity
- **Switches**: contact rating, contact resistance, mechanical life, actuation force, travel
- **Relays**: coil voltage/resistance/power, contact rating, operate/release time, electrical/mechanical endurance
- **Memory**: capacity (Kbit-Gbit), organization, clock speed, endurance, retention, access time
- **Logic**: propagation delay, IOH/IOL, max frequency, gate count, logic family keywords
- **Power**: Vin/Vout range, Iout, efficiency, Iq, switching freq, dropout, isolation, topology keywords
- **Filters**: impedance@freq, DCR, rated current, insertion loss, bandwidth, cutoff frequency
- **RF/Wireless**: TX power, RX sensitivity, gain, noise figure, P1dB, IP3, frequency range
- **Audio**: SPL, resonant frequency, impedance, sensitivity, SNR
- **Displays**: resolution, display size, brightness, contrast ratio, driver IC keywords
- **IoT Modules**: TX power, RX sensitivity, frequency band, supply voltage, chipset/protocol keywords

Table-aware: `scanTable()` handles pdftotext -layout multi-line headers (8-line window).
Spec-row scanner: `scanSpecRow()` strips test conditions, skips pin assignments, multi-line fallback.

## Search Architecture

4-tier search with client-side boost re-ranking:
1. **Tier 0**: PostgreSQL FTS prefix match on `search_vec` (weighted A-D), LIMIT 500
2. **Tier 0.5**: N-1 token fallback (drops longest token)
3. **Tier 1a**: Manufacturer trigram substring (ILIKE)
4. **Tier 1b**: Full-text trigram substring — skipped when Tier 0 saturates

Performance optimizations:
- **EXPLAIN estimate** for total count (34ms vs 430ms COUNT(*))
- **Skip prefix matching** on 1-2 char tokens (avoids GIN posting list explosion)
- **No attributes JSONB** in search SELECT (9x faster per query)
- **80ms debounce** on frontend (was 500-1000ms)
- **content-visibility: auto** on PartCards
- **Deep pagination** via SQL OFFSET for stock/price sorts beyond tier limits
- **30s Cache-Control** with stale-while-revalidate on search responses
- **Gzip** on nginx for JSON/SVG/JS/CSS responses

## Image System

3-tier source rotation with health tracking:
1. **JLCPCB accessId API** — queries `selectSmtComponentList` for `productBigImageAccessId`, downloads via `downloadByFileSystemAccessId`. ~80% coverage, no IP block.
2. **Direct LCSC CDN** — `assets.lcsc.com/images/lcsc/900x900/`. Works if not IP-blocked.
3. **wsrv.nl proxy** — free image proxy, bypasses CDN IP blocks. 100% coverage.

Health tracking: after 3 consecutive failures a source is deprioritized (tried last). Re-checked every 10 minutes. Round-robin rotation among healthy sources.

Schematic/footprint SVGs rendered from EasyEDA API data, cached to disk. Content-Length set explicitly via `new Response()` to avoid Hono middleware timing issue.

## Frontend Features

- **Search highlighting**: `<mark>` tags on MPN, description, manufacturer, attribute values
- **Range filter badges**: matched values (e.g., "22Ω") shown as gold badges next to package
- **Mobile lightbox**: tap images to open centered overlay with dismiss
- **Category multi-select**: chip dropdown with search, counts, clear-all
- **Stock/sort dropdowns**: ChipSelect component with Unicode ▼ arrows
- **Donate bar**: thin amber bar at top, links to /donate page (SPA routing)
- **Donate page**: Patreon, WeChat Pay, Alipay QR codes, TWINT button

## Deployment

One-command deploy: `./setup.sh your-domain.com`
- Installs Docker, generates passwords, builds images, starts services
- SSL via Nginx Proxy Manager + Let's Encrypt (auto-renewing)
- See `SETUP.md` for full guide, `DEPLOY.md` for architecture details

## Skills

- `/ingest` — Full ingestion pipeline orchestrator (download → process → datasheets → app relaunch → health check)
- `/scrape` — Parallel scraper outer loop with monitoring agents

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection | `postgres://jlc:jlc@localhost:5432/jlc` |
| `PORT` | Backend port | `3001` |
| `ALLOWED_ORIGINS` | CORS origins | `http://localhost:3000` |
| `JLCPARTS_BASE` | jlcparts mirror URL | `https://yaqwsx.github.io/jlcparts` |
| `INGEST_CONCURRENCY` | Parallel download workers | `4` |
| `VITE_API_BASE` | Frontend API base URL | `` (relative) |
| `DOMAIN` | Production domain for SSL | — |
| `NPM_ADMIN_EMAIL` | Nginx Proxy Manager admin email | — |
| `NPM_ADMIN_PASS` | NPM admin password | Auto-generated |
| `LETSENCRYPT_EMAIL` | Let's Encrypt certificate email | — |
