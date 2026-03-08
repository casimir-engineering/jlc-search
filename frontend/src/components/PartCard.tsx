import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { PartSummary } from "../types.ts";
import { PriceTable } from "./PriceTable.tsx";

interface Props {
  part: PartSummary;
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

const POPUP_SIZE = 390;
const POPUP_GAP = 12;

export function PartCard({ part }: Props) {
  const [imgSrc, setImgSrc] = useState(part.lcsc ? `/api/img/${part.lcsc}` : null);
  const [imgFailed, setImgFailed] = useState(false);
  const [imgKey, setImgKey] = useState(0);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [pcbaType, setPcbaType] = useState<string | null>(null);
  const [asmType, setAsmType] = useState<string | null>(null);
  const [richDesc, setRichDesc] = useState<string | null>(null);

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

  const handleImgError = () => {
    if (imgSrc?.startsWith("/api/img/")) {
      // Photo unavailable — show footprint immediately while backend fetches the real image
      setImgSrc(`/api/fp/${part.lcsc}?v=6`);
      setImgKey(k => k + 1);

      // Probe for the real photo silently in the background after 4s
      setTimeout(() => {
        const probe = new window.Image();
        probe.onload = () => {
          setImgSrc(`/api/img/${part.lcsc}`);
          setImgKey(k => k + 1);
        };
        probe.src = `/api/img/${part.lcsc}`;
      }, 4000);
    } else {
      // Footprint also failed — show static placeholder
      setImgFailed(true);
    }
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    if (imgFailed || !imgSrc) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fitsLeft = rect.left >= POPUP_SIZE + POPUP_GAP;
    const x = fitsLeft
      ? rect.left - POPUP_SIZE - POPUP_GAP
      : rect.right + POPUP_GAP;
    const rawY = rect.top + rect.height / 2 - POPUP_SIZE / 2;
    const y = Math.max(8, Math.min(window.innerHeight - POPUP_SIZE - 8, rawY));
    setPopupPos({ x, y });
  };

  const jlcUrl = `https://jlcpcb.com/partdetail/${part.lcsc}`;
  const lcscUrl = `https://www.lcsc.com/search?q=${encodeURIComponent(part.lcsc)}`;

  return (
    <div className="part-card">
      <div
        className="part-card-image"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setPopupPos(null)}
      >
        {imgFailed ? (
          <div className="part-card-image-placeholder">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
        ) : imgSrc ? (
          <img
            key={imgKey}
            src={imgSrc}
            alt={part.mpn}
            loading="lazy"
            onError={handleImgError}
          />
        ) : (
          <div className="part-card-image-placeholder">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
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
              <strong>Joints:</strong> {part.joints}
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

      {popupPos && imgSrc && createPortal(
        <div
          className="img-popup"
          style={{ left: popupPos.x, top: popupPos.y }}
        >
          <img src={imgSrc} alt={part.mpn} />
        </div>,
        document.body
      )}
    </div>
  );
}
