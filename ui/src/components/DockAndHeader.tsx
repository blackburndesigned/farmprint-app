import React, { useEffect, useState } from "react";
import "../index.css";
import { BrandLogo } from "./BrandLogo";
import { shortcut } from "../platform";
import { isTypingTarget } from "../uiFeedback";

export type DockTab =
  | "orders" | "andon" | "printers" | "parts" | "overstock"
  | "flow" | "products" | "ready" | "history" | "value"
  | "people" | "settings" | "go";

export interface DockTabSpec {
  id: DockTab;
  icon: string;
  label: string;
  shortcut?: string;
}

export const DOCK_TABS: DockTabSpec[] = [
  { id: "orders", icon: "📋", label: "All Orders", shortcut: shortcut("1") },
  { id: "andon", icon: "🚥", label: "ANDON", shortcut: shortcut("2") },
  { id: "printers", icon: "🖨️", label: "Printers", shortcut: shortcut("3") },
  { id: "parts", icon: "🧩", label: "Parts to Print", shortcut: shortcut("4") },
  { id: "overstock", icon: "📦", label: "Overstock", shortcut: shortcut("5") },
  { id: "flow", icon: "⚡", label: "Flow", shortcut: shortcut("6") },
  { id: "products", icon: "🎨", label: "Products", shortcut: shortcut("7") },
  { id: "ready", icon: "🚚", label: "Ready to Ship", shortcut: shortcut("8") },
  { id: "history", icon: "🕓", label: "History", shortcut: shortcut("9") },
  { id: "value", icon: "💰", label: "Production Value", shortcut: shortcut("0") },
  { id: "people", icon: "👤", label: "People", shortcut: shortcut("P", true) },
];

export const ORDER_STATUS_PILLS = ["All", "Waiting", "Printing", "Ready to Ship"] as const;

export const STATUS_LEGEND_STEPS = [
  { label: "In Queue", color: "#475569" },
  { label: "Staged", color: "#d97706" },
  { label: "Printing", color: "#2563eb" },
  { label: "Printed", color: "#0d9488" },
  { label: "Post-Process", color: "#7c3aed" },
  { label: "Closed / Ready", color: "#16a34a" },
] as const;

const chromeBridge: {
  tabChange: ((tab: DockTab) => void) | null;
  wallMode: boolean;
  listeners: Set<() => void>;
} = { tabChange: null, wallMode: false, listeners: new Set() };

function setBridgeWallMode(next: boolean) {
  if (chromeBridge.wallMode === next) return;
  chromeBridge.wallMode = next;
  document.body.classList.toggle("fp-wall-mode", next);
  chromeBridge.listeners.forEach((fn) => fn());
}

export interface TopHeaderProps {
  activeTab?: DockTab | string;
  onTabChange?: (tab: DockTab) => void;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  statusFilter?: string;
  onStatusFilterChange?: (status: string) => void;
  statusCounts?: Record<string, number>;
  wallMode?: boolean;
  andonWallMode?: boolean;
  onToggleWallMode?: (wall: boolean) => void;
  wallTextSize?: "S" | "M" | "L";
  onWallTextSizeChange?: (size: "S" | "M" | "L") => void;
  ordersCount?: number;
  waitingPartsCount?: number;
  totalPartsCount?: number;
  bannerMessage?: string | null;
  /** Banner reports a failure: no ✓, error styling. */
  bannerIsError?: boolean;
  /** Undo for the action this banner reports. Only passed for transition banners. */
  onBannerUndo?: () => void;
  /** Cmd/Ctrl-Z: undo the newest action that can still be undone. */
  onUndoLastAction?: () => void;
  onOpenPrintGroups?: () => void;
  onOpenImportModal?: () => void;
  onOpenNewOrderModal?: () => void;
  onOpenFilamentLibrary?: () => void;
  onOpenSettings?: () => void;
  showStatusPills?: boolean;
  rightSlot?: React.ReactNode;
}

/**
 * Keyboard shortcut controller + Wall TV hover bar + toast banner.
 * Per-view headers (`OrdersListView`, `AndonBoardView`, `PrinterLanesView`, `PartsToPrintView`, etc.)
 * own their own single toolbar and single `StatusLegendHeader`, matching Swift `AppShellView.swift` 1:1
 * without duplicate top-bar controls or duplicate status legends.
 */
export const TopHeader: React.FC<TopHeaderProps> = ({
  activeTab = "orders",
  onTabChange,
  wallMode,
  andonWallMode,
  onToggleWallMode,
  wallTextSize: controlledSize,
  onWallTextSizeChange,
  bannerMessage,
  bannerIsError,
  onBannerUndo,
  onUndoLastAction,
  onOpenSettings,
}) => {
  const [localWall, setLocalWall] = useState(false);
  const [localSize, setLocalSize] = useState<"S" | "M" | "L">("M");

  const propWall = wallMode ?? andonWallMode;
  const isWall = propWall !== undefined ? propWall : localWall;
  const wallSize = controlledSize ?? localSize;
  const switchTab = (tab: DockTab) =>
    onTabChange ? onTabChange(tab) : chromeBridge.tabChange?.(tab);

  const applyWallMode = (next: boolean) => {
    setLocalWall(next);
    setBridgeWallMode(next);
    if (next && activeTab !== "andon" && activeTab !== "printers") switchTab("andon");
    onToggleWallMode?.(next);
    window.dispatchEvent(new CustomEvent("fp-wall-mode", { detail: next }));
  };

  useEffect(() => {
    setBridgeWallMode(Boolean(isWall));
  }, [isWall]);

  useEffect(() => {
    const scale = wallSize === "L" ? "1.18" : wallSize === "S" ? "0.94" : "1.06";
    document.documentElement.style.setProperty("--fp-wall-scale", scale);
  }, [wallSize]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isWall) {
        applyWallMode(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        // Text fields keep their own undo; never move a part while someone is typing.
        if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
        // A dialog is open: its fields and buttons own the keyboard.
        if (document.querySelector('[role="alertdialog"]')) return;
        if (onUndoLastAction) {
          e.preventDefault();
          onUndoLastAction();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        onOpenSettings?.();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[0-9]$/.test(e.key)) {
        const idx = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
        const target = DOCK_TABS[idx];
        if (target) {
          e.preventDefault();
          if (isWall) applyWallMode(false);
          switchTab(target.id);
        }
      }
    };
    const onDocClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest(".fp-mode-btn");
      if (!btn) return;
      const txt = (btn.textContent || "").trim().toLowerCase();
      if (txt === "wall" || txt === "wall tv") setBridgeWallMode(true);
      else if (txt === "work") setBridgeWallMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocClick, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocClick, true);
    };
  }, [isWall, activeTab, onOpenSettings, onUndoLastAction]);

  if (isWall) {
    return (
      <div className="fp-wall-hover-pill" role="region" aria-label="Wall display controls">
        <div className="fp-mode-toggle">
          <button type="button" className="fp-mode-btn" onClick={() => applyWallMode(false)}>
            Work
          </button>
          <button type="button" className="fp-mode-btn active">
            Wall TV
          </button>
        </div>
        <div className="fp-mode-toggle" title="Wall TV text scale">
          {(["S", "M", "L"] as const).map((sz) => (
            <button
              key={sz}
              type="button"
              className={`fp-mode-btn ${wallSize === sz ? "active" : ""}`}
              onClick={() => {
                setLocalSize(sz);
                onWallTextSizeChange?.(sz);
              }}
            >
              {sz}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="fp-btn fp-btn-sm"
          onClick={() => switchTab(activeTab === "printers" ? "andon" : "printers")}
        >
          {activeTab === "printers" ? "🚥 ANDON Wall" : "🖨️ Printers Wall"}
        </button>
        <button
          type="button"
          className="fp-btn fp-btn-sm fp-btn-primary"
          onClick={() => applyWallMode(false)}
        >
          Exit Wall (Esc)
        </button>
      </div>
    );
  }

  return (
    <>
      {bannerMessage && (
        <div
          style={{
            position: "fixed",
            bottom: 62,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1100,
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 14px",
            borderRadius: 999,
            background: "rgba(22, 27, 36, 0.96)",
            border: bannerIsError ? "1px solid rgba(255, 69, 58, 0.6)" : "1px solid rgba(56, 189, 248, 0.45)",
            boxShadow: "0 10px 28px rgba(0, 0, 0, 0.5)",
            color: "#f8fafc",
            fontSize: 12.5,
            fontWeight: 600,
            maxWidth: "min(760px, 92vw)",
          }}
        >
          <span role={bannerIsError ? "alert" : "status"}>{bannerIsError ? "⚠︎ " : "✓ "}{bannerMessage}</span>
          {onBannerUndo && !bannerIsError && (
            <button
              type="button"
              className="fp-btn fp-btn-sm"
              style={{ height: 22, padding: "0 8px", fontSize: 11 }}
              onClick={onBannerUndo}
              title={`Undo (${shortcut("Z")})`}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </>
  );
};

export interface BottomDockProps {
  activeTab: DockTab | string;
  onTabChange: (tab: DockTab) => void;
  badges?: Partial<Record<DockTab, number>>;
  wallMode?: boolean;
  onOpenFilamentLibrary?: () => void;
  onOpenSettings?: () => void;
}

const DOCK_SVG_ICONS: Record<string, React.ReactNode> = {
  orders: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <line x1="7" y1="9" x2="10" y2="9" />
      <line x1="13" y1="9" x2="17" y2="9" />
      <line x1="7" y1="13" x2="10" y2="13" />
      <line x1="13" y1="13" x2="17" y2="13" />
    </svg>
  ),
  andon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v3M4.93 4.93l2.12 2.12M19.07 4.93l-2.12 2.12M2 12h3M19 12h3" />
      <path d="M8 14a4 4 0 1 1 8 0v4H8v-4z" />
      <line x1="6" y1="20" x2="18" y2="20" />
    </svg>
  ),
  printers: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9V3h12v6" />
      <rect x="3" y="9" width="18" height="9" rx="2" />
      <path d="M6 15h12v6H6z" />
    </svg>
  ),
  parts: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  overstock: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="5" rx="1.5" />
      <path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  ),
  flow: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 2 21 6 17 10" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 22 3 18 7 14" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  products: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  ),
  ready: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="14" height="12" rx="1.5" />
      <polygon points="15 8 19 8 23 12 23 16 15 16 15 8" />
      <circle cx="5.5" cy="18" r="2" />
      <circle cx="18.5" cy="18" r="2" />
    </svg>
  ),
  history: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  ),
  value: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9.5c-.5-1.2-1.7-2-3-2-1.8 0-3 1-3 2.3 0 3 6 1.8 6 4.9 0 1.4-1.3 2.3-3 2.3-1.5 0-2.7-.8-3.2-2" />
      <line x1="12" y1="6" x2="12" y2="18" />
    </svg>
  ),
  people: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M7 18.5c1.2-2 3-3 5-3s3.8 1 5 3" />
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

/**
 * 1:1 port of `BottomTabBar.swift`:
 * Full-width shop-floor tab strip — every destination visible, no scroll,
 * rounded 18pt glass pill (`padding(.horizontal, 10).padding(.bottom, 8)`),
 * `HStack(spacing: 2)` of `VStack(spacing: 4)` with 20pt SF-Symbol icon + 10pt bold/semibold label,
 * `RoundedRectangle(cornerRadius: 12)` fill `accentColor.opacity(0.22)` when selected.
 */
export const BottomDock: React.FC<BottomDockProps> = ({
  activeTab,
  onTabChange,
  wallMode,
  onOpenSettings,
}) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    chromeBridge.tabChange = onTabChange;
    const sub = () => setTick((t) => t + 1);
    chromeBridge.listeners.add(sub);
    return () => {
      chromeBridge.listeners.delete(sub);
    };
  }, [onTabChange]);

  const hidden = wallMode !== undefined ? wallMode : chromeBridge.wallMode;
  if (hidden) return null;

  return (
    <div className="fp-dock-wrap">
      <nav className="fp-dock" aria-label="Main navigation">
        <BrandLogo height={26} onlyCustom />
        {DOCK_TABS.map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`fp-dock-item ${isActive ? "active" : ""}`}
              onClick={() => onTabChange(t.id)}
              title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
            >
              <span className="fp-dock-icon">{DOCK_SVG_ICONS[t.id] || t.icon}</span>
              <span className="fp-dock-label">{t.label}</span>
            </button>
          );
        })}
        {onOpenSettings && (
          <button
            type="button"
            className="fp-dock-item"
            onClick={onOpenSettings}
            title={`Settings (${shortcut(",")})`}
          >
            <span className="fp-dock-icon">{DOCK_SVG_ICONS.settings}</span>
            <span className="fp-dock-label">Settings</span>
          </button>
        )}
      </nav>
    </div>
  );
};

/** Settings › General › Navigation = "Sidebar": classic left list of destinations. */
export const SidebarNav: React.FC<BottomDockProps> = ({ activeTab, onTabChange, badges, onOpenSettings }) => {
  useEffect(() => {
    chromeBridge.tabChange = onTabChange;
  }, [onTabChange]);
  return (
    <nav className="fp-sidebar" aria-label="Main navigation">
      <div className="fp-sidebar-brand">
        <BrandLogo height={32} />
      </div>
      {DOCK_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`fp-sidebar-item ${activeTab === t.id ? "active" : ""}`}
          onClick={() => onTabChange(t.id)}
          title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
        >
          <span style={{ width: 18, display: "inline-flex", justifyContent: "center" }}>
            {DOCK_SVG_ICONS[t.id] || t.icon}
          </span>
          <span>{t.label}</span>
          {badges?.[t.id] ? <span className="fp-sidebar-badge">{badges[t.id]}</span> : null}
        </button>
      ))}
      <div className="fp-sidebar-spacer" />
      {onOpenSettings && (
        <button type="button" className="fp-sidebar-item" onClick={onOpenSettings} title={`Settings (${shortcut(",")})`}>
          <span style={{ width: 18, display: "inline-flex", justifyContent: "center" }}>{DOCK_SVG_ICONS.settings}</span>
          <span>Settings</span>
        </button>
      )}
    </nav>
  );
};
