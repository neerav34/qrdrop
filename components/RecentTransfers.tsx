"use client";

import { useEffect, useState } from "react";
import { ago, bytes } from "@/lib/format";
import { clearHistory, readHistory, type HistoryEntry } from "@/lib/history";

/**
 * The last few transfers, read from this browser only.
 *
 * Deliberately renders nothing until after mount. `localStorage` does not exist
 * while the page is rendered on the server, so anything guessed here would
 * disagree with the client and produce a hydration mismatch. And a first-time
 * visitor should see a clean home page, not an empty-state box explaining a
 * feature they have not used.
 */
export default function RecentTransfers() {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);

  useEffect(() => setItems(readHistory()), []);

  if (!items || items.length === 0) return null;

  return (
    <section className="recent" aria-label="Recent transfers">
      <div className="recent-head">
        <h2>Recent</h2>
        <button
          className="recent-clear"
          onClick={() => {
            clearHistory();
            setItems([]);
          }}
        >
          Clear
        </button>
      </div>

      <ul className="recent-list">
        {items.map((e) => (
          <li key={e.id}>
            <span className="recent-dir" data-dir={e.direction} aria-hidden>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {e.direction === "sent" ? (
                  <>
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </>
                ) : (
                  <>
                    <path d="M12 5v14" />
                    <path d="m19 12-7 7-7-7" />
                  </>
                )}
              </svg>
            </span>
            <span className="recent-name">
              {e.firstName || "(unnamed)"}
              {e.fileCount > 1 && (
                <span className="recent-more"> +{e.fileCount - 1} more</span>
              )}
            </span>
            <span className="recent-meta">
              {bytes(e.totalSize)}
              {e.peer ? ` · ${e.peer}` : ""}
            </span>
            <span className="recent-when">{ago(e.at)}</span>
          </li>
        ))}
      </ul>

      <p className="footnote">
        Kept in this browser only — names and sizes, never the files themselves.
        Nothing is sent anywhere.
      </p>
    </section>
  );
}
