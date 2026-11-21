/**
 * App-wide stacking order for things that must sit above every sheet and modal.
 *
 * Sheets and modals pick their own z-index (60–2000), and some are portaled straight
 * into <body> (outside the app shell's stacking context), so a confirmation drawn inside
 * the shell can end up behind the sheet that asked for it. The shared confirmation is
 * therefore portaled into <body> too, at a z-index above every other layer (including
 * the setup wizard, the update toast and the lock screen).
 */
export const CONFIRM_Z_INDEX = 10000;
