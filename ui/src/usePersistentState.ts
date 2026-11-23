// Remembers a view/sort/group/filter choice in localStorage so it survives a tab
// remount. Keys are stored under `farmprint.view.`. A stored value is used only
// when it is in `allowed`; otherwise (missing, invalid, or storage throws) the
// default is used.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export const VIEW_STATE_PREFIX = "farmprint.view.";

/** localStorage key for a view-choice id such as `partsToPrint.sortMode`. */
export function viewStateKey(key: string): string {
  return `${VIEW_STATE_PREFIX}${key}`;
}

function storage(): Storage | null {
  try {
    const ls = globalThis.localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/**
 * The stored value for `key` when it is one of `allowed`, otherwise `defaultValue`.
 * Storage errors, missing keys, and unreadable values all fall back to the default.
 */
export function readPersistentState<T extends string | boolean>(
  key: string,
  defaultValue: T,
  allowed: readonly T[],
): T {
  try {
    const raw = storage()?.getItem(viewStateKey(key));
    if (raw == null) return defaultValue;
    const parsed: unknown = JSON.parse(raw);
    if ((allowed as readonly unknown[]).includes(parsed)) return parsed as T;
  } catch {
    // private mode, quota, invalid JSON, or missing storage
  }
  return defaultValue;
}

/** Best-effort write. Failures (private mode, quota) are ignored. */
export function writePersistentState(key: string, value: string | boolean): void {
  try {
    storage()?.setItem(viewStateKey(key), JSON.stringify(value));
  } catch {
    // ignore
  }
}

/**
 * Like useState, but the value is read from and written to localStorage under
 * a namespaced key, and rejected when it is not in `allowed`.
 */
export function usePersistentState<T extends string | boolean>(
  key: string,
  defaultValue: T,
  allowed: readonly T[],
): [T, Dispatch<SetStateAction<T>>] {
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const defaultRef = useRef(defaultValue);
  defaultRef.current = defaultValue;

  const [value, setValue] = useState<T>(() => readPersistentState(key, defaultValue, allowed));

  // Re-check when the allowed set changes (e.g. a product or process step was removed).
  const allowedSig = allowed.map(String).join("\0");
  useEffect(() => {
    const next = readPersistentState(key, defaultRef.current, allowedRef.current);
    setValue((prev) => (Object.is(prev, next) ? prev : next));
  }, [key, allowedSig]);

  const setPersistent = useCallback(
    (update: SetStateAction<T>) => {
      setValue((prev) => {
        const next = typeof update === "function" ? (update as (prev: T) => T)(prev) : update;
        if (!(allowedRef.current as readonly unknown[]).includes(next)) return prev;
        writePersistentState(key, next);
        return next;
      });
    },
    [key],
  );

  return [value, setPersistent];
}
