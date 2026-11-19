/** Text for a caught error: its `message` when it has one, else the value itself (as before:
 *  `String(e?.message || e)`), else `fallback` when both are empty. */
export function errorText(e: unknown, fallback?: string): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return String(message || e || fallback || e);
}
