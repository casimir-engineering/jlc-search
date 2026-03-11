import { useEffect, useRef } from "react";
import { fetchPartsByIds } from "../api.ts";
import type { PartSummary } from "../types.ts";

const REFRESH_DELAY_MS = 4000;

/**
 * After results load, re-fetch parts with stale data (null moq) after a delay
 * to pick up opportunistic LCSC API updates from the backend.
 * Merges updated moq, price_raw, and stock into displayed results.
 */
export function useLiveRefresh(
  results: PartSummary[],
  setResults: (updater: (prev: PartSummary[]) => PartSummary[]) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  // Track which LCSCs we've already refreshed to avoid repeated fetches
  const refreshedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    clearTimeout(timerRef.current);

    const staleIds = results
      .filter((r) => r.moq == null && !refreshedRef.current.has(r.lcsc))
      .map((r) => r.lcsc);

    if (staleIds.length === 0) return;

    timerRef.current = setTimeout(async () => {
      try {
        const { results: fresh } = await fetchPartsByIds(staleIds);
        const freshMap = new Map(fresh.map((p) => [p.lcsc, p]));

        for (const id of staleIds) refreshedRef.current.add(id);

        setResults((prev) =>
          prev.map((p) => {
            const f = freshMap.get(p.lcsc);
            if (!f) return p;
            return {
              ...p,
              moq: f.moq ?? p.moq,
              price_raw: f.price_raw || p.price_raw,
              stock: f.stock ?? p.stock,
            };
          })
        );
      } catch {
        // Silent — stale data is acceptable
      }
    }, REFRESH_DELAY_MS);

    return () => clearTimeout(timerRef.current);
  }, [results, setResults]);
}
