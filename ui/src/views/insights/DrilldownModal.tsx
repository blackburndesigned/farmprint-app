/** The orders or parts behind one Insights number, with CSV export. */
import React, { useEffect, useState } from "react";
import { invoke } from "../../tauriInvoke";
import { errorText } from "../../errorText";
import { csvText, notifyBanner, notifyError, saveTextFile } from "../../uiFeedback";
import type { InsightsQuery, InsightsTable } from "./insightsTypes";
import { rangeFileLabel } from "./insightsRange";

export interface Drill {
  metric: string;
  key?: string | null;
  title: string;
}

export const DrilldownModal: React.FC<{
  drill: Drill;
  query: InsightsQuery;
  rangeLabel: string;
  onClose: () => void;
  onSelectOrder: (id: string) => void;
}> = ({ drill, query, rangeLabel, onClose, onSelectOrder }) => {
  const [table, setTable] = useState<InsightsTable | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setTable(null);
    setErr("");
    invoke<InsightsTable>("insights_drilldown", { query, metric: drill.metric, key: drill.key ?? null })
      .then((t) => live && setTable(t))
      .catch((e) => live && setErr(errorText(e)));
    return () => {
      live = false;
    };
  }, [drill.metric, drill.key, query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const exportCsv = async () => {
    if (!table) return;
    const rows: unknown[][] = [[`# ${drill.title}`], [`# ${rangeLabel}`], table.columns, ...table.rows];
    try {
      const safe = drill.metric.replace(/[^a-z0-9_-]/gi, "");
      const path = await saveTextFile(`insights-${safe}-detail-${rangeFileLabel(query)}.csv`, csvText(rows));
      if (path) notifyBanner(`Saved ${path}`);
    } catch (e) {
      notifyError("Couldn't save the CSV", e);
    }
  };

  return (
    <div className="fp-modal-backdrop" onClick={onClose}>
      <div className="fp-modal-window fp-ins-drill" role="dialog" aria-modal="true" aria-label={drill.title} onClick={(e) => e.stopPropagation()}>
        <div className="fp-modal-header">
          <div>
            <div className="fp-modal-title">{drill.title}</div>
            <div className="fp-ins-sub">
              {rangeLabel}
              {table ? ` · ${table.title} · ${table.rows.length} ${table.rows.length === 1 ? "row" : "rows"}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="fp-btn fp-btn-sm" disabled={!table || table.rows.length === 0} onClick={() => void exportCsv()}>
              Export CSV
            </button>
            <button type="button" className="fp-btn fp-btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="fp-modal-body">
          {err && <div className="fp-ins-empty">{err}</div>}
          {!err && !table && <div className="fp-ins-empty">Loading…</div>}
          {table && table.rows.length === 0 && <div className="fp-ins-empty">Not enough data</div>}
          {table && table.rows.length > 0 && (
            <table className="fp-ins-table">
              <thead>
                <tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => {
                  const oid = table.order_ids[i];
                  return (
                    <tr key={i} className={oid ? "clickable" : undefined} onClick={oid ? () => onSelectOrder(oid) : undefined}
                      title={oid ? "Open order" : undefined}>
                      {r.map((c, j) => <td key={j}>{c}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
