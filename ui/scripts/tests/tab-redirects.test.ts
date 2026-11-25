// Removed tabs land on their replacement; current tabs pass through.
import { normalizeTab, TAB_REDIRECTS } from "../../src/components/tabRedirects";
import { check, done } from "./check";

check(normalizeTab("value") === "insights", "Production Value goes to Insights");
check(normalizeTab("insights") === "insights" && normalizeTab("orders") === "orders", "current tabs unchanged");
check(Object.keys(TAB_REDIRECTS).length === 1, "only the removed tab is redirected");
done();
