// Base-path-aware pathname helpers.
//
// The frontend bundle is served at both `/` (prod) and `/test/` (staging).
// Raw `window.location.pathname === "/donate"` checks break in test because
// `window.location.pathname === "/test/donate"`. These helpers normalize
// paths relative to the Vite `base` configured at build time.
//
// At build time, Vite sets `import.meta.env.BASE_URL`:
//   - prod build: BASE_URL === "/"      → BASE === ""
//   - test build: BASE_URL === "/test/" → BASE === "/test"

const RAW_BASE = import.meta.env.BASE_URL;
// Strip trailing slash so BASE + "/foo" produces "/foo" (prod) or "/test/foo" (test)
export const BASE = RAW_BASE.replace(/\/$/, "");

/**
 * True if the current pathname matches the given app-relative path.
 *
 * @example
 *   isPath("/donate") // matches "/donate" in prod AND "/test/donate" in test
 *   isPath("/")       // matches "/" in prod AND "/test/" in test
 */
export function isPath(appPath: string): boolean {
  const target = BASE + appPath;
  // Root path needs special handling: BASE + "/" = "/test/" (with slash) but
  // window.location.pathname for the root is often "/test" (no trailing slash)
  if (appPath === "/") {
    return window.location.pathname === target ||
           window.location.pathname === BASE ||
           window.location.pathname === (BASE || "/");
  }
  return window.location.pathname === target;
}

/**
 * Build a full pathname for the given app-relative path, respecting the
 * current base path. Used when calling window.history.pushState().
 *
 * @example
 *   buildPath("/donate")           // "/donate" in prod, "/test/donate" in test
 *   buildPath("/?q=foo")           // "/?q=foo" in prod, "/test/?q=foo" in test
 */
export function buildPath(appPath: string): string {
  return BASE + appPath;
}

/**
 * Strip the base path from a full pathname, returning an app-relative path.
 *
 * @example
 *   stripBase("/test/donate") // "/donate" when BASE="/test"
 *   stripBase("/donate")      // "/donate" when BASE=""
 */
export function stripBase(fullPath: string): string {
  if (BASE && fullPath.startsWith(BASE)) {
    return fullPath.slice(BASE.length) || "/";
  }
  return fullPath;
}
