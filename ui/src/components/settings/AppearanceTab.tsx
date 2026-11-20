import React from "react";
import { AppearanceStudio, OutlineStroke, ShopSettings } from "../../types";
import { Check, ColorInput, Row, Section, Segmented, type Setter, chooseLogoPath, inputStyle } from "./settingsUi";
import { notifyBanner } from "../../uiFeedback";
import { errorText } from "../../errorText";
import { resolveTheme, savedThemeChoice, systemPrefersDark, type ThemeMode } from "../../theme";
import { DEFAULT_OUTLINE_STROKE, MAX_OUTLINE_STROKES } from "../../thumbnailOutline";

// --- Appearance -----------------------------------------------------------------

const THEME_OPTIONS: Array<[ThemeMode, string]> = [
  ["light", "Light"],
  ["dark", "Dark"],
];
const AXES: Array<[string, string]> = [
  ["horizontal", "Horizontal"],
  ["vertical", "Vertical"],
  ["diagonal", "Diagonal"],
  ["radial", "Radial"],
  ["angled", "Angle"],
];

interface ParsedBg {
  kind: "system" | "solid" | "gradient";
  hex: string;
  axis: string;
  angle: number;
  a: string;
  b: string;
}
function parseBg(v: string): ParsedBg {
  const base: ParsedBg = { kind: "system", hex: "#808080", axis: "horizontal", angle: 135, a: "#FFFFFF", b: "#1A1A1A" };
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return { ...base, kind: "solid", hex: v };
  const m = /^gradient:([a-z]+):(\d+(?:\.\d+)?):(#[0-9a-fA-F]{6}),(#[0-9a-fA-F]{6})$/.exec(v);
  if (m) return { ...base, kind: "gradient", axis: m[1], angle: parseFloat(m[2]), a: m[3], b: m[4] };
  return base;
}
const gradientToken = (p: ParsedBg) => `gradient:${p.axis}:${Math.round(p.angle)}:${p.a},${p.b}`;
const BgEditor: React.FC<{ value: string; onChange: (v: string) => void; allowGradient: boolean }> = ({
  value,
  onChange,
  allowGradient,
}) => {
  const p = parseBg(value);
  const kinds: Array<[ParsedBg["kind"], string]> = allowGradient
    ? [
        ["system", "System"],
        ["solid", "Solid"],
        ["gradient", "Gradient"],
      ]
    : [
        ["system", "System"],
        ["solid", "Solid"],
      ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Segmented
        value={p.kind}
        options={kinds}
        onChange={(k) => onChange(k === "system" ? "" : k === "solid" ? p.hex : gradientToken(p))}
      />
      {p.kind === "solid" && <ColorInput value={p.hex} onChange={(hex) => onChange(hex)} />}
      {p.kind === "gradient" && (
        <>
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
            <ColorInput value={p.a} title="Start" onChange={(a) => onChange(gradientToken({ ...p, a }))} />
            <ColorInput value={p.b} title="End" onChange={(b) => onChange(gradientToken({ ...p, b }))} />
            <select
              value={p.axis}
              onChange={(e) => onChange(gradientToken({ ...p, axis: e.target.value }))}
              style={{ ...inputStyle, width: 120 }}
            >
              {AXES.map(([a, l]) => (
                <option key={a} value={a}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {p.axis === "angled" && (
            <Row label="Angle">
              <input
                type="range"
                min={0}
                max={360}
                value={p.angle}
                onChange={(e) => onChange(gradientToken({ ...p, angle: parseFloat(e.target.value) }))}
              />
              <span style={{ width: 40 }}>{Math.round(p.angle)}°</span>
            </Row>
          )}
        </>
      )}
    </div>
  );
};

export const AppearanceTab: React.FC<{ settings: ShopSettings; patch: Setter }> = ({ settings, patch }) => {
  const st = settings.appearance_studio;
  const systemDark = systemPrefersDark();
  const choice = savedThemeChoice(settings.appearance_mode);
  const shown = resolveTheme(settings.appearance_mode, systemDark);
  const setSt = (p: Partial<AppearanceStudio>) => patch({ appearance_studio: { ...st, ...p } });
  const strokes = st.tile_outline_strokes;
  const setStroke = (i: number, s: Partial<OutlineStroke>) =>
    setSt({ tile_outline_strokes: strokes.map((x, k) => (k === i ? { ...x, ...s } : x)) });

  const importLogo = async () => {
    try {
      const path = await chooseLogoPath("Choose a logo image.");
      if (path) patch({ logo_path: path });
    } catch (e) {
      notifyBanner(errorText(e), { error: true });
    }
  };

  return (
    <>
      <Section
        title="Appearance"
        footer={
          choice
            ? "FarmPrint stays in this mode whatever your computer is set to."
            : `Not chosen yet, so FarmPrint follows your computer (${systemDark ? "dark" : "light"} right now). Picking one keeps it.`
        }
      >
        <div className="fp-theme-picker" role="radiogroup" aria-label="Appearance">
          {THEME_OPTIONS.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={shown === mode}
              className={`fp-theme-option ${shown === mode ? "active" : ""}`}
              onClick={() => patch({ appearance_mode: mode })}
            >
              <span className={`fp-theme-preview fp-theme-preview-${mode}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="fp-theme-label">{label}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section
        title="Order card part tiles"
        footer="Part thumbnails on order cards scale to fill the card width at 3 or 4 columns. Card width does not change. Grids taller than 3 rows expand on hover."
      >
        <Row label="Part columns">
          <Segmented
            value={settings.part_grid_preferred_columns === 4 ? 4 : 3}
            options={[
              [3, "3 columns"],
              [4, "4 columns"],
            ]}
            onChange={(v) => patch({ part_grid_preferred_columns: v })}
          />
        </Row>
      </Section>
      <Section
        title="Branding"
        footer="Shown at the top of every page. PNG/JPEG with a transparent background works best."
      >
        <Row label="Logo">
          <span style={{ fontSize: 11.5, wordBreak: "break-all" }}>{settings.logo_path || "Default"}</span>
        </Row>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="fp-btn fp-btn-sm" onClick={importLogo}>
            Import Logo…
          </button>
          <button
            type="button"
            className="fp-btn fp-btn-sm"
            disabled={!settings.logo_path}
            onClick={() => patch({ logo_path: "" })}
          >
            Reset to default
          </button>
        </div>
      </Section>
      <Section
        title="Thumbnail outline"
        footer="First outline sits against the part. Later outlines stack outward. Each can be a solid color or a gradient. Following status paints every stroke in the part’s process color and hides the tile ring."
      >
        <Check
          label="Outline part thumbnails"
          checked={st.tile_outline_enabled}
          onChange={(v) =>
            setSt(
              v && strokes.length === 0
                ? { tile_outline_enabled: true, tile_outline_strokes: [{ ...DEFAULT_OUTLINE_STROKE }] }
                : { tile_outline_enabled: v }
            )
          }
        />
        {st.tile_outline_enabled && (
          <>
            <Check
              label="Outline follows part status"
              checked={st.tile_outline_follows_status}
              onChange={(v) => setSt({ tile_outline_follows_status: v })}
            />
            {strokes.map((s, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600 }}>
                  Outline {i + 1}
                  <button
                    type="button"
                    className="fp-btn fp-btn-sm"
                    onClick={() => setSt({ tile_outline_strokes: strokes.filter((_, k) => k !== i) })}
                  >
                    Remove
                  </button>
                </div>
                {!st.tile_outline_follows_status && (
                  <BgEditor
                    value={s.color}
                    allowGradient
                    onChange={(v) => setStroke(i, { color: v })}
                  />
                )}
                <Row label="Weight">
                  <input
                    type="range"
                    min={0}
                    max={12}
                    step={0.5}
                    value={s.weight}
                    onChange={(e) => setStroke(i, { weight: parseFloat(e.target.value) })}
                  />
                  <span style={{ width: 32 }}>{s.weight}</span>
                </Row>
                <Row label="Opacity">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={s.opacity}
                    onChange={(e) => setStroke(i, { opacity: parseFloat(e.target.value) })}
                  />
                  <span style={{ width: 32 }}>{Math.round(s.opacity * 100)}%</span>
                </Row>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="fp-btn fp-btn-sm"
                disabled={strokes.length >= MAX_OUTLINE_STROKES}
                onClick={() => setSt({ tile_outline_strokes: [...strokes, { ...DEFAULT_OUTLINE_STROKE }] })}
              >
                Add outline
              </button>
            </div>
          </>
        )}
      </Section>
    </>
  );
};
