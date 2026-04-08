import { useEffect, useState } from "react";
import { getStatus } from "../api.ts";
import { storageKey } from "../utils/storage.ts";

const SZLCSC_KEY = storageKey("szlcsc");

export function StatusBar() {
  const [status, setStatus] = useState<{
    total_parts: number;
    last_ingested: string | null;
  } | null>(null);

  const [szlcsc, setSzlcsc] = useState(
    () => localStorage.getItem(SZLCSC_KEY) === "1"
  );

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => {/* silent */});
  }, []);

  const handleSzlcscChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setSzlcsc(checked);
    if (checked) {
      localStorage.setItem(SZLCSC_KEY, "1");
    } else {
      localStorage.removeItem(SZLCSC_KEY);
    }
  };

  if (!status) return null;

  return (
    <div className="status-bar">
      <span>
        {status.total_parts > 0
          ? `${status.total_parts.toLocaleString()} parts`
          : "No parts in database — run ingest first"}
      </span>
      <span className="footer-center">
        <a href="https://casimir.engineering" target="_blank" rel="noopener noreferrer" className="footer-credit">
          <img src="https://casimir.engineering/casimir-eng-logo.svg" alt="Casimir Engineering" className="footer-logo" />
        </a>
        {" "}By <a href="https://casimir.engineering" target="_blank" rel="noopener noreferrer" className="footer-credit">Casimir Engineering</a>, prototype to production scaling specialists.
      </span>
      <label className="szlcsc-toggle">
        <input
          type="checkbox"
          checked={szlcsc}
          onChange={handleSzlcscChange}
        />
        szlcsc
      </label>
    </div>
  );
}
