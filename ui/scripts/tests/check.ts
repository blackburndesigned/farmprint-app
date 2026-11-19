let failures = 0;
let quietPasses = 0;
/** Records a check; `quiet` passes are only counted (for loops). */
export function check(cond: boolean, msg: string, quiet = false) {
  if (!cond) { failures++; console.error("FAIL", msg); }
  else if (quiet) quietPasses++;
  else console.log("ok  ", msg);
}
export function done() {
  if (quietPasses) console.log(`ok   (+${quietPasses} more)`);
  if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
}
