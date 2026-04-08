import { useState, useCallback, useEffect } from "react";
import { storageKey } from "../utils/storage.ts";

const STORAGE_KEY = storageKey("cart-quantities");

function loadQuantities(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveQuantities(quantities: Record<string, number>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(quantities));
}

export function useCart(favorites: Set<string>) {
  const [quantities, setQuantities] = useState<Record<string, number>>(loadQuantities);

  // Clean up quantities for un-favorited parts
  useEffect(() => {
    setQuantities((prev) => {
      const cleaned: Record<string, number> = {};
      let changed = false;
      for (const [lcsc, qty] of Object.entries(prev)) {
        if (favorites.has(lcsc)) {
          cleaned[lcsc] = qty;
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      saveQuantities(cleaned);
      return cleaned;
    });
  }, [favorites]);

  const setQuantity = useCallback((lcsc: string, qty: number) => {
    setQuantities((prev) => {
      const next = { ...prev, [lcsc]: qty };
      saveQuantities(next);
      return next;
    });
  }, []);

  const initQuantity = useCallback((lcsc: string, moq: number) => {
    setQuantities((prev) => {
      if (lcsc in prev) return prev;
      const next = { ...prev, [lcsc]: moq };
      saveQuantities(next);
      return next;
    });
  }, []);

  const mergeQuantities = useCallback((incoming: Record<string, number>) => {
    setQuantities((prev) => {
      const next = { ...prev, ...incoming };
      saveQuantities(next);
      return next;
    });
  }, []);

  return { quantities, setQuantity, initQuantity, mergeQuantities };
}
