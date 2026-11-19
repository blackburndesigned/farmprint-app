import React from "react";
import { useLogoDataUrl, useShopSettings } from "../settingsStore";

/** Up to two initials from the shop name ("Maple Street Prints" -> "MS"); "FP" when unnamed. */
export function shopInitials(name: string | undefined | null): string {
  const words = (name || "").trim().split(/[\s\-_.&/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return "FP";
  const first = (w: string) => (w.match(/[\p{L}\p{N}]/u)?.[0] || "").toUpperCase();
  return words.length === 1 ? words[0].replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "FP" : first(words[0]) + first(words[1]);
}

/** Settings › Appearance › Branding logo, or the shop-initials text mark (BrandLogoMark.swift). */
export const BrandLogo: React.FC<{ height?: number; dark?: boolean; onlyCustom?: boolean }> = ({
  height = 28,
  dark,
  onlyCustom,
}) => {
  const url = useLogoDataUrl();
  const settings = useShopSettings();
  if (!url && onlyCustom) return null;
  if (url) return <img src={url} alt="" className="fp-brand-logo" style={{ height }} />;
  return (
    <span className="fp-brand-mark" style={{ fontSize: height * 0.45, color: dark ? "#111" : "#f8fafc" }}>
      {shopInitials(settings.shop_name)}
    </span>
  );
};
