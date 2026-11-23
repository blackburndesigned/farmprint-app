import { suggestionValues } from "../../src/filamentLabels";
import { fallbackPrinterName, printerModelToSave, printerNameToSave, printerOptionLabel } from "../../src/printerLabels";
import { check, done } from "./check";

check(fallbackPrinterName(0) === "Printer 1" && fallbackPrinterName(4) === "Printer 5", "blank-name fallback is Printer N");
check(printerNameToSave("  Shop 1  ", 2) === "Shop 1", "typed name is trimmed and kept");
check(printerNameToSave("", 2) === "Printer 3" && printerNameToSave("   ", 0) === "Printer 1", "blank name uses the fallback");
check(printerNameToSave(null, 1) === "Printer 2" && printerNameToSave(undefined, 1) === "Printer 2", "missing name uses the fallback");

check(printerModelToSave("") === "" && printerModelToSave("   ") === "", "blank model stays blank");
check(printerModelToSave(null) === "" && printerModelToSave(undefined) === "", "missing model stays blank");
check(printerModelToSave("  Custom  ") === "Custom", "typed model is trimmed and kept");

check(
  JSON.stringify(suggestionValues(["Printer 1", "  Printer 1 ", "", null, "Printer 2", "Printer 1"])) ===
    JSON.stringify(["Printer 1", "Printer 2"]),
  "name and model suggestions are unique, trimmed, first-seen, and skip blanks"
);
check(JSON.stringify(suggestionValues(["  Generic FDM 256 ", "", "Generic FDM 256"])) === JSON.stringify(["Generic FDM 256"]), "model suggestions skip blanks");

check(printerOptionLabel("Printer 1", "Custom") === "Printer 1 (Custom)", "option label includes a model when one is set");
check(printerOptionLabel("Printer 1", "") === "Printer 1" && printerOptionLabel("Printer 1", "  ") === "Printer 1", "option label drops a blank model");

done();

