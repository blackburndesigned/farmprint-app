import React, { useState } from "react";
import { AppearanceStudio, OutlineStroke, ShopSettings } from "../../types";
import { Check, ColorInput, Row, Section, Segmented, type Setter, caption, chooseLogoPath, inputStyle } from "./settingsUi";
import { notifyBanner } from "../../uiFeedback";
import { errorText } from "../../errorText";
import { DEFAULT_OUTLINE_STROKE, MAX_OUTLINE_STROKES } from "../../thumbnailOutline";

// --- Appearance -----------------------------------------------------------------

type Surface = "window" | "card" | "tile";
const SURFACES: Array<[Surface, string]> = [
  ["window", "Window"],
  ["card", "Cards"],
  ["tile", "Tiles"],
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
function bgCss(v: string): string {
  const p = parseBg(v);
  if (p.kind === "solid") return p.hex;
  if (p.kind === "gradient") {
    if (p.axis === "radial") return `radial-gradient(${p.a}, ${p.b})`;
    const deg = { horizontal: 90, vertical: 180, diagonal: 135, angled: p.angle }[p.axis] ?? 90;
    return `linear-gradient(${deg}deg, ${p.a}, ${p.b})`;
  }
  return "repeating-conic-gradient(#555 0 25%, #333 0 50%) 0 0/10px 10px";
}

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
  const [surface, setSurface] = useState<Surface>("card");
  const st = settings.appearance_studio;
  const setSt = (p: Partial<AppearanceStudio>) => patch({ appearance_studio: { ...st, ...p } });
  const key = (mode: "light" | "dark") => `${surface}_bg_${mode}` as keyof AppearanceStudio;
  const blurKey = `${surface}_bg_blur` as keyof AppearanceStudio;
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
        title="Appearance Studio"
        footer="Window, cards, and tiles each have a Light-mode and Dark-mode background. The system light/dark appearance picks the column."
      >
        <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr", gap: 8, alignItems: "center", fontSize: 12 }}>
          <span />
          <span style={{ fontWeight: 600 }}>Light mode</span>
          <span style={{ fontWeight: 600 }}>Dark mode</span>
          {SURFACES.map(([s, label]) => (
            <React.Fragment key={s}>
              <button
                type="button"
                className={`fp-btn fp-btn-sm ${surface === s ? "fp-btn-primary" : ""}`}
                onClick={() => setSurface(s)}
              >
                {label}
              </button>
              {(["light", "dark"] as const).map((m) => (
                <div
                  key={m}
                  onClick={() => setSurface(s)}
                  style={{
                    height: 26,
                    borderRadius: 6,
                    background: bgCss(String(st[`${s}_bg_${m}` as keyof AppearanceStudio] ?? "")),
                    border: surface === s ? "2px solid #0a84ff" : "1px solid rgba(255,255,255,0.15)",
                    cursor: "pointer",
                  }}
                />
              ))}
            </React.Fragment>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {(["light", "dark"] as const).map((m) => (
            <div key={m} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                {SURFACES.find(([s]) => s === surface)?.[1]} — {m === "light" ? "Light" : "Dark"}
              </div>
              <BgEditor
                value={String(st[key(m)] ?? "")}
                allowGradient={surface !== "window"}
                onChange={(v) => setSt({ [key(m)]: v } as Partial<AppearanceStudio>)}
              />
            </div>
          ))}
        </div>
        <Row label="Blur">
          <input
            type="range"
            min={0}
            max={40}
            value={Number(st[blurKey]) || 0}
            onChange={(e) => setSt({ [blurKey]: parseFloat(e.target.value) } as Partial<AppearanceStudio>)}
          />
          <span style={{ width: 32 }}>{Math.round(Number(st[blurKey]) || 0)}</span>
        </Row>
        <div style={caption}>Softens the color or gradient on this surface. Off when Reduce Transparency is on.</div>
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
      <Section
        title="Order card header frost"
        footer="Uses the system frost. Reduce Transparency or Increase Contrast turns the strip solid; tint still applies."
      >
        <Check
          label="Frost the name strip"
          checked={st.card_header_frost_enabled}
          onChange={(v) => setSt({ card_header_frost_enabled: v })}
        />
        {st.card_header_frost_enabled && (
          <Row label="Tint">
            <Segmented
              value={st.card_header_frost_tint || "none"}
              options={[
                ["none", "None"],
                ["light", "Light"],
                ["dark", "Dark"],
                ["custom", "Custom"],
              ]}
              onChange={(v) => setSt({ card_header_frost_tint: v })}
            />
            {st.card_header_frost_tint === "custom" && (
              <ColorInput
                value={st.card_header_frost_custom_hex}
                onChange={(hex) => setSt({ card_header_frost_custom_hex: hex })}
              />
            )}
          </Row>
        )}
      </Section>
    </>
  );
};
