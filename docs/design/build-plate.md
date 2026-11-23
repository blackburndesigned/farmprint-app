# Build plate view for Print!

Status: design draft for review. No code yet. Mockups are a first pass and will be revised
after reviewing a screen recording of arranging and orienting parts in a slicer.

## Goals

- Before a job goes to the slicer, show whether the picked parts fit on the chosen printer, and
  on how many plates.
- Arrange parts at least as well as a slicer does: auto arrange by real outline, auto lay flat,
  pick a face to put down, and by-object spacing with the toolhead clearance.
- Send exactly what the user sees. Positions and rotations go into the .3mf, so the slicer
  opens the plate as laid out.
- Stay out of the way. Print! still works in one click, and the full view is optional.

Non-goals: slicing, supports, previews of toolpaths, talking to printers, any built-in printer
model or brand.

## UX flow

1. **Print! stays one click.** The user picks parts and presses Print!. FarmPrint arranges them
   automatically (by layer, using the last spacing used), and the printer picker opens as it
   does today.
2. **At-a-glance fit summary in the picker** (mockup `pick.png`). Under the printer list:
   a small top-down plate thumbnail, one line such as "Fits on one plate · 59% of the bed ·
   tallest part 99 of 256 mm", and an **Arrange plate…** link. Each printer row shows a chip
   when the job would not fit on one of its plates ("2 plates"), so the user can pick a bigger
   printer without opening anything. Print! and Mark Printing work exactly as now.
3. **The full plate view opens only when asked for, or when something doesn't fit.** It opens
   from Arrange plate…, or automatically when Print! would need more than one plate, a part is
   taller than the build height, or a part is bigger than the bed.
4. **Plate view** (mockups `fits.png`, `overflow.png`, `object.png`, `layflat.png`):
   - Header: printer (with its size), **By layer / By object** toggle.
   - Toolbar: Arrange, Lay flat, Face down, Rotate, Spacing (or Clearance in by-object mode),
     Rotate to fit, plate tabs (Plate 1, Plate 2, +).
   - Viewport: the printer's plate drawn to scale, parts in their filament colors with shadows,
     orbit / pan / zoom, fit-to-view and top-view buttons.
   - Side list: every part with its color, order and size, and which plate it is on.
   - Status line: "Fits on one plate", or what is wrong and how to fix it.
   - Footer: Cancel, Send to slicer (or "Send Plate 1 only" / "Send 2 plates to slicer").
5. **Direct manipulation:** click to select (shift for many), drag on the plate, R rotates 90°,
   arrow keys nudge 1 mm (shift 10 mm), F enters face pick, Delete leaves a part out of this
   job (it stays in Parts to Print), Cmd/Ctrl+Z undo.
6. The view remembers per printer: mode, spacing, rotate to fit, camera.

States the view must show:

| State | Shown as |
|---|---|
| Fits | Green "Fits on one plate", bed use %, tallest part vs build height |
| Part past the plate edge | Part turns red, red plate outline, tip "past the plate edge", list chip "Off plate" |
| Too many parts | Extra parts go to Plate 2+, each plate drawn side by side, list chips "Plate 2" |
| Taller than build height | Red, "Taller than this printer" (only when build height is set) |
| By object, taller than gantry clearance | Amber, "prints last"; two or more such parts is an error |
| Not lying flat | Amber "Not flat" chip, suggestion to use Lay flat |

## Data and contract changes

Printer settings:

- `bed_x_mm`, `bed_y_mm` exist. `bed_z_mm` (build height) is being added as optional, blank by
  default (branch fix/no-hardcoded-printers). The plate view uses it for the "taller than
  this printer" check only when set; blank means no height check.
- New, optional, blank by default:
  - `object_clearance_radius_mm`: radius around the nozzle that must stay clear of finished
    parts when printing by object.
  - `object_clearance_height_mm`: height from the nozzle tip to the lowest part of the gantry.
  When blank, the By object toggle still works with spacing only and says the clearance isn't
  set, with a link to the printer's settings. No values are built in for any printer model.
- Added the same way as `bed_z_mm`: nullable columns added on open if missing, no schema
  version change, `#[serde(default)]` on the model.

Print! request (src-tauri):

- New optional `layout` on the Print! command: per unit `{ plate, x_mm, y_mm, rot_z_deg,
  orientation: [quaternion] }`, plus `mode: "layer" | "object"` and print order. When absent,
  Print! arranges automatically, so the one-click path and old callers keep working.
- Multiple plates: one .3mf per plate (simplest, works in every slicer). A single multi-plate
  .3mf is an open question because plate metadata is slicer-specific.

fp-mesh:

- `PlateBed` gains `height_mm: Option<f32>`.
- New `PlacedItem { mesh_index, plate, transform: [f32; 12] }`. `write_3mf_plate_with` takes an
  optional list of placements. When given, it writes each `<item transform="...">` with the
  full rotation matrix and translation instead of today's row layout. The mesh vertices stay
  as they are (a slicer reads the transform), and the part is dropped to z = 0 after rotation.
- The current row layout becomes the fallback only when no placements are passed.

## Engine in fp-mesh (our own Rust)

Everything below is written from scratch. Slicers are used only as a reference for behavior.
No code is copied from AGPL projects.

### Outline

For each part (after its orientation), project vertices onto the plate and take the 2D convex
hull (monotone chain). The convex hull is what slicers use for by-object clearance, and it is
right for most parts. Phase 3 adds a concave outline for packing L-shaped or ring-shaped parts
tighter. Packing runs on outlines simplified to about 0.5 mm, so it stays fast.

### Auto arrange (by layer)

1. Sort parts by outline area, largest first (ties: taller first).
2. For each part, try rotations (0° and 90° by default; every 15° or 45° when Rotate to fit is
   on and the part isn't round). For each rotation, find positions where the outline is inside
   the bed and at least `spacing` from every placed outline. Candidates come from a coarse grid
   refined near touching edges (a no-fit-polygon approach in phase 3).
3. Score each candidate by the bounding box of the whole pile (smaller is better, square
   preferred), then distance to the start corner. Keep the best.
4. If nothing fits, start Plate 2 and continue. A single part larger than the bed is never
   moved to another plate. It stays red and the status explains why.
5. Center each plate's pile on the bed.
6. Parts the user pinned (dragged by hand) are treated as fixed obstacles. Arrange moves only the
   parts that aren't pinned, unless Shift+Arrange.

Target: under 100 ms for 30 parts on the UI thread budget (runs in Rust via a Tauri command;
the mock in JavaScript already does 15 parts in well under a second with a plain grid).

### By object

- Each outline is offset by half the clearance radius. Offset outlines may touch but not
  overlap (the dashed areas in `object.png`). If the radius is blank, spacing is used.
- Print order: back to front, left to right by default, so the gantry moves away from finished
  parts. The user can drag to reorder in the side list. Order numbers show on each part.
- A part taller than the clearance height must print last. One such part is allowed. Two or
  more is an error with a clear message: switch to By layer or split the job.
- The order is written into the .3mf in the build item order. The slicer must also be set to
  print by object. FarmPrint shows a reminder because the setting lives in the slicer profile.

### Lay flat

- **Auto (largest stable face):** build the 3D convex hull of the mesh (quickhull), group hull
  faces by normal, and for each group compute its area and whether the center of mass projects
  inside it (stable). Pick the largest stable face, rotate it to face down, and drop to z = 0.
  Tie-break: lower part height.
- **Face down (click a face):** ray-pick the triangle under the cursor, grow it to the coplanar
  hull face it belongs to, highlight it, and on click rotate that face down. Faces that wouldn't
  be stable are still allowed, with a warning.
- Lay flat runs per selected part, or for all parts when nothing is selected, then re-arranges.

### Checks

- Inside the bed: outline vs bed rectangle (keep the rectangle as a polygon so round or custom
  beds are possible later).
- Height: part height after orientation vs `bed_z_mm` when set.
- Overlap between parts: outline vs outline with the current spacing; overlapping parts get an
  amber outline but aren't blocked (the user may intend it).

### Third-party crates (optional, all GPL-3.0 compatible)

Checked on crates.io today. None is required for phase 1.

| Crate | License | Use |
|---|---|---|
| `geo` 0.33 | MIT or Apache-2.0 | polygon offset, contains, distance |
| `i_overlay` 9.2 | MIT or Apache-2.0 | robust polygon offset and union for concave outlines |
| `parry3d` 0.31 | Apache-2.0 | 3D convex hull and ray picking (or write our own quickhull) |
| `jagua-rs` 2.0 | MPL-2.0 | collision engine for phase 3 nesting, if our own packer isn't tight enough |

Not used: anything from slicer source trees (AGPL-3.0), or `libnest2d` (LGPL-3.0, C++).

## UI (ui/)

- `PlateView3D.tsx`: built on the existing WebGL renderer (`meshRendererGL.ts`,
  `viewportCamera.ts`) and the order model cache, so meshes load once. Includes instancing for
  repeated parts, shadows, and an orthographic top view toggle.
- `PlateFitSummary.tsx`: the small summary in the printer picker.
- Arrange and lay flat run in Rust via new Tauri commands (`plate_arrange`, `plate_lay_flat`,
  `plate_check`). Dragging and nudging run in the UI with the same checks done in TypeScript
  for instant feedback, then confirmed by `plate_check`.

## Phases

1. **Fit and send (smallest useful step):** fp-mesh outline, checks, and arrange (grid search,
   0°/90°), multi-plate overflow, transforms in the .3mf. Fit summary in the printer picker and
   "2 plates" chips. Print! uses the auto layout. No full view yet.
2. **Plate view:** full view with drag, rotate, nudge, undo, plate tabs, side list, status line;
   auto lay flat and Face down; height check against `bed_z_mm`.
3. **By object:** clearance fields in printer settings, offset outlines, order
   numbers, drag-to-reorder, too-tall-last rule.
4. **Polish:** concave outlines and tighter packing (no-fit polygons), free-angle rotation,
   remembered camera, performance pass for 50+ parts. Revisit the mockups against the slicer
   recording.

## Test plan

- fp-mesh unit tests: convex hull of known shapes; lay flat on a cube, a tilted wedge, a cylinder
  and a part whose largest face is unstable; arrange of N identical squares packs to the known
  optimum within 5%; no two outlines closer than spacing; every part inside the bed; overflow
  onto Plate 2 at the exact count; by-object offsets never overlap; too-tall rule.
- .3mf round trip: write with rotations, re-read with `parse_3mf_parts`, and compare world-space
  bounding boxes to the arrangement. Open the files in two slicers by hand before release.
- Sample shop: arrange every sample product on 180, 256 and 350 mm beds and save screenshots
  for review.
- UI: Playwright screenshots of fits, overflow, by object and lay flat states; interaction test
  for drag, nudge and undo.
- Performance: arrange 50 parts in under 300 ms in a release build.

## Open questions for Donnie

1. Multi-plate jobs: one .3mf per plate (works everywhere), or one file with several plates
   for slicers that support it?
2. Should Print! open the full plate view automatically when parts don't fit, or just show the
   red summary and let you choose?
3. By object: is drag-to-reorder in the list enough, or do you want to click parts in order on
   the plate?
4. Should Delete in the plate view leave a part out of this job, or should the job always
   include every picked part?
5. Default spacing for by-layer arrange: 5 mm OK?
6. Anything from your slicer recording that should change the toolbar or shortcuts.

## Mockups (first pass, in build-plate-mockups/)

- `pick.png`: printer picker with the fit summary and Arrange plate… link.
- `fits.png`: plate view, 11 parts arranged by layer, fits on one plate.
- `overflow.png`: too many parts, extra parts on Plate 2, one part dragged past the edge in red.
- `object.png`: by-object mode with clearance areas, print order numbers, and a part taller
  than the gantry clearance printing last.
- `layflat.png`: Face down mode with the face under the cursor highlighted and a part flagged
  as not lying flat.

Sample shop models only. Printer names and sizes are made up for the mockups.
