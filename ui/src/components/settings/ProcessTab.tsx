import React, { useState } from "react";
import { FIXED_STEP_REASONS } from "../../settingsStore";
import { ProcessStepSetting, ShopSettings } from "../../types";
import { PROCESS_STEPS } from "../../views/OrdersAndonViews";
import { ColorInput, Section, type Setter, caption, inputStyle } from "./settingsUi";

// --- Process --------------------------------------------------------------------

const builtInSteps = (): ProcessStepSetting[] =>
  PROCESS_STEPS.map((s) => ({ id: s.id, name: s.name, color_hex: s.bg.toUpperCase() }));

export const ProcessTab: React.FC<{ settings: ShopSettings; patch: Setter }> = ({ settings, patch }) => {
  const [newName, setNewName] = useState("");
  const steps = settings.process_steps.length ? settings.process_steps : builtInSteps();
  const builtIn = new Set<string>(PROCESS_STEPS.map((s) => s.id));
  const lastId = PROCESS_STEPS[PROCESS_STEPS.length - 1].id;
  const set = (next: ProcessStepSetting[]) => patch({ process_steps: next });
  const move = (i: number, d: number) => {
    const j = i + d;
    // The closing step always stays last.
    if (j < 0 || j >= steps.length || steps[i].id === lastId || steps[j].id === lastId) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
  };
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const step = { id: `step-${Date.now().toString(36)}`, name, color_hex: "#64748B" };
    const end = steps.findIndex((s) => s.id === lastId);
    const next = [...steps];
    next.splice(end < 0 ? next.length : end, 0, step);
    set(next);
    setNewName("");
  };
  return (
    <>
      <Section
        title="Pipeline"
        footer="These steps appear on ANDON boards and in status pickers. Built-in steps keep order data compatibility. Closed is always the last step and cannot be removed — marking an order Closed moves it to History."
      >
        {steps.map((step, i) => {
          const isEnd = step.id === lastId;
          const fixedReason = FIXED_STEP_REASONS[step.id];
          return (
            <React.Fragment key={step.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, opacity: step.hidden ? 0.6 : 1 }}>
              <ColorInput
                value={step.color_hex}
                title="Step color"
                onChange={(hex) => set(steps.map((s, k) => (k === i ? { ...s, color_hex: hex } : s)))}
              />
              <input
                type="text"
                value={step.name}
                onChange={(e) => set(steps.map((s, k) => (k === i ? { ...s, name: e.target.value } : s)))}
                style={{ ...inputStyle, flex: 1 }}
              />
              {fixedReason && (
                <span
                  title={`${step.name.trim() && step.name.trim() !== step.id ? `Built-in “${step.id}” step. ` : ""}${fixedReason}`}
                  aria-label="Fixed step"
                  style={{ ...caption, cursor: "help", flex: "none" }}
                >
                  🔒
                </span>
              )}
              {isEnd ? (
                <span style={{ ...caption, width: 120, textAlign: "center" }}>End</span>
              ) : (
                <>
                  <button type="button" className="fp-btn fp-btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    disabled={steps[i + 1]?.id === lastId}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <span style={{ width: 56, display: "inline-flex", justifyContent: "center", flex: "none" }}>
                  {fixedReason ? (
                    <label
                      style={{ ...caption, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
                      title={fixedReason}
                    >
                      <input
                        type="checkbox"
                        checked={!!step.hidden}
                        onChange={(e) => set(steps.map((s, k) => (k === i ? { ...s, hidden: e.target.checked } : s)))}
                      />
                      Hide
                    </label>
                  ) : (
                    <button
                      type="button"
                      className="fp-btn fp-btn-sm"
                      disabled={builtIn.has(step.id)}
                      title={builtIn.has(step.id) ? "Built-in steps can't be removed" : "Remove step"}
                      onClick={() => set(steps.filter((_, k) => k !== i))}
                    >
                      ✕
                    </button>
                  )}
                  </span>
                </>
              )}
            </div>
            </React.Fragment>
          );
        })}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={newName}
            placeholder="New step name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" className="fp-btn fp-btn-sm" disabled={!newName.trim()} onClick={add}>
            Add
          </button>
        </div>
      </Section>
      <Section>
        <div>
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            disabled={settings.process_steps.length === 0}
            onClick={() => set([])}
          >
            Reset to default steps
          </button>
        </div>
      </Section>
    </>
  );
};
