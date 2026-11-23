# Build plate view for Print!

Status: design draft, revision 2. This revision follows a recorded walkthrough of arranging and
orienting parts in a desktop slicer. No code yet. Mockups are in `build-plate-mockups/`.

## Goals

- Before a job goes to the slicer, show whether the picked parts fit on the chosen printer, and
  on how many plates.
- Make arranging feel as good as it does in a slicer: box select, Auto orient, an Arrange popover,
  Lay on face, drag on the bed, by-object clearance shapes with order numbers, several plates.
  Everything moves with short animations.
- Send exactly what the user sees. Positions and rotations go into the .3mf, so the slicer
  opens the plate as laid out.
- Stay out of the way. Print! still works in one click, and the full view is optional.

Out of scope: slicing and G-code preview (the slicer does that), supports, talking to printers,
any built-in printer model or brand. Splitting a part into separate objects is a later idea.

## UX flow

1. **Print! stays one click.** The user picks parts and presses Print!. FarmPrint arranges them
   automatically with the printer's remembered Arrange settings, and the printer picker opens as
   it does today.
2. **Fit summary in the picker** (mockup 1). Under the printer list: a small top-down plate
   thumbnail, one line such as "Fits on one plate · by layer · 5 mm spacing · 59% of the bed ·
   tallest part 99 of 256 mm", and an **Arrange plate…** link. Printer rows that would need more
   than one plate show a "Needs 2 plates" chip. Print! and Mark Printing work exactly as now.
3. **The full view opens only on request.** It opens from **Arrange plate…**. When something
   doesn't fit, the summary turns red and says what's wrong ("Needs 2 plates", "Tray is taller
   than this printer"). The user chooses whether to open the view or send anyway. It never opens
   by itself. *(Default pending Donnie.)*
4. **Plate view** (mockups 2–5):
   - **Header:** printer and its size, and **Print sequence: By layer / By object**.
   - **Left column:** one thumbnail per plate (number, part count, red badge when something is
     wrong) and **Add plate**. Clicking a thumbnail moves the camera to that plate.
   - **Toolbar:** Auto orient, Arrange (opens the popover), Lay on face, Move, Rotate,
     Add plate.
   - **Viewport:** the printer's plate to scale, parts in their filament colors with soft shadows,
     orbit / pan / zoom, fit-to-view and top-view buttons.
   - **Side list:** parts with color, size and plate. In By object it becomes the print order,
     and you drag rows to reorder them. *(Default pending Donnie.)*
   - **Status line, footer:** "Fits on one plate", or what's wrong. Cancel, then
     Send to slicer, or Send Plate 1 only / Send N plates to slicer.

### Interactions (from the walkthrough)

| Action | Behavior |
|---|---|
| Select | Click a part. Shift-click adds. **Drag on empty bed draws a marquee** (dashed outline, translucent fill), and parts inside are selected. Selected parts get a crisp white outline. |
| Delete | Removes the selected parts **from this job only**. They stay in Parts to Print. Undo brings them back. *(Default pending Donnie.)* |
| Move | Click-drag a part on the bed. A move gizmo, and arrow keys (1 mm, Shift 10 mm), are also available. Parts that collide or go off the plate turn red live while dragging. |
| Rotate | Rotate gizmo around Z. R rotates 90°. |
| Auto orient | Each selected part (or all) turns onto its best flat pose. The rotation is animated. |
| Arrange | Opens the popover: **Spacing (mm)**, **Auto-rotate for arrangement**, **Align to Y axis**, buttons **Arrange** and **Reset**. Settings are remembered per printer. Parts glide to their new spots. |
| Lay on face | Mode switch **Convex hull / Triangular face**. Candidate flat faces of the selected part are drawn as white planes. The face under the cursor turns blue, and clicking it snaps that face down (animated). Esc leaves the tool. |
| Print sequence | By layer packs tight. By object draws grey **clearance capsules** around each part and **large order numbers painted on the bed** inside each capsule. |
| Collision warning | When capsules overlap, they turn red and a **non-blocking toast** appears bottom right: "Inlay is too close to others. Collisions may occur when printing." with **Jump to (Inlay)**, which selects the part and frames it. Sending is still allowed. Arrange in By object spreads parts so capsules don't overlap, and the warning clears. |
| Plates | Add plate, then drag parts between plates (or onto a thumbnail). Overflow from Arrange goes onto new plates automatically. |
| Camera | View changes (top, fit, jump to a part or plate) interpolate over about 300 ms. They never jump cut. |
| Undo | Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z for every action above. |

**Animation:** arrange, orient, lay on face and camera moves tween over 250–400 ms with an
ease-out curve. The UI animates from the old transforms to the new ones returned by Rust.
Input stays live. A new action interrupts the running tween and starts from where the parts are.

### States

| State | Shown as |
|---|---|
| Fits | Green "Fits on one plate", bed use %, tallest part vs build height |
| Past the plate edge | Part turns red, plate outline red, thumbnail badge, "Off plate" chip |
| Collides with another part (by layer) | Both parts get a red outline. Live, and doesn't block sending. |
| Needs more plates | Extra parts on Plate 2+, thumbnails in the left column, "Needs 2 plates" |
| Taller than build height | Red, "Taller than this printer". Only when the printer has a build height set. |
| By object, capsules overlap | Red capsules, toast with Jump to, amber status. Doesn't block sending. |
| By object, taller than gantry clearance | Amber "Prints last". Two or more such parts is an error. |
| Not lying flat | Amber "Not flat" chip, with a hint to use Lay on face or Auto orient |

## Data and contract changes

Printer settings:

- `bed_x_mm`, `bed_y_mm` exist. `bed_z_mm` (build height, optional, blank by default) is being
  added on branch fix/no-hardcoded-printers. The plate view uses it for the height check only
  when it's set.
- New, optional, blank by default:
  - `object_clearance_radius_mm`: radius around the nozzle that must stay clear of finished
    parts in By object.
  - `object_clearance_height_mm`: nozzle tip to the lowest part of the gantry.
  When blank, By object uses Spacing alone and says the clearance isn't set, with a link to the
  printer's settings. No values are built in for any printer model.
- Arrange settings, remembered per printer (stored with the printer or in shop settings):
  `arrange_spacing_mm` (default 5), `arrange_auto_rotate` (default on), `arrange_align_y`
  (default off), `print_sequence` (default by layer). *(5 mm default pending Donnie.)*
- The new columns are added on open when missing, the same way as `bed_z_mm`. No schema version
  change, and `#[serde(default)]` on the model.

Print! request (src-tauri):

- New optional `layout` on the Print! command. Per unit: `{ plate, x_mm, y_mm, rot_z_deg,
  orientation: quaternion }`, plus `print_sequence` and the by-object order. When it's absent,
  Print! arranges automatically, so the one-click path and old callers keep working.
- Multiple plates: **one .3mf per plate**, sent together. *(Default pending Donnie.)* A single
  multi-plate file needs slicer-specific metadata, so it stays a later option.

fp-mesh:

- `PlateBed` gains `height_mm: Option<f32>`.
- New `PlacedItem { mesh_index, plate, transform: [f32; 12] }`. `write_3mf_plate_with` takes
  optional placements and writes each `<item transform="...">` with the full rotation and
  translation, instead of today's row layout. Mesh vertices stay unchanged, and the part is
  dropped to z = 0 after rotation. The row layout remains the fallback when no placements are
  given.

## Engine in fp-mesh (our own Rust)

Everything is written from scratch. Slicers are a reference for behavior only, and no code is
copied from AGPL projects. All functions are pure: they take meshes, transforms and settings and
return transforms. Tauri commands: `plate_arrange`, `plate_orient`, `plate_lay_on_face`,
`plate_check`.

### Outline

For each part (after its orientation), project vertices onto the bed and take the 2D convex
hull, simplified to about 0.5 mm. Cache it per mesh and orientation. A concave outline for
tighter packing is phase 4.

### Arrange

1. Sort by outline area, largest first (ties: taller first). Parts the user pinned by dragging
   stay where they are and act as obstacles. Shift+Arrange moves them too.
2. Rotations to try: 0° only when Auto-rotate is off. Otherwise 0/90° plus every 15°, skipping
   angles that are near duplicates for round outlines. Align to Y first rotates each part so its
   longest outline edge runs along Y, then allows only 0/180°.
3. Gap between outlines: Spacing in By layer. In By object, the larger of Spacing and the
   clearance radius, so capsules never overlap.
4. Candidate positions come from a coarse grid refined along touching edges. A no-fit-polygon
   search comes in phase 4. Keep only positions inside the bed and at least the gap from every
   placed outline.
5. Score: the bounding box of the pile on that plate (smaller and squarer is better), then
   distance to the start corner. Take the best.
6. If nothing fits, use the next plate, adding one if needed. A part bigger than the bed never
   moves to another plate. It stays red, and the status says why.
7. Center each plate's pile on the bed. Reset restores the default settings.
8. Target: under 100 ms for 30 parts and 300 ms for 50 in a release build. The first-pass JS
   mock already packs 15 parts in under a second with a plain grid.

### By object

- Clearance capsule = outline offset by half the clearance radius with round joins, drawn as
  translucent grey. Two capsules touching means the parts are exactly the clearance apart, so
  overlap means too close.
- The order number is painted on the bed inside each capsule, in the free band in front of the
  part (or beside it when that falls off the bed).
- Default order: back to front, then left to right, so the gantry moves away from finished parts.
  Drag rows in the side list to reorder.
- A part taller than the clearance height must print last. One is allowed. Two or more is an
  error that suggests By layer or splitting the job.
- The order is written as the build item order in the .3mf. The slicer's own print-sequence
  setting must be By object too, and FarmPrint shows a reminder.

### Auto orient and Lay on face

- **Convex hull mode:** build the part's 3D convex hull (quickhull) and group hull faces by
  normal. Each group is a candidate face with an area, a stability flag (the center of mass
  projects inside it) and its outline polygon. These are the white planes shown on hover.
- **Triangular face mode:** candidates are coplanar groups of the mesh's own triangles. This
  picks faces inside pockets that the hull doesn't have.
- **Auto orient:** score stable candidates by face area, then lower height, then a smaller
  overhang area (triangles facing down past 45°). Pick the best and rotate it down.
- **Click a face:** rotate the chosen face down, drop to z = 0, keep the part's XY center, and
  mark it as moved for Arrange. Unstable faces are allowed, with a warning.

### Live checks (`plate_check`, mirrored in TypeScript while dragging)

- Inside the bed: outline vs the bed polygon (a rectangle today, so round beds are possible
  later).
- Height vs `bed_z_mm` when set.
- Collisions: outline vs outline with the current gap. Capsule overlap in By object.
- Runs on every drag frame in the UI for instant feedback, and is confirmed in Rust on drop.

### Third-party crates (optional, all GPL-3.0 compatible)

Checked on crates.io. None is required for phase 1.

| Crate | License | Use |
|---|---|---|
| `geo` 0.33 | MIT or Apache-2.0 | polygon offset, contains, distance |
| `i_overlay` 9.2 | MIT or Apache-2.0 | robust offset and union for capsules and concave outlines |
| `parry3d` 0.31 | Apache-2.0 | 3D convex hull and ray picking (or our own quickhull) |
| `jagua-rs` 2.0 | MPL-2.0 | collision engine for phase 4 nesting, if our own packer isn't tight enough |

Not used: anything from slicer source trees (AGPL-3.0), or `libnest2d` (LGPL-3.0, C++).

## UI (ui/)

- `PlateView3D.tsx` uses the existing WebGL renderer (`meshRendererGL.ts`, `viewportCamera.ts`)
  and the order model cache, so meshes load once. It adds instancing for repeated parts, shadows,
  a selection outline pass (back-face shell plus edges), translucent capsule and painted-number
  layers, marquee and gizmos, and a tween helper for parts and camera.
- `PlateThumbs.tsx`: the plate column (top-down renders shared with the picker summary).
- `ArrangePopover.tsx`, `LayOnFaceBar.tsx`, `PlateToast.tsx`.
- `PlateFitSummary.tsx`: the summary in the printer picker.

## Phases

1. **Fit and send:** outline, checks and arrange in fp-mesh. Transforms in the .3mf, one file
   per plate. Fit summary and "Needs 2 plates" chips in the picker. No full view yet.
2. **Plate view:** viewport, plate column and Add plate, marquee select, white outline, Delete,
   drag, gizmos, undo, Arrange popover with remembered settings, animated tweens, live red
   states.
3. **Orient:** Auto orient and Lay on face (both modes), with hover planes.
4. **By object:** clearance settings fields, capsules, painted numbers, toast with Jump to,
   drag-to-reorder, too-tall-last rule, Arrange spreading by clearance.
5. **Polish:** concave outlines and no-fit-polygon packing, performance pass for 50+ parts,
   compare side by side with the slicer recording. Later idea: split a part into objects.

## Test plan

- fp-mesh unit tests:
  - convex hull of known shapes
  - Auto orient on a cube, a tilted wedge, a cylinder and a part whose largest face is unstable
  - Lay on face picks the clicked face in both modes
  - arrange of N identical squares within 5% of the known best
  - no two outlines closer than the gap, and every part inside the bed
  - overflow onto Plate 2 at the exact count
  - By object capsules never overlap after Arrange
  - too-tall-last rule
  - Align to Y gives axis-aligned parts
- .3mf round trip: write with rotations, re-read with `parse_3mf_parts`, and compare world-space
  bounding boxes with the layout. Open the files in two slicers by hand before release.
- Sample shop: arrange every sample product on 180, 256 and 350 mm beds, and save screenshots.
- UI (Playwright): screenshots of all states above. Interaction tests for marquee, Delete and
  undo, drag turning red, the toast's Jump to, and settings remembered after reopening.
- Performance: arrange of 50 parts under 300 ms; drag frame checks under 4 ms.

## Defaults pending Donnie

These are the defaults proposed by the team. Change any of them before phase 1.

1. Multiple plates: one .3mf per plate.
2. When parts don't fit: a red summary, and the user chooses. The view never opens by itself.
3. By-object order: drag rows in the side list.
4. Delete in the plate view: removes the part from this job only.
5. Spacing: 5 mm, remembered per printer.

## Mockups (`build-plate-mockups/`)

1. `1-picker-fit-summary.png`: printer picker with the fit summary, Arrange plate…, and a
   "Needs 2 plates" chip.
2. `2-by-layer-arrange-popover.png`: by layer, arranged, Arrange popover open, two parts
   selected with white outlines.
3. `3-by-object-clearance.png`: grey clearance capsules, bed-painted order numbers, two
   overlapping capsules in red, the toast with Jump to, and the tall part printing last.
4. `4-lay-on-face.png`: Lay on face (Convex hull mode), white candidate faces, the hovered face
   in blue.
5. `5-overflow-plates.png`: plate column with Plate 1 (error badge) and Plate 2, a part past
   the edge, and a marquee selection on Plate 2.

Rendered from the real sample-shop models with the app's own styles. Printer names and sizes
are made up.
