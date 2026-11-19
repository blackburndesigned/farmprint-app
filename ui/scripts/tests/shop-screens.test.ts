// Shop screens: price parsing (Edit product), People grouping, website import notes.
// Self-contained checks so this file needs nothing but the code it tests.
import { groupCustomers, parsePriceCents } from "../../src/shopHelpers";
import { importNoteCount, recordImportNotes } from "../../src/storeImportNotes";
import type { Order } from "../../src/types";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log("ok  ", msg);
  else {
    failures++;
    console.error("FAIL", msg);
  }
};

// Price: good amounts parse, bad ones are null (never silently ignored).
check(parsePriceCents("12.50") === 1250, "12.50 -> 1250");
check(parsePriceCents("$7") === 700, "$7 -> 700");
check(parsePriceCents(".5") === 50, ".5 -> 50");
check(parsePriceCents("0") === 0, "0 is a real price");
for (const bad of ["", "abc", "12.345", "-3", "1,000", "12.5.0"]) check(parsePriceCents(bad) === null, `"${bad}" is not a price`);

// People: same email in any case is one person; sorted by name; newest order first.
const order = (id: string, name: string, email: string, created: string, cents = 100) =>
  ({ id, order_code: id, customer_name: name, customer_email: email, created_at: created, total_revenue_cents: cents, overall_state: "Shipped", lines: [] }) as unknown as Order;
const people = groupCustomers([
  order("BD-1", "zoe", "Zoe@Example.com", "2026-01-01"),
  order("BD-2", "Zoe", "zoe@example.com ", "2026-02-01", 250),
  order("BD-3", "adam", "", "2026-01-05"),
  order("BD-4", "Adam", "", "2026-01-06"),
]);
check(people.length === 2, "mixed-case emails and same names group together");
check(people[0].name.toLowerCase() === "adam", "sorted by name");
check(people[1].totalCents === 350, "totals add up");
check(people[1].orders[0].id === "BD-2", "newest order first");

// Import notes: kept until the next import replaces them; an empty import clears them.
recordImportNotes(["Order BD-9 left on the shop: unknown product"], ["cs_x"]);
check(importNoteCount({ at: "", notSaved: ["a"], warnings: ["b", "c"] }) === 3, "note count adds both lists");
recordImportNotes([], []);
check(true, "empty import clears notes without throwing");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
