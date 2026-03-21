import { useState, memo, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { PartSummary } from "../types.ts";
import { PriceTable } from "./PriceTable.tsx";
import { getUnitPrice, getLineTotal } from "../utils/price.ts";

interface Props {
  part: PartSummary;
  isFavorite: boolean;
  onToggleFavorite: (lcsc: string) => void;
  quantity?: number;
  onQuantityChange?: (lcsc: string, qty: number) => void;
  searchQuery?: string;
}

const PART_TYPE_CLASS: Record<string, string> = {
  Basic: "badge-basic",
  Preferred: "badge-preferred",
  Extended: "badge-extended",
  Mechanical: "badge-mechanical",
};

const CN_PACKAGE: [RegExp, string][] = [
  [/^插件/, "THT"],
  [/^弯插/, "THT-Right Angle"],
  [/^贴片/, "SMD"],
  [/^直插/, "THT"],
];

function translatePackage(pkg: string): string {
  for (const [re, en] of CN_PACKAGE) {
    if (re.test(pkg)) return pkg.replace(re, en);
  }
  return pkg;
}

/** Highlight search terms in text. Returns JSX with <mark> tags around matches. */
function highlightText(text: string, tokens: string[]): React.ReactNode {
  if (!tokens.length || !text) return text;
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    re.test(part) ? <mark key={i}>{part}</mark> : part
  );
}

/** Extract readable value from jlcparts nested attribute format. */
function getAttrDisplayValue(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const e = entry as { primary?: string; default?: string; values?: Record<string, [unknown, string]> };
    if (e.values) {
      const pointer = e.primary ?? e.default;
      if (pointer && e.values[pointer]) {
        const val = e.values[pointer][0];
        if (val != null) return String(val);
      }
      if (e.values["default"]) {
        const val = e.values["default"][0];
        if (val != null) return String(val);
      }
    }
  }
  return null;
}

const SKIP_ATTR_KEYS = new Set(["Basic/Extended", "Manufacturer", "Package", "Status"]);

const POPUP_SIZE = 390;
const POPUP_GAP = 12;

export const PartCard = memo(function PartCard({ part, isFavorite, onToggleFavorite, quantity, onQuantityChange, searchQuery }: Props) {
  const [photoSrc] = useState(part.lcsc ? `/api/img/${part.lcsc}` : null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [schFailed, setSchFailed] = useState(false);
  const [fpFailed, setFpFailed] = useState(false);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number; src: string } | null>(null);

  const schSrc = part.lcsc ? `/api/sch/${part.lcsc}?v=2` : null;
  const fpSrc = part.lcsc ? `/api/fp/${part.lcsc}?v=9${part.package ? `&pkg=${encodeURIComponent(part.package)}` : ''}` : null;

  const pcbaType = part.pcba_type && part.pcba_type !== "unknown" ? part.pcba_type : null;

  // Parse search tokens for highlighting
  const searchTokens = useMemo(() => {
    if (!searchQuery) return [];
    return searchQuery.split(/\s+/).filter(t => t.length >= 2 && !t.startsWith("-") && !t.includes(":"));
  }, [searchQuery]);

  // Extract matched range filter values from description
  const matchedValues = useMemo(() => {
    if (!searchQuery || !part.description) return [];
    const rangeRe = /(\w+):([<>]?\d+\.?\d*(?:->?\d+\.?\d*)?)/g;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = rangeRe.exec(searchQuery)) !== null) {
      const unit = m[1].toLowerCase();
      // Map unit aliases to symbols for display matching
      const symbols: Record<string, string[]> = {
        ohm: ["Ω", "Ohm", "ohm"], v: ["V"], f: ["F"], a: ["A"], w: ["W"], hz: ["Hz"], h: ["H"],
      };
      const syms = symbols[unit] || [unit];
      // Find the actual value in description (e.g., "22Ω", "100nF", "3.3V")
      const siRe = new RegExp(`(\\d+\\.?\\d*)(G|M|k|m|u|μ|n|p)?(?:${syms.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?!\\w)`, "g");
      let dm: RegExpExecArray | null;
      while ((dm = siRe.exec(part.description)) !== null) {
        const sym = syms[0] === "Ω" ? "Ω" : syms[0];
        matches.push(`${dm[1]}${dm[2] || ""}${sym}`);
        break; // first match per filter
      }
    }
    return matches;
  }, [searchQuery, part.description]);

  // Parse attributes for display
  const attrEntries = useMemo(() => {
    if (!part.attributes || typeof part.attributes !== "object") return [];
    const entries: { key: string; value: string }[] = [];
    for (const [key, raw] of Object.entries(part.attributes)) {
      if (SKIP_ATTR_KEYS.has(key)) continue;
      const val = getAttrDisplayValue(raw);
      if (val && val !== "-" && val !== "null") entries.push({ key, value: val });
    }
    return entries;
  }, [part.attributes]);

  const handlePhotoError = () => {
    setPhotoFailed(true);
    // Probe for the real photo silently after 4s (backend may be fetching it)
    if (photoSrc) {
      setTimeout(() => {
        const probe = new window.Image();
        probe.onload = () => {
          setPhotoFailed(false);
        };
        probe.src = photoSrc;
      }, 4000);
    }
  };

  const handleSchError = () => {
    setSchFailed(true);
    if (schSrc) {
      setTimeout(() => {
        const probe = new window.Image();
        probe.onload = () => {
          setSchFailed(false);
        };
        probe.src = schSrc;
      }, 4000);
    }
  };

  const handleFpError = () => {
    setFpFailed(true);
    if (fpSrc) {
      setTimeout(() => {
        const probe = new window.Image();
        probe.onload = () => {
          setFpFailed(false);
        };
        probe.src = fpSrc;
      }, 4000);
    }
  };

  const isTouchRef = useRef(false);

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, src: string) => {
    if (isTouchRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fitsLeft = rect.left >= POPUP_SIZE + POPUP_GAP;
    const x = fitsLeft
      ? rect.left - POPUP_SIZE - POPUP_GAP
      : rect.right + POPUP_GAP;
    const rawY = rect.top + rect.height / 2 - POPUP_SIZE / 2;
    const y = Math.max(8, Math.min(window.innerHeight - POPUP_SIZE - 8, rawY));
    setPopupPos({ x, y, src });
  };

  const handleMouseLeave = () => {
    if (isTouchRef.current) return;
    setPopupPos(null);
  };

  const handleImageClick = (src: string) => {
    // On touch, open lightbox. On desktop, click does nothing (hover handles it).
    if (isTouchRef.current) {
      setPopupPos({ x: 0, y: 0, src });
    }
  };

  const handleTouchStart = () => { isTouchRef.current = true; };

  const jlcUrl = `https://jlcpcb.com/partdetail/${part.lcsc}`;
  const lcscUrl = `https://www.lcsc.com/search?q=${encodeURIComponent(part.lcsc)}`;

  return (
    <div className={`part-card${isFavorite ? " part-card-favorite" : ""}`}>
      <div className="card-top-right">
        <button
          className={`fav-star${isFavorite ? " fav-star-active" : ""}`}
          onClick={() => onToggleFavorite(part.lcsc)}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          {isFavorite ? "\u2605" : "\u2606"}
        </button>
        {isFavorite && onQuantityChange && (
          <div className="cart-qty-section">
            <input
              type="number"
              className="cart-qty-input"
              value={quantity ?? ""}
              min={1}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val > 0) onQuantityChange(part.lcsc, val);
              }}
            />
            {quantity != null && quantity > 0 && (
              <div className="cart-line-total">
                <span className="cart-unit-price">${getUnitPrice(part.price_raw, quantity).toFixed(4)}/ea</span>
                <span className="cart-total-price">${getLineTotal(part.price_raw, quantity).toFixed(2)}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="part-card-images">
        {photoSrc && !photoFailed && (
          <div
            className="part-card-image"
            onTouchStart={handleTouchStart}
            onMouseEnter={(e) => handleMouseEnter(e, photoSrc!)}
            onMouseLeave={handleMouseLeave}
            onClick={() => handleImageClick(photoSrc!)}
          >
            <img
              src={photoSrc}
              alt={part.mpn}
              loading="lazy"
              onError={handlePhotoError}
            />
          </div>
        )}
        {schSrc && !schFailed && (
          <div
            className="part-card-image part-card-sch"
            onTouchStart={handleTouchStart}
            onMouseEnter={(e) => handleMouseEnter(e, schSrc)}
            onMouseLeave={handleMouseLeave}
            onClick={() => handleImageClick(schSrc)}
          >
            <img
              src={schSrc}
              alt={`${part.mpn} schematic`}
              loading="lazy"
              onError={handleSchError}
            />
          </div>
        )}
        {fpSrc && !fpFailed && (
          <div
            className="part-card-image part-card-fp"
            onTouchStart={handleTouchStart}
            onMouseEnter={(e) => handleMouseEnter(e, fpSrc)}
            onMouseLeave={handleMouseLeave}
            onClick={() => handleImageClick(fpSrc)}
          >
            <img
              src={fpSrc}
              alt={`${part.mpn} footprint`}
              loading="lazy"
              onError={handleFpError}
            />
          </div>
        )}
        {photoFailed && schFailed && fpFailed && (
          <div className="part-card-image">
            <div className="part-card-image-placeholder">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
          </div>
        )}
      </div>

      <div className="part-card-body">
        <div className="part-header">
          <span className="part-mpn">{highlightText(part.mpn || "(no MPN)", searchTokens)}</span>
          <span className="part-lcsc">{highlightText(part.lcsc, searchTokens)}</span>
        </div>

        <div className="part-badges">
          <span className={`badge ${PART_TYPE_CLASS[part.part_type] ?? "badge-extended"}`}>
            {part.part_type}
          </span>
          {pcbaType && (
            <span className={`badge ${pcbaType.includes("Economic") ? "badge-basic" : "badge-extended"}`}>
              {pcbaType.includes("Economic") ? "Economic" : "Standard"}
            </span>
          )}
          {part.package && <span className="badge badge-package">{translatePackage(part.package)}</span>}
          {matchedValues.map((val, i) => (
            <span key={i} className="badge badge-match">{val}</span>
          ))}
        </div>

        <div className="part-category">{part.category} › {part.subcategory}</div>
        {part.description && (
          <div className="part-desc">{highlightText(part.description, searchTokens)}</div>
        )}

        <div className="part-meta">
          <span className="part-stock">
            <strong>LCSC:</strong>{" "}
            {part.stock > 0 ? (
              <span className="stock-ok">{part.stock.toLocaleString()}</span>
            ) : (
              <span className="stock-zero">0</span>
            )}
            {" "}
            <strong>JLC:</strong>{" "}
            {part.jlc_stock > 0 ? (
              <span className="stock-ok">{part.jlc_stock.toLocaleString()}</span>
            ) : (
              <span className="stock-zero">0</span>
            )}
          </span>
          {part.manufacturer && (
            <span className="part-mfr">
              <strong>Mfr:</strong> {highlightText(part.manufacturer, searchTokens)}
            </span>
          )}
          {part.joints != null && (
            <span className="part-joints">
              <strong>Pads:</strong> {part.joints}
            </span>
          )}
        </div>

        {attrEntries.length > 0 && (
          <div className="part-attrs">
            {attrEntries.map(({ key, value }) => (
              <span key={key} className="part-attr">
                <span className="attr-key">{key}:</span>{" "}
                <span className="attr-val">{highlightText(value, searchTokens)}</span>
              </span>
            ))}
          </div>
        )}

        <PriceTable priceRaw={part.price_raw} />

        <div className="part-actions">
          {part.datasheet && /^https?:\/\//i.test(part.datasheet) && (
            <a
              href={part.datasheet}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              Datasheet ↗
            </a>
          )}
          <a
            href={jlcUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
          >
            JLC ↗
          </a>
          <a
            href={lcscUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            LCSC ↗
          </a>
        </div>
      </div>

      {popupPos && createPortal(
        isTouchRef.current ? (
          <div className="img-lightbox" onClick={() => setPopupPos(null)}>
            <button className="img-lightbox-close" onClick={() => setPopupPos(null)}>&times;</button>
            <img src={popupPos.src} alt={part.mpn} onClick={(e) => e.stopPropagation()} />
          </div>
        ) : (
          <div
            className="img-popup"
            style={{ left: popupPos.x, top: popupPos.y }}
          >
            <img src={popupPos.src} alt={part.mpn} />
          </div>
        ),
        document.body
      )}
    </div>
  );
});
