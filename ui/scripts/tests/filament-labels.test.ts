import {
  displayBrand,
  displayVendor,
  suggestionValues,
  NO_BRAND_LABEL,
  UNSPECIFIED_VENDOR_LABEL,
} from "../../src/filamentLabels";
import { check, done } from "./check";

check(displayBrand("") === NO_BRAND_LABEL && displayBrand("   ") === NO_BRAND_LABEL, "blank brand shows as No brand");
check(displayBrand(null) === NO_BRAND_LABEL && displayBrand(undefined) === NO_BRAND_LABEL, "missing brand shows as No brand");
check(displayBrand("Polymaker") === "Polymaker" && displayBrand("  eSun ") === "eSun", "named brand is trimmed and kept");

check(displayVendor("") === UNSPECIFIED_VENDOR_LABEL && displayVendor(null) === UNSPECIFIED_VENDOR_LABEL, "blank vendor shows as Unspecified");
check(displayVendor("Amazon") === "Amazon" && displayVendor("  Direct ") === "Direct", "named vendor is trimmed and kept");

check(
  JSON.stringify(suggestionValues(["Polymaker", "  Polymaker ", "", null, "eSun", "Polymaker"])) ===
    JSON.stringify(["Polymaker", "eSun"]),
  "suggestions are unique, trimmed, first-seen, and skip blanks"
);
check(JSON.stringify(suggestionValues([null, "  ", undefined])) === "[]", "all-blank suggestions are empty");

done();
