// Light / Dark: stored appearance_mode values map onto the two modes; no choice follows the computer.
import { resolveTheme, savedThemeChoice } from "../../src/theme";
import { check, done } from "./check";

check(savedThemeChoice("light") === "light" && savedThemeChoice("Dark") === "dark", "light/dark kept, any case");
check(savedThemeChoice("") === null && savedThemeChoice(undefined) === null, "nothing saved: no choice");
check(savedThemeChoice("system") === null && savedThemeChoice("auto") === null, "old system/auto values: no choice");
check(savedThemeChoice("purple") === null, "unknown values: no choice");
check(resolveTheme("", true) === "dark" && resolveTheme("", false) === "light", "no choice follows the computer");
check(resolveTheme("system", false) === "light", "old 'system' follows the computer");
check(resolveTheme("dark", false) === "dark" && resolveTheme("light", true) === "light", "a saved choice beats the computer");

done();
