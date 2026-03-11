import { useEffect, useState } from "react";
import { getStatus } from "../api.ts";

export function StatusBar() {
  const [status, setStatus] = useState<{
    total_parts: number;
    last_ingested: string | null;
  } | null>(null);

  const [szlcsc, setSzlcsc] = useState(
    () => localStorage.getItem("jlc-szlcsc") === "1"
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
      localStorage.setItem("jlc-szlcsc", "1");
    } else {
      localStorage.removeItem("jlc-szlcsc");
    }
  };

  if (!status) return null;

  const lastUpdated = status.last_ingested
    ? new Date(status.last_ingested).toLocaleDateString()
    : "never";

  return (
    <div className="status-bar">
      <span>
        {status.total_parts > 0
          ? `${status.total_parts.toLocaleString()} parts · updated ${lastUpdated}`
          : "No parts in database — run ingest first"}
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
