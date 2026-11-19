// Which computer did something, for the activity log (`actor_device`). One shared helper so no
// screen hard-codes a device name. The label comes from the backend (`get_device_label`, the
// OS computer name plus "(FarmPrint)") and is fetched once on first use; until it arrives,
// and in a plain browser preview, it reads "FarmPrint".
import { invoke } from "./tauriInvoke";

const FALLBACK = "FarmPrint";
let label = FALLBACK;
let requested = false;

function load() {
  if (requested) return;
  requested = true;
  invoke<{ label?: string }>("get_device_label")
    .then((r) => {
      const l = (r?.label || "").trim();
      if (l) label = l;
    })
    .catch(() => {
      /* keep the fallback */
    });
}

/** This computer's name for `actor_device` / `actorDevice`. */
export function actorDevice(): string {
  load();
  return label;
}

// Start the lookup at startup so the first logged action already has the real name.
load();
