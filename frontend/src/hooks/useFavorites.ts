import { useState, useCallback } from "react";
import { storageKey } from "../utils/storage.ts";

const STORAGE_KEY = storageKey("favorites");

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveFavorites(favs: Set<string>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...favs]));
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);

  const toggle = useCallback((lcsc: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(lcsc)) next.delete(lcsc);
      else next.add(lcsc);
      saveFavorites(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    const next = new Set<string>();
    saveFavorites(next);
    setFavorites(next);
  }, []);

  return { favorites, toggle, clearAll };
}
