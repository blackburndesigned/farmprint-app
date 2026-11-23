import React, { useEffect, useState } from "react";
import type { Printer } from "../../types";
import {
  CLEARANCE_KEYS, CLEARANCE_LABEL, type ClearanceKey, type ExtruderClearance, type PlateEntry, clearanceFallback, clearanceOf,
  parseClearance,
} from "./extruderClearance";

const toText = (c: ExtruderClearance) =>
  Object.fromEntries(CLEARANCE_KEYS.map((k) => [k, c[k] === null ? "" : String(c[k])])) as Record<ClearanceKey, string>;

/**
 * The printer's four by-object extruder clearance fields (slicer names, mm). Empty by
 * default; an empty field's placeholder shows what the plate view uses instead, where it
 * has a value. Saves when focus leaves the group (or on Enter).
 */
export const ExtruderClearanceFields: React.FC<{
  printer: Printer;
  plate: PlateEntry;
  inputStyle?: React.CSSProperties;
  onCommit: (c: ExtruderClearance) => void;
}> = ({ printer, plate, inputStyle, onCommit }) => {
  const saved = clearanceOf(printer);
  const savedKey = JSON.stringify(saved);
  const [text, setText] = useState(() => toText(saved));
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setText(toText(saved)), [savedKey]);

  const commit = () => {
    const parsed = parseClearance(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (JSON.stringify(parsed) !== savedKey) onCommit(parsed);
  };

  return (
    <div
      className="fp-form-group"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
      }}
    >
      {CLEARANCE_KEYS.map((k) => {
        const fallback = clearanceFallback(k, plate);
        return (
          <label key={k} className="fp-form-row">
            <span>{CLEARANCE_LABEL[k]}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input
                type="text"
                inputMode="decimal"
                aria-label={`${CLEARANCE_LABEL[k]} (mm)`}
                placeholder={fallback === null ? "" : String(fallback)}
                value={text[k]}
                onChange={(e) => setText((t) => ({ ...t, [k]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && commit()}
                style={{ width: 72, textAlign: "right", ...inputStyle }}
              />
              <span style={{ fontSize: 11.5, opacity: 0.7 }}>mm</span>
            </span>
          </label>
        );
      })}
      {error && <div style={{ fontSize: 11, color: "#ff6961", padding: "4px 12px 6px" }}>{error}</div>}
    </div>
  );
};
