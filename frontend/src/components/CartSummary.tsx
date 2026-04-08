import { useState, useEffect, useRef } from "react";
import type { PartSummary } from "../types.ts";
import { getLineTotal } from "../utils/price.ts";
import { generateLcscBomCsv, generateJlcpcbBomCsv, downloadCsv } from "../utils/bom.ts";
import type { BomItem } from "../utils/bom.ts";
import { generateShareUrl, copyToClipboard } from "../utils/share.ts";
import { storageKey } from "../utils/storage.ts";

const SZLCSC_KEY = storageKey("szlcsc");

interface Props {
  parts: PartSummary[];
  quantities: Record<string, number>;
  onClearAll: () => void;
}

export function CartSummary({ parts, quantities, onClearAll }: Props) {
  const [copied, setCopied] = useState(false);
  const [bomCopied, setBomCopied] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  const itemCount = parts.filter((p) => (quantities[p.lcsc] ?? 0) > 0).length;
  const grandTotal = parts.reduce((sum, p) => {
    const qty = quantities[p.lcsc] ?? 0;
    return sum + getLineTotal(p.price_raw, qty);
  }, 0);

  function toBomItems(): BomItem[] {
    return parts
      .filter((p) => (quantities[p.lcsc] ?? 0) > 0)
      .map((p) => ({
        lcsc: p.lcsc,
        mpn: p.mpn,
        description: p.description,
        package: p.package,
        quantity: quantities[p.lcsc] ?? 0,
      }));
  }

  async function handleCopyBom() {
    const csv = generateLcscBomCsv(toBomItems(), false);
    const ok = await copyToClipboard(csv);
    if (ok) {
      setBomCopied(true);
      setTimeout(() => setBomCopied(false), 2000);
    }
  }

  function handleOpenBomTool() {
    const useSzlcsc = localStorage.getItem(SZLCSC_KEY) === "1";
    const url = useSzlcsc
      ? "https://bom.szlcsc.com/bom.html"
      : "https://www.lcsc.com/bom";
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function handleExportLcsc() {
    const csv = generateLcscBomCsv(toBomItems());
    downloadCsv(csv, "lcsc-bom.csv");
  }

  function handleExportJlcpcb() {
    const csv = generateJlcpcbBomCsv(toBomItems());
    downloadCsv(csv, "jlcpcb-bom.csv");
  }

  async function handleShare() {
    const url = generateShareUrl(quantities);
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleClear() {
    if (clearConfirm) {
      onClearAll();
      setClearConfirm(false);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    } else {
      setClearConfirm(true);
      clearTimerRef.current = setTimeout(() => setClearConfirm(false), 3000);
    }
  }

  return (
    <div className="cart-summary">
      <div className="cart-summary-info">
        <strong>{itemCount}</strong> item{itemCount !== 1 ? "s" : ""}
        {grandTotal > 0 && (
          <span className="cart-summary-total">
            {" "}&middot; ${grandTotal.toFixed(2)}
          </span>
        )}
      </div>
      <div className="cart-summary-actions">
        <button className="chip" onClick={handleCopyBom} title="Copy LCSC BOM CSV to clipboard">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1.5px', marginRight: '3px'}}>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          {bomCopied ? "Copied!" : "Copy BOM"}
        </button>
        <button className="chip" onClick={handleOpenBomTool} title="Upload BOM at LCSC">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1.5px', marginRight: '3px'}}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          BOM Tool
        </button>
        <button className="chip" onClick={handleExportLcsc} title="Download LCSC BOM CSV">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1.5px', marginRight: '3px'}}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          LCSC CSV
        </button>
        <button className="chip" onClick={handleExportJlcpcb} title="Download JLCPCB BOM CSV">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1.5px', marginRight: '3px'}}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          JLCPCB CSV
        </button>
        <button className="chip" onClick={handleShare}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1.5px', marginRight: '3px'}}>
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          {copied ? "Copied!" : "Share Link"}
        </button>
        <button
          className={clearConfirm ? "chip chip-danger-confirm" : "chip chip-danger"}
          onClick={handleClear}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1.5px', marginRight: '3px'}}>
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          {clearConfirm ? "Confirm clear" : "Clear BOM"}
        </button>
      </div>
    </div>
  );
}
