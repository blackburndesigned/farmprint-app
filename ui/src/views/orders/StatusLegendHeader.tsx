import React from "react";
import { getProcessSteps } from "../../settingsStore";

export const StatusLegendHeader: React.FC = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "6px 18px 8px",
      flexWrap: "wrap",
    }}
  >
    <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(235,235,245,0.62)" }}>
      Status
    </span>
    {getProcessSteps().map((st) => (
      <span
        key={st.id}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          fontWeight: 500,
          color: "rgba(235,235,245,0.72)",
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            border: `2.5px solid ${st.bg}`,
            display: "inline-block",
          }}
        />
        {st.name}
      </span>
    ))}
  </div>
);
