import React from "react";
import { DockTab } from "./shared";

export { SettingsModal } from "./SettingsModal";

export const BottomDockBar: React.FC<{
  activeTab: DockTab;
  onSelectTab: (tab: DockTab) => void;
  badges: Record<DockTab, number | undefined>;
}> = ({ activeTab, onSelectTab, badges }) => {
  const items: Array<{ id: DockTab; icon: string; label: string }> = [
    { id: "orders", icon: "📋", label: "All Orders" },
    { id: "andon", icon: "🚥", label: "ANDON" },
    { id: "printers", icon: "🖨️", label: "Printers" },
    { id: "parts", icon: "🧩", label: "Parts to Print" },
    { id: "overstock", icon: "📦", label: "Overstock" },
    { id: "flow", icon: "⚡", label: "Flow" },
    { id: "products", icon: "🎨", label: "Products" },
    { id: "ready", icon: "🚚", label: "Ready to Ship" },
    { id: "history", icon: "🕓", label: "History" },
    { id: "value", icon: "💰", label: "Production Value" },
  ];

  return (
    <nav className="fp-dock-wrap">
      <div className="fp-dock">
        {items.map((item) => {
          const badge = badges[item.id];
          return (
            <button
              key={item.id}
              className={`fp-dock-btn ${activeTab === item.id ? "active" : ""}`}
              onClick={() => onSelectTab(item.id)}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
              {badge !== undefined && badge > 0 && (
                <span className="fp-dock-badge">{badge}</span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

// Moved to smaller modules; re-exported so existing importers keep working.
export { UnitStatePopover } from "./modals/UnitStatePopover";
export { SuggestedGroupsOverlayModal } from "./modals/SuggestedGroupsOverlayModal";
export { KittingCardModal } from "./modals/KittingCardModal";
export { OrderModals } from "./modals/OrderModals";
