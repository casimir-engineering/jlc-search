# Server Task: Raw Data Extract Architecture

## Context

You are working on `jlc-search`, a JLCPCB/LCSC parts search engine. The project is at `/root/jlc-search` on this server. The PostgreSQL DB has 3.2M parts already loaded.

**Current problem**: Every time we want to update the database (add columns, fix data, re-index), we have to re-scrape the JLCPCB API from scratch. This takes hours and hammers their API unnecessarily.

## Goal

Refactor the ingestion pipeline into two decoupled phases:

### Phase 1: Scrape → Raw JSON files (read-only archive)

- Scrape the JLCPCB API and save the **raw API responses** as JSON files to `data/raw/jlcpcb/`
- One file per page per query (e.g., `data/raw/jlcpcb/Resistors/page-001.json`, or organized by subcategory)
- Include metadata: timestamp, query params, total count, page number
- These files are the **source of truth** — never modified after writing
- The scraper should be resumable (skip already-downloaded pages)
- Store raw responses verbatim — don't transform or filter

### Phase 2: Build DB from raw files (offline, repeatable)

- Read all raw JSON files from `data/raw/jlcpcb/`
- Transform/parse into the `parts` schema (mpn, manufacturer, category, subcategory, description, stock, jlc_stock, price, pcba_type, etc.)
- Bulk upsert into PostgreSQL using the existing `unnest` pattern
- This step must be **idempotent** — running it twice produces the same result
- Should be fast since it reads local files, not the network

### Benefits
- Re-scrape only when you want fresh data from JLCPCB
- Rebuild the DB anytime (schema changes, new columns, reprocessing) without API calls
- Raw data can be inspected/debugged independently
- Can run Phase 2 with different transforms without re-downloading

## Current Architecture (to refactor)

- `ingest/src/jlcpcb-api.ts` — scrapes JLCPCB API and writes directly to DB in one pass
- `ingest/src/writer.ts` — PostgreSQL bulk upsert (unnest-based)
- `ingest/src/parser.ts` — transforms raw API data into PartRow
- `ingest/src/types.ts` — PartRow interface
- `scripts/backfill-jlc-stock.ts` — separate script that scrapes stock data and updates DB

The JLCPCB API endpoint: `POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList`
- Request: `{ keyword, firstSortName, secondSortName, pageSize, currentPage, stockFlag, componentLibraryType }`
- Response: `{ code, data: { componentPageInfo: { total, list: [...parts] } } }`
- Note: In the response, `firstSortName` = subcategory, `secondSortName` = main category (confusing naming)

## Database

- PostgreSQL at `postgres://jlc:jlc@localhost:5432/jlc` (host network mode, Docker)
- Schema in `backend/src/schema.ts` — tsvector FTS with GIN indexes
- Key columns: lcsc, mpn, manufacturer, category, subcategory, description, stock, jlc_stock, price_raw, pcba_type, part_type, moq, joints, package, attributes

## Constraints

- Use 5 parallel agents (worktrees) to implement
- Be conservative with API rate limiting — 5 concurrent requests max, 100ms delay between batches
- Raw files should compress well (gzip or just leave as JSON)
- The build step should handle 3M+ parts efficiently (batch inserts, not one-at-a-time)
- Keep the existing `backend/` and `frontend/` untouched — only refactor `ingest/` and `scripts/`
- Test by running a small category first, then verifying the DB matches

## Suggested Agent Split

1. **Agent 1: Raw scraper** — New `ingest/src/scraper.ts` that downloads raw API pages to `data/raw/jlcpcb/`. Resumable, with progress tracking.
2. **Agent 2: DB builder** — New `ingest/src/builder.ts` that reads raw files and bulk-upserts into PostgreSQL. Idempotent.
3. **Agent 3: JLC stock integration** — Merge the backfill logic into the raw data pipeline (stock data is already in the API response, no separate scrape needed).
4. **Agent 4: CLI/orchestrator** — New `ingest/src/main.ts` entry point with commands: `scrape`, `build`, `scrape+build`. Progress reporting, ETA.
5. **Agent 5: Tests + validation** — Verify raw file integrity, DB row counts match raw data, spot-check specific parts.

## How to Run

```bash
export PATH=$HOME/.bun/bin:$PATH
cd /root/jlc-search

# Install deps
cd ingest && bun install && cd ..

# Test with one small category first
bun run ingest/src/main.ts scrape --category "Fuses"
bun run ingest/src/main.ts build
bun run scripts/test-search.ts
```

## Commit when done

Git is configured. Commit your work when all tests pass.
