// Encode cart quantities into URL hash: #cart=C22074:10,C25725:5
export function encodeCartToHash(quantities: Record<string, number>): string {
  const entries = Object.entries(quantities).filter(([, qty]) => qty > 0);
  if (entries.length === 0) return "";
  return "#cart=" + entries.map(([lcsc, qty]) => `${lcsc}:${qty}`).join(",");
}

// Decode URL hash into cart quantities
export function decodeCartFromHash(hash: string): Record<string, number> | null {
  if (!hash.startsWith("#cart=")) return null;
  const data = hash.slice(6);
  if (!data) return null;
  const quantities: Record<string, number> = {};
  for (const entry of data.split(",")) {
    const [lcsc, qtyStr] = entry.split(":");
    const qty = parseInt(qtyStr ?? "0", 10);
    if (lcsc && qty > 0) {
      quantities[lcsc] = qty;
    }
  }
  return Object.keys(quantities).length > 0 ? quantities : null;
}

// Generate full share URL with cart hash
export function generateShareUrl(quantities: Record<string, number>): string {
  const base = window.location.origin + window.location.pathname;
  return base + encodeCartToHash(quantities);
}

// Copy text to clipboard
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
