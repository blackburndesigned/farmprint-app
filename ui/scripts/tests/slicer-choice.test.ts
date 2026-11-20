// Settings › Print library › Slicer: which slicer the saved settings pick.
import { chooseSlicerAppPatch, detectSlicer, pickSlicerPatch, savedSlicer } from "../../src/slicerChoice";
import { check, done } from "./check";

const s = (slicer_app_name = "", slicer_bundle_id = "", slicer_app_path = "") => ({ slicer_app_name, slicer_bundle_id, slicer_app_path });

check(savedSlicer(s()) === "bambu", "nothing saved: Bambu Studio");
check(savedSlicer(s("OrcaSlicer")) === "orca", "OrcaSlicer by name");
check(savedSlicer(s("", "com.prusa3d.slic3r")) === "prusa", "PrusaSlicer by bundle id");
check(savedSlicer(s("orca-slicer", "", "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe")) === "orca", "old Choose… value");
check(savedSlicer(s("", "", "/Applications/PrusaSlicer.app")) === "prusa", "PrusaSlicer by app file");
check(savedSlicer(s("MySlicer", "", "/opt/MySlicer")) === "other", "unknown app");
check(detectSlicer("BambuStudio") === "bambu" && detectSlicer("Cura") === null, "detect");

const toPrusa = pickSlicerPatch("prusa", s("OrcaSlicer", "", "/Applications/OrcaSlicer.app"));
check(toPrusa.slicer_app_name === "PrusaSlicer" && toPrusa.slicer_bundle_id === "com.prusa3d.slic3r", "picking saves name and bundle id");
check(toPrusa.slicer_app_path === "", "another slicer's app location is cleared");
check(pickSlicerPatch("orca", s("", "", "/opt/Orca.AppImage")).slicer_app_path === "/opt/Orca.AppImage", "the same slicer's app location is kept");

const chosen = chooseSlicerAppPatch("/Applications/OrcaSlicer.app");
check(chosen.slicer_app_name === "OrcaSlicer" && chosen.slicer_bundle_id === "com.orcaslicer.OrcaSlicer", "Choose… recognises a known slicer");
const other = chooseSlicerAppPatch("C:\\Apps\\MySlicer.exe");
check(other.slicer_app_name === "MySlicer" && other.slicer_bundle_id === "" && other.slicer_app_path === "C:\\Apps\\MySlicer.exe", "Choose… keeps an unknown app");

done();
