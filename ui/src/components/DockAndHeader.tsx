import React, { useEffect, useRef, useState } from "react";
import "../index.css";
import { BrandLogo } from "./BrandLogo";
import { shortcut } from "../platform";
import { isTypingTarget } from "../uiFeedback";
import { Archive, Box, Check, CircleDollarSign, CircleUser, ClipboardList, History, LayoutGrid, Printer, Repeat, Settings, Siren, Truck, TriangleAlert, type LucideIcon } from "lucide-react";
import { Icon } from "../icons";

export type DockTab =
  | "orders" | "andon" | "printers" | "parts" | "overstock"
  | "flow" | "products" | "ready" | "history" | "value"
  | "people" | "settings" | "go";

export interface DockTabSpec {
  id: DockTab;
  /** Lucide icon (icons.tsx), drawn at 20 px in the dock and 18 px in the sidebar. */
  icon: LucideIcon;
  label: string;
  shortcut?: string;
}

export const DOCK_TABS: DockTabSpec[] = [
  { id: "orders", icon: ClipboardList, label: "All Orders", shortcut: shortcut("1") },
  { id: "andon", icon: Siren, label: "ANDON", shortcut: shortcut("2") },
  { id: "printers", icon: Printer, label: "Printers", shortcut: shortcut("3") },
  { id: "parts", icon: LayoutGrid, label: "Parts to Print", shortcut: shortcut("4") },
  { id: "overstock", icon: Archive, label: "Overstock", shortcut: shortcut("5") },
  { id: "flow", icon: Repeat, label: "Flow", shortcut: shortcut("6") },
  { id: "products", icon: Box, label: "Products", shortcut: shortcut("7") },
  { id: "ready", icon: Truck, label: "Ready to Ship", shortcut: shortcut("8") },
  { id: "history", icon: History, label: "History", shortcut: shortcut("9") },
  { id: "value", icon: CircleDollarSign, label: "Production Value", shortcut: shortcut("0") },
  { id: "people", icon: CircleUser, label: "People", shortcut: shortcut("P", true) },
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

/** Wall TV controls hide this long after the last mouse movement or key press. */
const WALL_CONTROLS_IDLE_MS = 2500;

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

  // Wall TV: the one set of view controls shows on mouse movement (or a key press) and hides
  // after WALL_CONTROLS_IDLE_MS, but never while the pointer is over it or it has keyboard
  // focus. Esc always leaves Wall TV.
  const [wallControlsShown, setWallControlsShown] = useState(true);
  const wallPillRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isWall) return;
    let timer: number | undefined;
    let pointer: { x: number; y: number } | null = null;
    const wake = (e?: Event) => {
      if (e instanceof MouseEvent) pointer = { x: e.clientX, y: e.clientY };
      setWallControlsShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(hideIfIdle, WALL_CONTROLS_IDLE_MS);
    };
    const hideIfIdle = () => {
      const pill = wallPillRef.current;
      const r = pill?.getBoundingClientRect();
      const pointerOver =
        !!r && !!pointer && pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
      if (pointerOver || pill?.matches(":focus-within")) {
        timer = window.setTimeout(hideIfIdle, WALL_CONTROLS_IDLE_MS);
        return;
      }
      setWallControlsShown(false);
    };
    // The pointer left the window: it is no longer over the controls.
    const forgetPointer = () => {
      pointer = null;
    };
    wake();
    const events = ["mousemove", "mousedown", "touchstart", "keydown", "wheel"] as const;
    events.forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
    document.documentElement.addEventListener("mouseleave", forgetPointer);
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, wake));
      document.documentElement.removeEventListener("mouseleave", forgetPointer);
    };
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
      <div
        ref={wallPillRef}
        className={`fp-wall-hover-pill${wallControlsShown ? " is-shown" : ""}`}
        role="region"
        aria-label="Wall display controls"
      >
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
          <Icon icon={activeTab === "printers" ? Siren : Printer} />
          {activeTab === "printers" ? "ANDON Wall" : "Printers Wall"}
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
          <span role={bannerIsError ? "alert" : "status"} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon icon={bannerIsError ? TriangleAlert : Check} size={15} style={{ color: bannerIsError ? "#ff6961" : "#38bdf8" }} />
            <span>{bannerMessage}</span>
          </span>
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
              <span className="fp-dock-icon"><Icon icon={t.icon} size={20} /></span>
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
            <span className="fp-dock-icon"><Icon icon={Settings} size={20} /></span>
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
            <Icon icon={t.icon} size={18} />
          </span>
          <span>{t.label}</span>
          {badges?.[t.id] ? <span className="fp-sidebar-badge">{badges[t.id]}</span> : null}
        </button>
      ))}
      <div className="fp-sidebar-spacer" />
      {onOpenSettings && (
        <button type="button" className="fp-sidebar-item" onClick={onOpenSettings} title={`Settings (${shortcut(",")})`}>
          <span style={{ width: 18, display: "inline-flex", justifyContent: "center" }}><Icon icon={Settings} size={18} /></span>
          <span>Settings</span>
        </button>
      )}
    </nav>
  );
};
