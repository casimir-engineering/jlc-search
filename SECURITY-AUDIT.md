# Security Audit Report — jlc-search

**Date:** 2026-03-11
**Auditor:** Claude Opus 4.6 (automated, 5-agent parallel sweep)
**Scope:** Full-stack (Bun/Hono backend, Vite/React frontend, PostgreSQL, Docker)
**Methodology:** Static analysis across 5 domains: SQL/DB, XSS/CORS/headers, dependencies/Docker, DoS/API, client-side

---

## Executive Summary

The application had **4 critical**, **8 high**, **6 medium**, and **5 low/info** findings. All critical and high issues have been remediated in this same commit. Medium and low findings are documented below for future work.

---

## Findings — Fixed (Critical + High)

### CRITICAL

#### C1. Hardcoded Database Credentials
- **Files:** `backend/src/db.ts:4`, `docker-compose.yml:8,33,57`, `backend/Dockerfile:11`, `ingest/Dockerfile:15`
- **Was:** `postgres://jlc:jlc@localhost:5432/jlc` hardcoded as fallback default in source, Dockerfiles, and compose
- **Risk:** Repo exposure leaks full DB access; password = username
- **Fix:** `DATABASE_URL` is now a required env var with no fallback. App exits with `FATAL` error if unset. Removed from Dockerfiles and docker-compose (now uses `${DATABASE_URL:?Set DATABASE_URL in .env}`). Created `.env.example` with placeholder values.

#### C2. Unbounded Batch IDs — DoS via SQL IN Clause
- **File:** `backend/src/routes/part.ts:9`
- **Was:** `idsParam.split(",")` with no cap — attacker could send millions of IDs
- **Risk:** OOM, query planner explosion, connection pool exhaustion
- **Fix:** `.slice(0, 200)` applied before filtering — hard cap at 200 IDs per batch request

#### C3. Unbounded Offset — Pagination Scan Attack
- **File:** `backend/src/routes/search.ts:14`
- **Was:** `parseInt(c.req.query("offset") ?? "0")` — no upper bound
- **Risk:** `?offset=999999999999` forces PostgreSQL to scan millions of rows, severe DoS
- **Fix:** `Math.min(Math.max(0, ...), 100_000)` — offset capped at 100K. Limit also bounded to 1-200 with NaN fallback.

#### C4. No Request Size Limits
- **File:** `backend/src/index.ts:31`
- **Was:** `Bun.serve({ fetch: app.fetch })` — default body size (potentially multi-MB)
- **Risk:** Memory exhaustion via large query strings or POST bodies
- **Fix:** `maxRequestBodySize: 64 * 1024` (64 KB) — appropriate for a search-only API

### HIGH

#### H1. CORS origin: "*" — Any Website Can Call API
- **File:** `backend/src/index.ts:14`
- **Was:** `cors({ origin: "*" })`
- **Risk:** CSRF, data exfiltration, cross-site enumeration of parts database
- **Fix:** Configurable via `ALLOWED_ORIGINS` env var (comma-separated). Defaults to `http://localhost:3000`. Supports `*` for intentional public APIs.

#### H2. Zero HTTP Security Headers
- **Files:** `backend/src/index.ts` (new middleware), `frontend/nginx.conf`
- **Was:** No security headers on any response
- **Risk:** Clickjacking (no X-Frame-Options), MIME sniffing (no nosniff), XSS escalation (no CSP)
- **Fix:** Added middleware setting `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy`. Same headers added to nginx.conf for the frontend.

#### H3. SVG Injection — Unescaped Pin Labels in Footprint Renderer
- **File:** `backend/src/routes/fp.ts:360,440`
- **Was:** `>${pin}</text>` and `>${pkgTitle}</text>` — raw interpolation of external data into SVG
- **Risk:** XSS via crafted EasyEDA component data (pin names, package names can contain `<script>`)
- **Fix:** Added `esc()` function to fp.ts (same as sch.ts already had). Pin labels and package title now escaped: `>${esc(pin)}</text>`, `>${esc(pkgTitle)}</text>`

#### H4. Datasheet URL Open Redirect / javascript: Protocol
- **File:** `frontend/src/components/PartCard.tsx:247`
- **Was:** `<a href={part.datasheet}>` rendered without protocol validation
- **Risk:** If datasheet field contains `javascript:alert(1)` or `data:text/html,...`, clicking executes code
- **Fix:** Added `/^https?:\/\//i.test(part.datasheet)` guard — link only renders for http/https URLs

#### H5. Docker Containers Running as Root
- **Files:** `backend/Dockerfile`, `ingest/Dockerfile`
- **Was:** No `USER` directive — processes ran as root inside container
- **Risk:** Container escape gives attacker root on host
- **Fix:** Added `addgroup/adduser` and `USER app` directive. Frontend nginx container documented (needs root for port 80 bind, workers run as nginx user).

#### H6. Inconsistent LCSC Code Validation
- **Files:** `backend/src/routes/pcba.ts:60`, `backend/src/routes/part.ts:25`
- **Was:** pcba.ts accepted `[A-Z0-9]+`, part.ts `/:lcsc` had no validation at all
- **Risk:** Logic bugs, unnecessary external fetches for invalid codes, information disclosure
- **Fix:** Both now validate `/^C\d+$/` and return 400 for invalid codes. Consistent with fp.ts, sch.ts, img.ts.

#### H7. No Rate Limiting
- **File:** `backend/src/index.ts` (new middleware)
- **Was:** Zero rate limiting on any endpoint
- **Risk:** API exhaustion, DB connection starvation, upstream IP bans (LCSC, EasyEDA, JLCPCB)
- **Fix:** In-memory per-IP rate limiter: 200 req/min (configurable via `RATE_LIMIT` env). Returns 429 with `Retry-After: 60`. Auto-cleanup when map exceeds 10K entries.

#### H8. No Statement Timeout — Slow Queries Hold Connections
- **File:** `backend/src/db.ts:20`
- **Was:** No query timeout configured
- **Risk:** Crafted queries or DB issues hold connections indefinitely, starving pool (max: 20)
- **Fix:** `connection: { statement_timeout: 10_000 }` — PostgreSQL kills queries after 10 seconds

---

## Findings — Not Yet Fixed (Medium)

### M1. Query Length Not Validated
- **File:** `backend/src/routes/search.ts:9`
- **Status:** PARTIALLY FIXED — capped at 500 chars with `.slice(0, 500)`, but no explicit 400 error for overlong queries
- **Remaining risk:** Low — truncation is silent but harmless

### M2. Prototype Pollution in URL Hash Decoder
- **File:** `frontend/src/utils/share.ts:13-19`
- **Status:** FIXED — `Object.create(null)` for prototype-safe object, LCSC format validation (`/^C\d+$/i`), entry cap at 500, qty cap at 100K

### M3. sql.unsafe() Usage
- **File:** `backend/src/search/engine.ts:154,172,211,237,296,323`
- **Status:** NOT FIXED — `sql.unsafe(SELECT_COLS)` is safe (hardcoded string), but `sql.unsafe()` for the LCSC direct lookup is also safe ($1 parameterized). Maintenance risk only.
- **Recommendation:** Refactor to avoid `.unsafe()` when feasible

### M4. External API Responses Unvalidated
- **Files:** `backend/src/routes/img.ts:93`, `fp.ts:509`, `sch.ts:427`
- **Status:** NOT FIXED — no size limits or content-type checks on fetched data
- **Recommendation:** Add `Content-Length` check before consuming body, validate content-type, limit to 5MB

### M5. Unbounded Disk Cache Writes
- **Files:** `backend/src/routes/fp.ts:513`, `sch.ts:431`, `img.ts:98`
- **Status:** NOT FIXED — files cached to disk without quota
- **Recommendation:** Implement LRU eviction or directory size cap (e.g., 10GB)

### M6. tsquery String Interpolation Pattern
- **File:** `backend/src/search/engine.ts:213,240,245`
- **Status:** NOT FIXED — `buildTsQuery()` sanitizes with regex removal of `&|!():*<>'\\`, then interpolates via postgres template literal. Safe today, but fragile.
- **Recommendation:** Validate that the postgres library properly parameterizes string values inside `to_tsquery('simple', ${andQ})`

---

## Findings — Not Yet Fixed (Low / Info)

### L1. Source Maps Not Disabled for Production
- **File:** `frontend/vite.config.ts`
- **Recommendation:** Add `build: { sourcemap: false }` for production

### L2. No Audit Logging
- **Recommendation:** Add structured logging for API access, errors, rate limit hits

### L3. localStorage Stores Favorites/Cart in Plaintext
- **Files:** `frontend/src/hooks/useFavorites.ts`, `useCart.ts`
- **Impact:** Low — no PII, but XSS could read favorites list

### L4. PostgreSQL Not Hardened
- **File:** `docker-compose.yml`
- **Recommendation:** Add `-c password_encryption=scram-sha-256`, `-c log_statement=ddl`

### L5. Docker Host Network Mode
- **File:** `docker-compose.yml` (all services)
- **Status:** Known workaround for UFW/nftables firewall issue on this host
- **Recommendation:** Switch to bridge networking when deploying to production

---

## Positive Findings

These security practices were already in place:

- **No `dangerouslySetInnerHTML`** anywhere in React code
- **No `eval()` or `Function()` constructors**
- **Parameterized SQL queries** used consistently via postgres template literals
- **`esc()` XML escaping** in schematic renderer (sch.ts) for all text content
- **`encodeURIComponent()`** used correctly for URL parameters
- **`target="_blank"` always paired with `rel="noopener noreferrer"`**
- **AbortSignal** used for fetch timeout/cancellation
- **React StrictMode** enabled
- **`.env` in `.gitignore`**
- **LCSC code validation** (`/^C\d+$/`) on img, fp, sch routes (before this audit)

---

## Files Modified in This Audit

| File | Changes |
|------|---------|
| `backend/src/db.ts` | Required DATABASE_URL, statement_timeout |
| `backend/src/index.ts` | CORS config, security headers, rate limiter, body size limit |
| `backend/src/routes/search.ts` | Query/offset/limit bounds, partType cap |
| `backend/src/routes/part.ts` | Batch ID cap (200), LCSC validation on /:lcsc |
| `backend/src/routes/pcba.ts` | Strict LCSC validation |
| `backend/src/routes/fp.ts` | Added esc(), escaped pin labels + pkgTitle |
| `backend/Dockerfile` | Removed hardcoded DATABASE_URL, added non-root USER |
| `ingest/Dockerfile` | Removed hardcoded DATABASE_URL, added non-root USER |
| `frontend/Dockerfile` | Documented nginx user model |
| `frontend/nginx.conf` | Security headers, client_max_body_size, X-Forwarded-For |
| `frontend/src/components/PartCard.tsx` | Datasheet URL protocol validation |
| `frontend/src/utils/share.ts` | Prototype pollution fix, LCSC validation, entry cap |
| `docker-compose.yml` | Credentials via env vars, ALLOWED_ORIGINS |
| `.env.example` | Updated with new required variables |
| `Makefile` | .env validation, sources env for dev targets |

---

## Setup After This Audit

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD and DATABASE_URL
make dev
```

## Remaining Work (Priority Order)

1. Add response size limits on external API fetches (M4)
2. Implement disk cache quota/LRU eviction (M5)
3. Disable source maps in production build (L1)
4. Switch to bridge networking for production Docker deployment (L5)
5. Add structured security logging (L2)
