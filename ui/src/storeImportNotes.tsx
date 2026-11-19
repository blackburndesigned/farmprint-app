// Notes from the last Import Website Orders run (orders left on the shop, items skipped,
// orders claimed but not saved). Kept in one small store so they survive switching tabs, and
// shown as an expandable banner on Orders and inside Needs Attention. Words come from fp-sync
// and name each order by its BD- number.
import React, { useState, useSyncExternalStore } from "react";

export interface ImportNotes {
  at: string;
  /** Claimed on the shop but not saved here: must be added by hand. */
  notSaved: string[];
  warnings: string[];
}

const EMPTY: ImportNotes = { at: "", notSaved: [], warnings: [] };
let current: ImportNotes = EMPTY;
const listeners = new Set<() => void>();

/** Replaces the notes with this run's (an import with nothing to say clears them). */
export function recordImportNotes(warnings: string[] | undefined, notSaved: string[] | undefined) {
  const w = (warnings || []).map((x) => x.trim()).filter(Boolean);
  const n = (notSaved || []).map((x) => x.trim()).filter(Boolean);
  current = w.length || n.length ? { at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), notSaved: n, warnings: w } : EMPTY;
  listeners.forEach((fn) => fn());
}

export function clearImportNotes() {
  recordImportNotes([], []);
}

export function importNoteCount(n: ImportNotes): number {
  return n.notSaved.length + n.warnings.length;
}

export function useImportNotes(): ImportNotes {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => current,
  );
}

/** Expandable banner. `inline` = the plain list used inside Needs Attention. */
export const ImportNotesBanner: React.FC<{ inline?: boolean }> = ({ inline }) => {
  const notes = useImportNotes();
  const [open, setOpen] = useState(false);
  const count = importNoteCount(notes);
  if (!count) return null;
  const urgent = notes.notSaved.length > 0;
  const list = (
    <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 12.5, lineHeight: 1.45 }}>
      {notes.notSaved.map((id) => (
        <li key={`ns-${id}`} style={{ color: "#ff9f0a" }}>
          Website order {id} was claimed on the shop but not saved here. Add it by hand.
        </li>
      ))}
      {notes.warnings.map((w, i) => (
        <li key={`w-${i}`}>{w}</li>
      ))}
    </ul>
  );
  const title = `${count} ${count === 1 ? "note" : "notes"} from the last website import (${notes.at})`;
  if (inline) {
    return (
      <div style={{ padding: 10, borderRadius: 10, background: "rgba(255,159,10,0.08)", border: "1px solid rgba(255,159,10,0.35)" }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
        {list}
      </div>
    );
  }
  return (
    <div
      role="status"
      style={{
        padding: "8px 12px",
        borderRadius: 10,
        background: urgent ? "rgba(255,69,58,0.10)" : "rgba(255,159,10,0.08)",
        border: `1px solid ${urgent ? "rgba(255,69,58,0.45)" : "rgba(255,159,10,0.35)"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="fp-btn fp-btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 1, justifyContent: "flex-start", background: "transparent", border: "none", fontWeight: 700 }}
        >
          {open ? "▼" : "▶"} ⚠️ {title}
        </button>
        <button type="button" className="fp-btn fp-btn-sm" onClick={clearImportNotes}>
          Dismiss
        </button>
      </div>
      {open && list}
    </div>
  );
};
