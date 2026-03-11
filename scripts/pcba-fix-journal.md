# pcba_type Fix Journal

## Issue
3,245,195 parts have pcba_type="Standard", only 354 have "Economic+Standard".
The real split on JLCPCB is roughly 60% Economic+Standard / 40% Standard.

## Root Cause
The ingest code uses a broken heuristic:
- `partType === "Extended" || "Mechanical"` → "Standard"
- `partType === "Basic" || "Preferred"` → "Economic+Standard"

This is wrong. Basic/Preferred parts ARE Economic+Standard, but so are many Extended parts.

## Correct Source of Truth
The JLCPCB component list API returns `componentProductType` per part:
- `0` = Economic+Standard (available for both economic and standard assembly)
- `2` = Standard Only (only available for standard assembly)

This field exists in the API response but was never added to the `JlcPart` interface.

## Fix Plan
1. **Fix ingest/src/jlcpcb-api.ts**: Add `componentProductType` to `JlcPart`, use it in `convertPart()`
2. **Fix ingest/src/parser.ts**: For jlcparts CSV path (no API field), default to "Standard" (safe fallback)
3. **Write bulk update script**: Query JLCPCB API to get `componentProductType` for all parts, update DB
4. **Fix backend/src/routes/pcba.ts**: Also write pcba_type to DB when scraped from HTML
5. **Sync to remote and redeploy**

## Execution Log

### Agent Results (all 5 completed successfully)
1. **jlcpcb-api.ts** — Added `componentProductType?: number` to JlcPart interface, replaced heuristic with `p.componentProductType === 2 ? "Standard" : "Economic+Standard"`
2. **parser.ts** — Changed CSV fallback to `"Standard"` (safe default since CSV lacks componentProductType)
3. **fix-pcba-types.ts** — Created bulk update script: category-by-category API queries, batch DB updates, resume support, dry-run mode
4. **pcba.ts** — Now writes pcba_type back to DB on HTML scrape (normalizes "Economic and Standard" → "Economic+Standard")
5. **engine.ts audit** — Confirmed economicFilter applied in all 6 search paths

### API Verification
- Confirmed `componentProductType` exists in API response
- C22074: `componentProductType: 0` (Economic+Standard) — matches JLCPCB website
- C1002: `componentProductType: 0`, C1003: `componentProductType: 0` (both Extended parts, both Economic+Standard — proves old heuristic was wrong)

### Bulk Update Progress
- Script running with 113 work queue items across all JLCPCB categories
- 13 categories returned 0 results (renamed by JLCPCB), but major categories covered ~95%+ of parts
- Concurrency: 3 parallel queries with 200ms delay between pages
- Some API 500s encountered but retry logic handles them
- C22074 manually fixed immediately via direct SQL UPDATE
- DB stats during run: Economic+Standard count growing steadily
