// Pure helpers behind the shop screens (Catalog, People). No React or Tauri imports, so
// ui/scripts/tests can run them in Node.
import type { Order } from "./types";

/** Price text as cents, or null when it isn't a usable amount. */
export function parsePriceCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return null;
  const cents = Math.round(parseFloat(t) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

export type Customer = { name: string; email: string; orders: Order[]; totalCents: number };

/** One card per customer: same email (any case) = same person; no email = same name. */
export function groupCustomers(orders: Order[]): Customer[] {
  const byCustomer = new Map<string, Customer>();
  for (const o of orders) {
    const email = (o.customer_email || "").trim();
    const key = email ? `e:${email.toLowerCase()}` : `n:${(o.customer_name || "").trim().toLowerCase()}`;
    const entry = byCustomer.get(key) || { name: o.customer_name, email, orders: [], totalCents: 0 };
    entry.orders.push(o);
    entry.totalCents += o.total_revenue_cents;
    byCustomer.set(key, entry);
  }
  const customers = Array.from(byCustomer.values());
  for (const c of customers) c.orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
  customers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.email.localeCompare(b.email));
  return customers;
}

