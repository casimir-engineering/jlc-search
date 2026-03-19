# /scrape — JLCPCB Parts Ingestion Outer Loop

You are the **outer loop controller** for the jlc-search scraping pipeline. Your job is to run the scraping jobs, handle failures, and maximize part coverage.

## Scrapers

The pipeline is split into download (no DB needed) and process (needs DB) phases:

### Download scripts (network only, no DB)
1. **jlcparts download** (`ingest/src/download-jlcparts.ts`) — Downloads from the jlcparts community mirror to `data/raw/jlcparts/`. Run with: `~/.bun/bin/bun run ingest/src/download-jlcparts.ts`
2. **JLCPCB API download** (`ingest/src/download-jlcpcb.ts`) — Downloads from JLCPCB's API to `data/raw/jlcpcb-api/`. Supports resume via manifest. Run with: `~/.bun/bin/bun run ingest/src/download-jlcpcb.ts`
3. **LCSC enrichment download** (`ingest/src/download-lcsc.ts`) — Downloads LCSC product details to `data/raw/lcsc/enrichment.ndjson`. Requires JLCPCB download first. Run with: `~/.bun/bin/bun run ingest/src/download-lcsc.ts`

### Process scripts (needs PostgreSQL)
4. **jlcparts process** (`ingest/src/process-jlcparts.ts`) — Reads raw files and populates DB. Run with: `~/.bun/bin/bun run ingest/src/process-jlcparts.ts`
5. **JLCPCB process** (`ingest/src/process-jlcpcb.ts`) — Reads page files + LCSC enrichment and populates DB. Run with: `~/.bun/bin/bun run ingest/src/process-jlcpcb.ts`

### Combined wrappers (backward compatible)
- `ingest/src/ingest.ts` — runs download-jlcparts → process-jlcparts
- `ingest/src/jlcpcb-api.ts` — runs download-jlcpcb → download-lcsc → process-jlcpcb

All scrapers share the same PostgreSQL database and use `ON CONFLICT DO UPDATE` upserts, so they're safe to run in any order.

## Outer Loop Protocol

### 1. Pre-flight Check

Before starting any scraper:
- Verify PostgreSQL is running: `pg_isready -h localhost -p 5432`
- Check current DB state: connect and run `SELECT COUNT(*) FROM parts`
- Check for prior manifest (`data/raw/jlcpcb-api/manifest.json`)
- Read the outer loop log (`data/scrape-log.md`) if it exists, to learn from prior runs
- Report the current state to the user

### 2. Run Scrapers (3 agents in parallel)

Launch **3 agents simultaneously**:

1. **Agent 1 — jlcparts pipeline**: Run in a background subagent with `isolation: "worktree"`. Run download-jlcparts.ts then process-jlcparts.ts.
2. **Agent 2 — JLCPCB pipeline**: Run in a background subagent with `isolation: "worktree"`. Run download-jlcpcb.ts then download-lcsc.ts then process-jlcpcb.ts.
3. **Agent 3 — Coverage monitor**: Run in the background. Periodically checks `SELECT COUNT(*) FROM parts` and reports progress. Probes the JLCPCB API for total available parts per category to calculate real-time coverage.

Each scraper agent should:
- Run the scraper command and capture its full stdout/stderr
- Watch for errors, crashes, or stalls
- If the scraper exits cleanly, report stats back
- If the scraper crashes or stalls, capture the error output

Both pipelines write to the same PostgreSQL database with upserts, so running in parallel is safe.

### 3. On Failure — Diagnose and Fix

When a scraper fails:

1. **Read the error output** carefully
2. **Classify the failure**:
   - Network error (timeout, DNS, connection refused) → adjust delay, retry
   - API error (HTTP 429 rate limit, 403 forbidden, 500 server error) → increase delay, back off
   - Parse error (unexpected API response shape) → fix parsing code
   - Database error (connection lost, constraint violation) → fix query or connection handling
   - OOM / process killed → reduce batch size or concurrency
3. **Make targeted code fixes** (max 3-5 changes per worktree)
4. **Log the failure and fix** to `data/scrape-log.md`
5. **Restart** in a new subagent

If you've made 3-5 code changes in the current worktree without success, **abandon the worktree** and start a new one from main. Cherry-pick or re-apply only the fixes that were clearly correct.

### 4. Coverage Tracking

After each successful scraper run, check coverage:

```sql
SELECT COUNT(*) AS total_parts FROM parts;
SELECT part_type, COUNT(*) AS cnt FROM parts GROUP BY part_type ORDER BY cnt DESC;
SELECT category, COUNT(*) AS cnt FROM parts GROUP BY category ORDER BY cnt DESC LIMIT 20;
```

Compare against known JLCPCB totals (probe the API for each category's total) and report:
- Parts fetched vs total available
- Categories fully covered vs partially covered (capped at 100k)
- In-stock coverage percentage

### 5. Completion Criteria

The job is "done" when:
- Both pipelines have run to completion (all categories processed)
- No more retryable errors remain
- Coverage report has been generated

### 6. Final Report

When done, produce a report in `data/scrape-log.md` containing:

1. **Coverage stats**: total parts in DB, parts per category, coverage vs available
2. **Failure log**: every failure encountered, root cause, and fix applied
3. **Failure modes catalog**: all failure types seen, with mitigations for future runs
4. **Timing**: how long each scraper took, pages/second, parts/second
5. **Self-reflection**: suggestions for improving this `/scrape` skill for future runs — what worked, what was clunky, what should change

## Outer Loop Log Format

Append to `data/scrape-log.md`:

```markdown
## Run [timestamp]

### Pre-flight
- DB parts: X
- Manifest: exists/absent
- Prior failures: ...

### Attempt N
- Scraper: download-jlcpcb / download-lcsc / process-jlcpcb / download-jlcparts / process-jlcparts
- Duration: Xm
- Result: success / failure
- Error: (if failed) ...
- Fix applied: (if any) ...
- Code changes: (file:line — description)
- Parts after: X

### Coverage Report
| Category | Available | Fetched | Coverage |
|----------|-----------|---------|----------|
| ...      | ...       | ...     | ...      |

### Failure Modes Catalog
1. **[type]**: description, mitigation

### Self-Reflection
- ...
```

## Key Constraints

- **Max 3-5 code changes per worktree** before starting fresh
- **Always use subagents** for running scrapers — never block the outer loop
- **Always log** before retrying — don't silently retry
- **Don't modify the database schema** — only modify ingest code
- **Resume, don't restart** — download scripts support resume, use it
- The shared database is at `postgres://jlc:jlc@localhost:5432/jlc`
