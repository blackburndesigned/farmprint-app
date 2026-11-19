import React from "react";
import { Order } from "../../types";
import { fmtUsd } from "../../views/shared";
import { groupCustomers } from "../../shopHelpers";

export const PeopleView: React.FC<{
  orders: Order[];
  onSelectOrder: (orderId: string) => void;
}> = ({ orders, onSelectOrder }) => {
  const customers = groupCustomers(orders);

  return (
    <div className="fp-scroll" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>People ({customers.length})</div>
        <div style={{ fontSize: 12, color: "rgba(235,235,245,0.6)" }}>
          Customers, their orders, and what they've spent with you
        </div>
      </div>
      {customers.length === 0 && (
        <div className="fp-card" style={{ padding: 28, textAlign: "center", color: "rgba(235,235,245,0.6)" }}>
          No customers yet. They show up here after their first order.
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
          gap: 12,
        }}
      >
        {customers.map((c) => (
          <div key={`${c.email.toLowerCase()}|${c.name}`} className="fp-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 700 }}>{c.name}</div>
                {c.email && <div style={{ fontSize: 11.5, color: "rgba(235,235,245,0.55)" }}>{c.email}</div>}
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#30d158" }}>
                {fmtUsd(c.totalCents)}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {c.orders.map((ord) => (
                <button
                  key={ord.id}
                  type="button"
                  className="fp-btn fp-btn-sm"
                  onClick={() => onSelectOrder(ord.id)}
                >
                  {ord.order_code} ({ord.overall_state})
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
