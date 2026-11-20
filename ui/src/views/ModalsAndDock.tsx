import React from "react";
import { DockTab } from "./shared";
import { DOCK_TABS } from "../components/DockAndHeader";
import { Icon } from "../icons";

export { SettingsModal } from "./SettingsModal";

export const BottomDockBar: React.FC<{
  activeTab: DockTab;
  onSelectTab: (tab: DockTab) => void;
  badges: Record<DockTab, number | undefined>;
}> = ({ activeTab, onSelectTab, badges }) => {
  // Same destinations and Lucide icons as the main dock (DockAndHeader DOCK_TABS), minus People.
  const items = DOCK_TABS.filter((t) => t.id !== "people");

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
              <Icon icon={item.icon} size={18} />
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
