# /ingest — Full Ingestion Pipeline with Monitoring

You are the **orchestrator** for the complete jlc-search data ingestion pipeline. Your job is to run all ingestion phases, monitor for failures, fix issues, manage disk space, and produce a detailed journal of everything that happened.

## Pipeline Overview

```
Phase 1: Parts Ingestion (parallel)
  Agent 1: jlcparts mirror → download + process
  Agent 2: JLCPCB API → download (adaptive delay) + LCSC enrichment + process
  Agent 3: Monitor (DB counts, disk space, progress)

Phase 2: Datasheet Ingestion (sequential by category)
  export-datasheet-urls → for each category:
    download-datasheets --category "X" --keep-pdfs → process-datasheets
    check disk → compress finished categories if < 2GB free

Phase 3: Verification & Fix Loop
  Check coverage, fix errors, relaunch failed agents
  Loop until clean or no more fixable issues

Phase 4: Final Report
  Coverage stats, disk usage, compression stats, timing
```

## Detailed Instructions

### Phase 1: Parts Ingestion

#### Pre-flight
```bash
pg_isready -h localhost -p 5432
df -h /
```
Query DB state:
```sql
SELECT COUNT(*) FROM parts;
SELECT part_type, COUNT(*) FROM parts GROUP BY part_type;
```
Read the journal if it exists: `cat data/scrape-log.md 2>/dev/null`
Report the current state.

#### Launch 3 agents simultaneously:

**Agent 1 — jlcparts pipeline** (background, worktree):
```bash
~/.bun/bin/bun run ingest/src/download-jlcparts.ts
~/.bun/bin/bun run ingest/src/process-jlcparts.ts
```

**Agent 2 — JLCPCB API pipeline** (background, worktree):
The JLCPCB downloader uses **adaptive delay** (TCP-like AIMD) — it starts at 200ms and adjusts automatically. Do NOT pass `--instock-only`; download ALL parts. This will take hours.
```bash
~/.bun/bin/bun run ingest/src/download-jlcpcb.ts
~/.bun/bin/bun run ingest/src/download-lcsc.ts
~/.bun/bin/bun run ingest/src/process-jlcpcb.ts
```

**Agent 3 — Monitor** (background):
Every 5 minutes, check:
- `SELECT COUNT(*) FROM parts` — track growth
- `df -h /` — track disk usage
- Check if Agent 1 and Agent 2 output files are still growing
Log progress to the journal.

### Phase 2: Datasheet Ingestion

After Phase 1 completes (both part pipelines done):

1. **Export URLs**: `~/.bun/bin/bun run ingest/src/export-datasheet-urls.ts`

2. **Get category list from DB** (ordered by in-stock count):
```sql
SELECT category, COUNT(*) as cnt
FROM parts
WHERE datasheet IS NOT NULL AND datasheet != '' AND (stock > 0 OR jlc_stock > 0)
GROUP BY category ORDER BY cnt DESC;
```

3. **Process each category sequentially** — start with in-stock parts:
```bash
~/.bun/bin/bun run ingest/src/download-datasheets.ts --category "Resistors" --keep-pdfs
~/.bun/bin/bun run ingest/src/process-datasheets.ts
```

4. **After each category, check disk**:
```bash
FREE_GB=$(df -BG / | tail -1 | awk '{print $4}' | tr -d 'G')
```
If `FREE_GB < 2`:
- Finish processing the current category
- Compress all .pdf and .txt files for completed categories:
  ```bash
  cd data/raw/datasheets
  # Find text files for the completed category LCSCs and gzip them
  tar czf "category-Resistors.tar.gz" C*.pdf C*.txt --remove-files 2>/dev/null
  ```
  (Use the urls.ndjson to identify which LCSCs belong to which category)
- Log what was compressed to the journal
- Continue with next category if space allows

5. **After all in-stock categories**, check if disk allows out-of-stock:
```sql
SELECT COUNT(*) FROM parts WHERE datasheet IS NOT NULL AND datasheet != '' AND stock = 0 AND jlc_stock = 0;
```
If there's enough disk space (>5GB free), process out-of-stock parts too.

### Phase 3: Verification & Fix Loop

After all pipelines complete, verify:

```sql
-- Parts coverage
SELECT COUNT(*) AS total_parts FROM parts;
SELECT category, COUNT(*) FROM parts GROUP BY category ORDER BY COUNT(*) DESC LIMIT 20;
SELECT part_type, COUNT(*) FROM parts GROUP BY part_type;

-- Datasheet coverage
SELECT COUNT(*) FROM datasheet_meta;
SELECT COUNT(*) FROM parts WHERE datasheet IS NOT NULL AND datasheet != '' AND (stock > 0 OR jlc_stock > 0);

-- Check for processing gaps
SELECT COUNT(*) FROM parts WHERE search_vec IS NULL;
```

**Fix loop**: If any pipeline failed or has gaps:
1. Read the error output carefully
2. Write the diagnosis to `data/scrape-log.md` BEFORE making any fix
3. Make targeted code fixes (max 3-5 per attempt)
4. Relaunch the failed step
5. Loop until clean

### Phase 4: Relaunch App & Health Check

After all ingestion and verification is complete, restart the application and confirm it's healthy.

#### 1. Rebuild and restart services
```bash
cd /root/jlc-search
# If running via Docker:
docker compose build backend frontend 2>&1 | tail -5
docker compose up -d backend frontend 2>&1

# If running locally (dev mode):
# Kill existing processes
pkill -f "bun run src/index.ts" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
# Restart
set -a && . ./.env && set +a
cd backend && ~/.bun/bin/bun run src/index.ts &
cd ../frontend && npm run dev &
```

#### 2. Wait for backend to be ready, then health check
```bash
sleep 3
# Check backend is responding
curl -sf http://localhost:3001/api/status | python3 -m json.tool
# Check search works
curl -sf "http://localhost:3001/api/search?q=100nF&limit=3" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Search OK: {d[\"total\"]} results in {d[\"took_ms\"]}ms')
assert d['total'] > 0, 'Search returned 0 results!'
"
# Check frontend is serving (if running)
curl -sf http://localhost:3000/ | head -1 && echo "Frontend OK" || echo "Frontend not running (may be Docker-only)"
```

#### 3. If anything fails — fix loop
If the backend doesn't start or search returns errors:
1. **Capture the error**: check `docker compose logs backend --tail 50` or the process stderr
2. **Log it to the journal** with your diagnosis
3. **Launch a fix agent** to:
   - Read the error
   - Identify the root cause (schema mismatch, missing column, port conflict, dependency issue)
   - Make a targeted fix
   - Restart and re-test
4. **Loop until the health check passes**

Common issues after ingestion:
- Schema changes not applied (new tables/columns) → backend calls `applySchema()` on startup, should self-heal
- Port already in use → find and kill the old process: `lsof -i :3001`
- Frontend build stale → `cd frontend && npm run build`
- Docker image stale → `docker compose build --no-cache backend`

#### 4. Log the app status to the journal
```markdown
### App Health Check
- Backend: running / failed (error: ...)
- Search test: X results in Yms
- Frontend: running / not applicable
- Fix attempts: N (describe if any)
```

### Phase 5: Final Report

Append to `data/scrape-log.md`:

```markdown
## Ingestion Run [timestamp]

### Summary
- Total parts in DB: X
- Datasheets processed: X / Y in-stock
- Disk usage: X GB used / Y GB total
- Compressed categories: [list]
- Duration: Xh Ym

### Parts Coverage
| Source | Parts | Duration |
|--------|-------|----------|
| jlcparts | X | Xm |
| JLCPCB API | X | Xh |
| LCSC enrichment | X | Xm |

### Datasheet Coverage
| Category | In-stock | Downloaded | Processed | Compressed |
|----------|----------|------------|-----------|------------|
| Resistors | X | X | X | yes/no |
| ... | ... | ... | ... | ... |

### Disk Usage
| Path | Size |
|------|------|
| data/raw/jlcparts/ | X |
| data/raw/jlcpcb-api/ | X |
| data/raw/lcsc/ | X |
| data/raw/datasheets/ | X |
| Total | X |

### Errors & Fixes
| # | Phase | Error | Fix | Result |
|---|-------|-------|-----|--------|
| 1 | ... | ... | ... | ... |

### Adaptive Delay Stats
- Start delay: 200ms
- Final delay: Xms
- Rate limit events: X
- Timeout events: X

### App Health Check
- Backend: running / restarted after fix
- Search test: X results in Yms for "100nF"
- Frontend: running / Docker-only
- Fix attempts: 0

### Self-Reflection
- What worked well
- What to improve for next run
```

## Key Constraints

- **Journal first, fix second**: Always log the error and your reasoning in `data/scrape-log.md` BEFORE making any code change or relaunching
- **Disk space is sacred**: Monitor continuously. Compress when < 2GB free. Never let disk fill completely.
- **Keep PDFs**: Always pass `--keep-pdfs` to download-datasheets
- **Resume, don't restart**: All scripts support resume. Never delete progress files unless corrupt.
- **Max 3-5 code changes per fix attempt**: If more are needed, start fresh
- **Adaptive delay**: The JLCPCB downloader handles pacing automatically — don't override with fixed delays
- **Target**: ~7M total parts indexed across all sources
- **Database**: `postgres://jlc:jlc@localhost:5432/jlc`
- **Bun binary**: `~/.bun/bin/bun`
