import { useEffect, useState } from "react";
import { getStatus } from "../api.ts";

export function StatusBar() {
  const [status, setStatus] = useState<{
    total_parts: number;
    last_ingested: string | null;
  } | null>(null);

  useEffect(() => {
    getStatus()
      .then(setStatus)
      .catch(() => {/* silent */});
  }, []);

  if (!status) return null;

  const lastUpdated = status.last_ingested
    ? new Date(status.last_ingested).toLocaleDateString()
    : "never";

  return (
    <div className="status-bar">
      {status.total_parts > 0
        ? `${status.total_parts.toLocaleString()} parts · updated ${lastUpdated}`
        : "No parts in database — run ingest first"}
    </div>
  );
}
