// Base-path-aware localStorage key prefixing.
//
// The frontend bundle is served at both `/` (prod) and `/test/` (staging) from
// the same origin. Without key prefixing, both bundles would read and write the
// same localStorage entries, polluting prod state with test data.
//
// At build time, Vite sets `import.meta.env.BASE_URL` based on the `base`
// config option:
//   - prod build: BASE_URL === "/"      → STORAGE_PREFIX === "jlc-"
//   - test build: BASE_URL === "/test/" → STORAGE_PREFIX === "jlc-test-"
//
// Every hook that uses localStorage must route its key through `storageKey()`.

const IS_TEST = import.meta.env.BASE_URL === "/test/";

export const STORAGE_PREFIX = IS_TEST ? "jlc-test-" : "jlc-";

/**
 * Build a localStorage key with the environment-appropriate prefix.
 *
 * @example
 *   storageKey("cart-quantities") // → "jlc-cart-quantities" in prod
 *                                  // → "jlc-test-cart-quantities" in test
 */
export function storageKey(suffix: string): string {
  return STORAGE_PREFIX + suffix;
}
