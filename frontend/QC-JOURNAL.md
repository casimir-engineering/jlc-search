# Cart/BOM Feature — QC Journal

## Round 1-3: Cart feature (completed)
Built cart/BOM, removed favorites button, fixed cart toggle.

## Round 4: Data quality — joints (completed)

**Root cause:** `encapsulationNumber` from JLCPCB API = packaging qty (reel/tube size), NOT pad count.
**Fix applied:**
- `ingest/src/jlcpcb-api.ts`: set `joints: null` (API doesn't provide pad count)
- DB: `UPDATE parts SET joints = NULL WHERE description != ''` (3.2M rows cleared)
- jlcparts-sourced parts (18k, empty description) retain correct pad counts

## Round 5: MOQ fix — end-to-end

### Problem
JLCPCB API has `minPurchaseNum` field with correct MOQ, but we don't store it.
Price tiers always start at `startNumber: 1`, so `getMoq()` returns 1 for all API parts.
jlcparts data had MOQ in attributes JSON but it wasn't extracted to a column.

### Plan — 5 agents in parallel

**Agent 1: Schema + types** (backend)
- Add `moq INTEGER` column to `backend/src/schema.ts` parts table
- Add `moq` to `ingest/src/types.ts` PartRow interface
- Run `ALTER TABLE parts ADD COLUMN IF NOT EXISTS moq INTEGER;`

**Agent 2: Ingest code** (JLCPCB API)
- In `ingest/src/jlcpcb-api.ts`: add `minPurchaseNum` to JlcPart interface, store as `moq` in convertPart()
- In `ingest/src/writer.ts`: add `moq` to COLUMNS array and upsert ON CONFLICT clause

**Agent 3: Backend API**
- In `backend/src/search/engine.ts`: add `p.moq` to SELECT_COLS
- In `backend/src/routes/part.ts`: ensure moq is included in part detail responses

**Agent 4: Frontend types + display**
- Add `moq: number | null` to `PartSummary` in `frontend/src/types.ts`
- Update `getMoq()` in `frontend/src/utils/price.ts` to accept optional moq param, prefer it over price-tier derivation
- Update `PartCard.tsx` qty input to use part.moq when available
- Update `CartSummary` and any other consumers

**Agent 5: Backfill existing data**
- Extract MOQ from jlcparts attributes JSON for parts that have it
- SQL: parse `attributes->'MOQ'->'values'->'default'->0` for jlcparts parts
- For API parts without moq: leave NULL (will be populated on next ingest run)

### Rationale
- Parallel agents because schema/types, ingest, backend API, frontend, and backfill are independent workstreams
- Each agent has a narrow scope to avoid conflicts
- Backfill is best-effort — jlcparts only covers 18k parts; full coverage needs re-ingest
