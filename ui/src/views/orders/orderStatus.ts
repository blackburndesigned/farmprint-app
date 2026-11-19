import { BUILTIN_PROCESS_STEPS, getProcessSteps, isStepHidden } from "../../settingsStore";

/** Built-in steps (Settings › Process falls back to these). Use getProcessSteps() for live steps. */
export const PROCESS_STEPS = BUILTIN_PROCESS_STEPS;

export function isCompletedUnitState(state: string): boolean {
  const norm = (state || "").trim();
  return (
    norm === "Printed" ||
    norm === "PostProcess" ||
    norm === "Post-Process" ||
    norm === "Post-Processing" ||
    norm === "PostProcessing" ||
    norm === "PostProcessed" ||
    norm === "Assembled" ||
    norm === "Processed" ||
    norm === "Ready" ||
    norm === "Ready to Ship" ||
    norm === "Packed" ||
    norm === "Closed" ||
    norm === "Shipped"
  );
}

export function unitMatchesStep(unitState: string, stepId: string): boolean {
  const norm = (unitState || "").trim();
  if (stepId === "Queued") return norm === "Queued" || norm === "Waiting" || (norm === "Staged" && isStepHidden("Staged"));
  if (stepId === "Staged") return norm === "Staged";
  if (stepId === "Printing") return norm === "Printing";
  if (stepId === "Printed") return norm === "Printed";
  if (stepId === "Post-Processing") {
    return (
      norm === "Post-Processing" ||
      norm === "Post-Process" ||
      norm === "PostProcess" ||
      norm === "PostProcessing"
    );
  }
  if (stepId === "Ready") {
    return (
      norm === "Ready" ||
      norm === "Ready to Ship" ||
      norm === "Processed" ||
      norm === "Assembled" ||
      norm === "Packed" ||
      norm === "Closed" ||
      norm === "Shipped"
    );
  }
  return norm === stepId;
}

export function statusStepFor(state: string) {
  const hit = getProcessSteps().find((s) => s.id === state || unitMatchesStep(state, s.id));
  if (hit) return hit;
  return getProcessSteps()[0];
}

export function progressColorHex(pct: number): string {
  if (pct >= 99.5) return "#16a34a";
  if (pct >= 65) return "#0d9488";
  if (pct >= 30) return "#2563eb";
  if (pct > 0) return "#d97706";
  return "#64748b";
}
