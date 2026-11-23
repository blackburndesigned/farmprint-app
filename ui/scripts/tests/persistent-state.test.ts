// View choices stored in localStorage: only an allowed value is kept; anything
// else (missing, invalid, unreadable, or storage throwing) falls back to the default.
import {
  readPersistentState,
  viewStateKey,
  writePersistentState,
  VIEW_STATE_PREFIX,
} from "../../src/usePersistentState";
import { check, done } from "./check";

const allowedSort = ["order", "color"] as const;
const memory = new Map<string, string>();

function installMemoryStorage() {
  memory.clear();
  const store: Storage = {
    get length() {
      return memory.size;
    },
    clear() {
      memory.clear();
    },
    getItem(key) {
      return memory.has(key) ? memory.get(key)! : null;
    },
    key() {
      return null;
    },
    removeItem(key) {
      memory.delete(key);
    },
    setItem(key, value) {
      memory.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
}

installMemoryStorage();

check(viewStateKey("partsToPrint.sortMode") === `${VIEW_STATE_PREFIX}partsToPrint.sortMode`, "keys are namespaced");

check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "order", "missing key: default");

writePersistentState("partsToPrint.sortMode", "color");
check(memory.get(viewStateKey("partsToPrint.sortMode")) === JSON.stringify("color"), "values are stored as JSON under the namespaced key");
check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "color", "valid stored value is kept");

writePersistentState("partsToPrint.sortMode", "newest");
check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "order", "stored value not in allowed: default");

memory.set(viewStateKey("partsToPrint.sortMode"), "not-json");
check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "order", "invalid JSON: default");

memory.set(viewStateKey("partsToPrint.sortMode"), JSON.stringify(12));
check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "order", "wrong type: default");

writePersistentState("flow.onlyFailed", true);
check(readPersistentState("flow.onlyFailed", false, [true, false]) === true, "boolean true is kept");
writePersistentState("flow.onlyFailed", false);
check(readPersistentState("flow.onlyFailed", true, [true, false]) === false, "boolean false is kept");

const throwing: Storage = {
  get length() {
    return 0;
  },
  clear() {
    throw new Error("denied");
  },
  getItem() {
    throw new Error("denied");
  },
  key() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
};
Object.defineProperty(globalThis, "localStorage", { value: throwing, configurable: true, writable: true });
check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "order", "storage get throws: default");
writePersistentState("partsToPrint.sortMode", "color");
check(true, "storage set throws: write does not throw");

Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
check(readPersistentState("partsToPrint.sortMode", "order", allowedSort) === "order", "no storage: default");
writePersistentState("partsToPrint.sortMode", "color");
check(true, "no storage: write does not throw");

done();
