import {
  displayBrand,
  displayVendor,
  suggestionValues,
  shortTypeLabel,
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

check(shortTypeLabel("") === "" && shortTypeLabel("   ") === "" && shortTypeLabel(null) === "", "blank type has no label");
check(shortTypeLabel("PLA") === "PLA" && shortTypeLabel(" PETG ") === "PETG", "short types are trimmed and kept");
check(shortTypeLabel("Polycarbonate") === "Polyc…", "long types truncate to 6 with an ellipsis");
check(shortTypeLabel("PETG-CF", 8) === "PETG-CF" && shortTypeLabel("Polycarbonate", 8) === "Polycar…", "max length is honored");

done();
