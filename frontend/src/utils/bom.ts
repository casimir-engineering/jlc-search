export interface BomItem {
  lcsc: string;
  mpn: string;
  description: string;
  package: string | null;
  quantity: number;
}

// Generate LCSC-compatible BOM CSV (simple: just LCSC part number + quantity)
export function generateLcscBomCsv(items: BomItem[], includeHeader = true): string {
  const lines: string[] = [];
  if (includeHeader) lines.push("LCSC Part Number,Quantity");
  for (const item of items) {
    lines.push(`${item.lcsc},${item.quantity}`);
  }
  return lines.join("\n");
}

// Generate JLCPCB BOM CSV format (Comment, Designator, Footprint, LCSC Part Number)
export function generateJlcpcbBomCsv(items: BomItem[]): string {
  const lines = ["Comment,Designator,Footprint,LCSC Part Number"];
  for (const item of items) {
    const comment = csvEscape(item.description || item.mpn);
    const designator = csvEscape(item.mpn);
    const footprint = csvEscape(item.package || "");
    lines.push(`${comment},${designator},${footprint},${item.lcsc}`);
  }
  return lines.join("\n");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Trigger browser download of a CSV file
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
