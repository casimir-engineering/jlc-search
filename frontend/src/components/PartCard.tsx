import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { PartSummary } from "../types.ts";
import { PriceTable } from "./PriceTable.tsx";

interface Props {
  part: PartSummary;
  showApiData: boolean;
  isFavorite: boolean;
  onToggleFavorite: (lcsc: string) => void;
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

function highlightJson(obj: unknown): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return JSON.stringify(obj, null, 2).replace(
    /("(?:\\.|[^"\\])*")\s*(:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str?: string, colon?: string, bool?: string, num?: string) => {
      if (str) {
        const escaped = esc(str);
        return colon
          ? `<span class="json-key">${escaped}</span>:`
          : `<span class="json-str">${escaped}</span>`;
      }
      if (bool) return `<span class="json-bool">${esc(bool)}</span>`;
      if (num) return `<span class="json-num">${esc(num)}</span>`;
      return esc(match);
    }
  );
}

const POPUP_SIZE = 390;
const POPUP_GAP = 12;

export function PartCard({ part, showApiData, isFavorite, onToggleFavorite }: Props) {
  const [photoSrc] = useState(part.lcsc ? `/api/img/${part.lcsc}` : null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [fpFailed, setFpFailed] = useState(false);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number; src: string } | null>(null);
  const [pcbaType, setPcbaType] = useState<string | null>(null);
  const [asmType, setAsmType] = useState<string | null>(null);
  const [richDesc, setRichDesc] = useState<string | null>(null);

  const fpSrc = part.lcsc ? `/api/fp/${part.lcsc}?v=6` : null;

  useEffect(() => {
    if (!part.lcsc) return;
    const ac = new AbortController();
    fetch(`/api/pcba/${part.lcsc}`, { signal: ac.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.pcba_type && d.pcba_type !== "unknown") setPcbaType(d.pcba_type);
        if (d?.assembly_type && d.assembly_type !== "unknown") setAsmType(d.assembly_type);
        if (d?.description) setRichDesc(d.description);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [part.lcsc]);

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

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, src: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fitsLeft = rect.left >= POPUP_SIZE + POPUP_GAP;
    const x = fitsLeft
      ? rect.left - POPUP_SIZE - POPUP_GAP
      : rect.right + POPUP_GAP;
    const rawY = rect.top + rect.height / 2 - POPUP_SIZE / 2;
    const y = Math.max(8, Math.min(window.innerHeight - POPUP_SIZE - 8, rawY));
    setPopupPos({ x, y, src });
  };

  const jlcUrl = `https://jlcpcb.com/partdetail/${part.lcsc}`;
  const lcscUrl = `https://www.lcsc.com/search?q=${encodeURIComponent(part.lcsc)}`;

  return (
    <div className={`part-card${isFavorite ? " part-card-favorite" : ""}`}>
      <button
        className={`fav-star${isFavorite ? " fav-star-active" : ""}`}
        onClick={() => onToggleFavorite(part.lcsc)}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        {isFavorite ? "\u2605" : "\u2606"}
      </button>
      <div className="part-card-images">
        {photoSrc && !photoFailed && (
          <div
            className="part-card-image"
            onMouseEnter={(e) => handleMouseEnter(e, photoSrc!)}
            onMouseLeave={() => setPopupPos(null)}
          >
            <img
              src={photoSrc}
              alt={part.mpn}
              loading="lazy"
              onError={handlePhotoError}
            />
          </div>
        )}
        {fpSrc && !fpFailed && (
          <div
            className="part-card-image part-card-fp"
            onMouseEnter={(e) => handleMouseEnter(e, fpSrc)}
            onMouseLeave={() => setPopupPos(null)}
          >
            <img
              src={fpSrc}
              alt={`${part.mpn} footprint`}
              loading="lazy"
              onError={() => setFpFailed(true)}
            />
          </div>
        )}
        {photoFailed && fpFailed && (
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
          <span className="part-mpn">{part.mpn || "(no MPN)"}</span>
          <span className="part-lcsc">{part.lcsc}</span>
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
          {asmType && <span className="badge badge-package">{asmType}</span>}
          {part.package && <span className="badge badge-package">{translatePackage(part.package)}</span>}
        </div>

        <div className="part-category">{part.category} › {part.subcategory}</div>
        {(richDesc || part.description) && (
          <div className="part-desc">{richDesc || part.description}</div>
        )}

        <div className="part-meta">
          <span className="part-stock">
            <strong>Stock:</strong>{" "}
            {part.stock > 0 ? (
              <span className="stock-ok">{part.stock.toLocaleString()}</span>
            ) : (
              <span className="stock-zero">0</span>
            )}
          </span>
          {part.manufacturer && (
            <span className="part-mfr">
              <strong>Mfr:</strong> {part.manufacturer}
            </span>
          )}
          {part.joints != null && (
            <span className="part-joints">
              <strong>Pads:</strong> {part.joints}
            </span>
          )}
        </div>

        <PriceTable priceRaw={part.price_raw} />

        <div className="part-actions">
          {part.datasheet && (
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

      {showApiData && (
        <pre className="part-api-data" dangerouslySetInnerHTML={{ __html: highlightJson(part) }} />
      )}

      {popupPos && createPortal(
        <div
          className="img-popup"
          style={{ left: popupPos.x, top: popupPos.y }}
        >
          <img src={popupPos.src} alt={part.mpn} />
        </div>,
        document.body
      )}
    </div>
  );
}
