import React from "react";
import { Field, FormSection, chipButton, fieldStyle } from "./importFormUi";

/** Step 1 (Details): name, price, cost and categories. */
export const DetailsStep: React.FC<{
  productName: string;
  setProductName: React.Dispatch<React.SetStateAction<string>>;
  costText: string;
  setCostText: React.Dispatch<React.SetStateAction<string>>;
  basePriceUsd: number;
  setBasePriceUsd: React.Dispatch<React.SetStateAction<number>>;
  categories: string[];
  setCategories: React.Dispatch<React.SetStateAction<string[]>>;
  categoryDraft: string;
  setCategoryDraft: React.Dispatch<React.SetStateAction<string>>;
}> = ({ productName, setProductName, costText, setCostText, basePriceUsd, setBasePriceUsd, categories, setCategories, categoryDraft, setCategoryDraft }) => (
  <div style={{ padding: "8px 12px 16px" }}>
    <FormSection title="Product">
      <Field label="Name">
        <input value={productName} onChange={(event) => setProductName(event.target.value)} style={fieldStyle} />
      </Field>
      <Field label="Cost to Produce">
        <input value={costText} inputMode="decimal" placeholder="0.00" onChange={(event) => setCostText(event.target.value)} style={{ ...fieldStyle, textAlign: "right" }} />
      </Field>
      <Field label="Price">
        <input
          value={Number.isFinite(basePriceUsd) ? String(basePriceUsd) : ""}
          inputMode="decimal"
          placeholder="0.00"
          onChange={(event) => setBasePriceUsd(parseFloat(event.target.value) || 0)}
          style={{ ...fieldStyle, textAlign: "right" }}
        />
      </Field>
    </FormSection>
    <FormSection title="Categories">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {categories.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setCategories((prev) => prev.filter((entry) => entry !== item))}
            style={chipButton(true)}
          >
            {item} ×
          </button>
        ))}
      </div>
      <input
        value={categoryDraft}
        placeholder="Add a category"
        onChange={(event) => setCategoryDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const next = categoryDraft.trim();
          if (!next) return;
          setCategories((prev) => (prev.includes(next) ? prev : [...prev, next]));
          setCategoryDraft("");
        }}
        style={fieldStyle}
      />
    </FormSection>
  </div>
);
