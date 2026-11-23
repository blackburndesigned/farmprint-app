/** Name saved when the user leaves the printer name blank. */
export function fallbackPrinterName(existingCount: number): string {
  return `Printer ${existingCount + 1}`;
}

/** Name sent to add_printer: the typed name, or a numbered fallback. */
export function printerNameToSave(name: string | null | undefined, existingCount: number): string {
  const t = (name || "").trim();
  return t ? t : fallbackPrinterName(existingCount);
}

/** Model stored for a new printer: trimmed, or blank when nothing was typed. */
export function printerModelToSave(model?: string | null): string {
  return (model || "").trim();
}

/** "Name (model)" when the printer has a model, otherwise just the name. */
export function printerOptionLabel(name: string, model?: string | null): string {
  const m = (model || "").trim();
  return m ? `${name} (${m})` : name;
}
