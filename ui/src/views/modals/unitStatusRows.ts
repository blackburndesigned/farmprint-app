/** One row in the part status popover. */
export type UnitStatusRow = {
  id: string;
  name: string;
  /** The part is already in this state: shown as a disabled marker, not a move button. */
  current: boolean;
  label: string;
};

/**
 * Rows for the part status popover: the part's own state is a non-clickable
 * "<State> (current)" row, every other step is a "Move to <State>" button. When the
 * current state isn't one of the process steps it is listed first, so the popover
 * always says where the part is.
 */
export function unitStatusRows(
  steps: Array<{ id: string; name: string }>,
  currentState: string,
  currentName: string = currentState
): UnitStatusRow[] {
  const rows = steps.map(({ id, name }) => {
    const current = id === currentState;
    return { id, name, current, label: current ? `${name} (current)` : `Move to ${name}` };
  });
  if (!rows.some((r) => r.current)) {
    rows.unshift({ id: currentState, name: currentName, current: true, label: `${currentName} (current)` });
  }
  return rows;
}
