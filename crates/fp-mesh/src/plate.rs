//! Build plate layout for Print!: part outlines seen from above, auto arrange (by layer or
//! by object), live checks (off the plate, collisions, clearance, height), lay-on-face
//! candidates and auto orient. Written for FarmPrint; no slicer code is used.
//!
//! Coordinates are millimetres with the bed's front-left corner at (0, 0) and Z up.
//! A part's orientation is a unit quaternion `[x, y, z, w]` applied to its mesh as saved.
//! After orienting, a part's *reference point* is the centre of its top-down bounding box at
//! its lowest Z. Its outline (`Footprint::hull`) is given relative to that point, and a
//! `Placement` puts the reference point at `(x, y)` on a plate, turned `rot_deg` about Z.

use crate::TriangleMesh;
use serde::{Deserialize, Serialize};

pub type V2 = [f64; 2];
pub type V3 = [f64; 3];
/// Unit quaternion `[x, y, z, w]`.
pub type Quat = [f64; 4];

pub const IDENTITY: Quat = [0.0, 0.0, 0.0, 1.0];

// ---- small vector / quaternion helpers -------------------------------------------------

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross3(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn len3(a: V3) -> f64 {
    dot3(a, a).sqrt()
}
fn norm3(a: V3) -> V3 {
    let l = len3(a);
    if l > 0.0 {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        [0.0, 0.0, 1.0]
    }
}

pub fn quat_normalize(q: Quat) -> Quat {
    let l = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if l > 0.0 && l.is_finite() {
        [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
    } else {
        IDENTITY
    }
}

/// `a * b`: rotate by `b` first, then by `a`.
pub fn quat_mul(a: Quat, b: Quat) -> Quat {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

pub fn quat_rotate(q: Quat, v: V3) -> V3 {
    let u = [q[0], q[1], q[2]];
    let s = q[3];
    let uv = cross3(u, v);
    let uuv = cross3(u, uv);
    [
        v[0] + 2.0 * (s * uv[0] + uuv[0]),
        v[1] + 2.0 * (s * uv[1] + uuv[1]),
        v[2] + 2.0 * (s * uv[2] + uuv[2]),
    ]
}

pub fn quat_about_z(deg: f64) -> Quat {
    let h = deg.to_radians() / 2.0;
    [0.0, 0.0, h.sin(), h.cos()]
}

/// The shortest rotation taking unit vector `from` onto unit vector `to`.
pub fn quat_between(from: V3, to: V3) -> Quat {
    let f = norm3(from);
    let t = norm3(to);
    let d = dot3(f, t);
    if d < -0.999_999 {
        // Opposite: turn half way round any axis perpendicular to `from`.
        let mut axis = cross3([1.0, 0.0, 0.0], f);
        if len3(axis) < 1e-6 {
            axis = cross3([0.0, 1.0, 0.0], f);
        }
        let a = norm3(axis);
        return [a[0], a[1], a[2], 0.0];
    }
    let c = cross3(f, t);
    quat_normalize([c[0], c[1], c[2], 1.0 + d])
}

/// Row-major 3x3 rotation matrix of `q`.
pub fn quat_matrix(q: Quat) -> [[f64; 3]; 3] {
    let [x, y, z, w] = quat_normalize(q);
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

// ---- 2D convex geometry --------------------------------------------------------------

/// Convex hull, counter-clockwise, no repeated first point (Andrew's monotone chain).
pub fn convex_hull_2d(points: &[V2]) -> Vec<V2> {
    let mut pts: Vec<V2> = points
        .iter()
        .copied()
        .filter(|p| p[0].is_finite() && p[1].is_finite())
        .collect();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9);
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: V2, a: V2, b: V2| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Vec<V2> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 1e-12 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<V2> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 1e-12 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

pub fn polygon_area(h: &[V2]) -> f64 {
    let n = h.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    for i in 0..n {
        let p = h[i];
        let q = h[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a.abs() / 2.0
}

/// `h` turned `deg` about the origin, then moved by `(tx, ty)`.
pub fn transform_2d(h: &[V2], deg: f64, tx: f64, ty: f64) -> Vec<V2> {
    let (s, c) = deg.to_radians().sin_cos();
    h.iter()
        .map(|p| [p[0] * c - p[1] * s + tx, p[0] * s + p[1] * c + ty])
        .collect()
}

/// `[min_x, min_y, max_x, max_y]`.
pub fn bbox_2d(h: &[V2]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in h {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    if h.is_empty() {
        b = [0.0; 4];
    }
    b
}

fn separated(a: &[V2], b: &[V2]) -> bool {
    for poly in [a, b] {
        let n = poly.len();
        for i in 0..n {
            let p = poly[i];
            let q = poly[(i + 1) % n];
            let nx = q[1] - p[1];
            let ny = p[0] - q[0];
            let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
            for v in a {
                let d = v[0] * nx + v[1] * ny;
                a0 = a0.min(d);
                a1 = a1.max(d);
            }
            for v in b {
                let d = v[0] * nx + v[1] * ny;
                b0 = b0.min(d);
                b1 = b1.max(d);
            }
            if a1 < b0 || b1 < a0 {
                return true;
            }
        }
    }
    false
}

fn point_segment_distance(p: V2, a: V2, b: V2) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)).sqrt()
}

/// Gap between two convex polygons; 0 when they touch or overlap.
pub fn convex_distance(a: &[V2], b: &[V2]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return f64::INFINITY;
    }
    if a.len() >= 3 && b.len() >= 3 && !separated(a, b) {
        return 0.0;
    }
    let mut m = f64::INFINITY;
    for (p, q) in [(a, b), (b, a)] {
        let n = q.len();
        for &v in p {
            for i in 0..n {
                m = m.min(point_segment_distance(v, q[i], q[(i + 1) % n]));
            }
        }
    }
    m
}

/// Convex polygon grown by `r` with round corners (the by-object clearance capsule).
pub fn offset_convex(h: &[V2], r: f64, segments: usize) -> Vec<V2> {
    if r <= 0.0 {
        return h.to_vec();
    }
    let seg = segments.max(8);
    let mut pts = Vec::with_capacity(h.len() * seg);
    for p in h {
        for k in 0..seg {
            let a = k as f64 / seg as f64 * std::f64::consts::TAU;
            pts.push([p[0] + r * a.cos(), p[1] + r * a.sin()]);
        }
    }
    convex_hull_2d(&pts)
}

// ---- footprints ------------------------------------------------------------------------

/// A part as seen from above once oriented.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Footprint {
    /// Convex outline relative to the reference point, counter-clockwise.
    pub hull: Vec<V2>,
    /// Height above the bed once oriented.
    pub height: f64,
    /// The reference point in the oriented mesh's own coordinates (top-down bbox centre,
    /// lowest Z). The 3MF transform subtracts it.
    pub origin: V3,
    pub area: f64,
}

pub fn footprint(mesh: &TriangleMesh, q: Quat) -> Footprint {
    let q = quat_normalize(q);
    let mut flat: Vec<V2> = Vec::with_capacity(mesh.positions.len());
    let (mut zmin, mut zmax) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in &mesh.positions {
        let r = quat_rotate(q, [v[0] as f64, v[1] as f64, v[2] as f64]);
        flat.push([r[0], r[1]]);
        zmin = zmin.min(r[2]);
        zmax = zmax.max(r[2]);
    }
    if mesh.positions.is_empty() {
        return Footprint {
            hull: vec![[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]],
            height: 1.0,
            origin: [0.0; 3],
            area: 4.0,
        };
    }
    let hull = convex_hull_2d(&flat);
    let b = bbox_2d(&hull);
    let cx = (b[0] + b[2]) / 2.0;
    let cy = (b[1] + b[3]) / 2.0;
    let hull: Vec<V2> = hull.iter().map(|p| [p[0] - cx, p[1] - cy]).collect();
    let area = polygon_area(&hull);
    Footprint {
        hull,
        height: zmax - zmin,
        origin: [cx, cy, zmin],
        area,
    }
}

// ---- settings, placements --------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Sequence {
    #[default]
    ByLayer,
    ByObject,
}

/// Arrange settings, remembered per printer by the app.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ArrangeSettings {
    pub spacing_mm: f64,
    pub auto_rotate: bool,
    pub align_y: bool,
    pub sequence: Sequence,
    /// Max radius: around the nozzle, must stay clear of finished parts (by object).
    pub clearance_radius_mm: f64,
    /// Height to rod: nozzle tip to the lowest part of the gantry (by object).
    #[serde(alias = "clearance_height_to_rod_mm")]
    pub clearance_height_mm: f64,
    /// Distance to rod: parts taller than the height to rod need this much room front to
    /// back (Y, along which the gantry rod sweeps) from each other. None = the max radius.
    pub clearance_dist_to_rod_mm: Option<f64>,
    /// Height to lid: every part but the last printed on a plate must be lower than this;
    /// the last may use the full build height. None = no lid limit.
    pub clearance_height_to_lid_mm: Option<f64>,
}

pub const DEFAULT_SPACING_MM: f64 = 5.0;
/// Generic by-object defaults used until a printer has its own values (not tied to any model).
pub const DEFAULT_CLEARANCE_RADIUS_MM: f64 = 35.0;
pub const DEFAULT_CLEARANCE_HEIGHT_MM: f64 = 30.0;

impl Default for ArrangeSettings {
    fn default() -> Self {
        ArrangeSettings {
            spacing_mm: DEFAULT_SPACING_MM,
            auto_rotate: true,
            align_y: false,
            sequence: Sequence::ByLayer,
            clearance_radius_mm: DEFAULT_CLEARANCE_RADIUS_MM,
            clearance_height_mm: DEFAULT_CLEARANCE_HEIGHT_MM,
            clearance_dist_to_rod_mm: None,
            clearance_height_to_lid_mm: None,
        }
    }
}

impl ArrangeSettings {
    /// The smallest gap allowed between two outlines when arranging.
    pub fn min_gap(&self) -> f64 {
        let s = self.spacing_mm.max(0.0);
        match self.sequence {
            Sequence::ByLayer => s,
            Sequence::ByObject => s.max(self.clearance_radius_mm.max(0.0)),
        }
    }

    /// Distance to rod in effect (by object only); None when the printer has none set,
    /// which skips the front-to-back check.
    pub fn dist_to_rod(&self) -> Option<f64> {
        if self.sequence != Sequence::ByObject {
            return None;
        }
        self.clearance_dist_to_rod_mm.filter(|v| v.is_finite() && *v >= 0.0)
    }

    /// Height to lid in effect (by object only).
    pub fn height_to_lid(&self) -> Option<f64> {
        if self.sequence != Sequence::ByObject {
            return None;
        }
        self.clearance_height_to_lid_mm.filter(|v| v.is_finite() && *v > 0.0)
    }

    /// By object: taller than the height to rod.
    pub fn above_rod(&self, height: f64) -> bool {
        self.sequence == Sequence::ByObject && height > self.clearance_height_mm + 0.01
    }

    /// By object: taller than the height to lid (so it must print last on its plate).
    pub fn above_lid(&self, height: f64) -> bool {
        self.height_to_lid().is_some_and(|l| height > l + 0.01)
    }
}

/// The printer's build volume. `height_mm` is None when the printer has no height set.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BedSize {
    pub width_mm: f64,
    pub depth_mm: f64,
    #[serde(default)]
    pub height_mm: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct Placement {
    /// 0-based plate number.
    pub plate: usize,
    pub x: f64,
    pub y: f64,
    /// Turn about Z, degrees, counter-clockwise seen from above.
    pub rot_deg: f64,
}

/// Where one part may sit on a printer with print areas: a rectangle on the bed
/// `[x0, y0, x1, y1]` (mm) and the build height there. `label` names who reaches it
/// ("Left nozzle", "Both nozzles", or an area's name) for messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reach {
    pub rect: [f64; 4],
    #[serde(default)]
    pub height_mm: Option<f64>,
    #[serde(default)]
    pub label: String,
}

/// One print area as the printer settings give it (origin = front-left corner, bed mm).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PrintAreaSpec {
    #[serde(default)]
    pub name: String,
    pub x_mm: f64,
    pub y_mm: f64,
    pub width_mm: f64,
    pub depth_mm: f64,
    #[serde(default)]
    pub height_mm: Option<f64>,
    /// "left" / "right" / "both"; None = read from the name ("Left nozzle"), else no nozzle.
    #[serde(default)]
    pub nozzle: Option<String>,
}

impl PrintAreaSpec {
    pub fn rect(&self) -> [f64; 4] {
        [self.x_mm, self.y_mm, self.x_mm + self.width_mm, self.y_mm + self.depth_mm]
    }

    /// The nozzle this area is for: the explicit field, or a name that says exactly one
    /// of "left" / "right".
    pub fn nozzle_side(&self) -> Option<String> {
        if let Some(n) = self.nozzle.as_deref().map(|n| n.trim().to_ascii_lowercase()) {
            // Set explicitly ("left" / "right" / "both"): the name doesn't matter.
            return (n == "left" || n == "right").then_some(n);
        }
        let name = self.name.to_ascii_lowercase();
        match (name.contains("left"), name.contains("right")) {
            (true, false) => Some("left".into()),
            (false, true) => Some("right".into()),
            _ => None,
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Where every nozzle reaches: the overlap of all areas, the lowest height among them.
/// None when there are no areas; an empty rectangle when they don't overlap.
pub fn shared_reach(areas: &[PrintAreaSpec]) -> Option<Reach> {
    let first = areas.first()?;
    let mut r = first.rect();
    let mut h = first.height_mm;
    for a in &areas[1..] {
        let b = a.rect();
        r = [r[0].max(b[0]), r[1].max(b[1]), r[2].min(b[2]), r[3].min(b[3])];
        h = match (h, a.height_mm) {
            (Some(x), Some(y)) => Some(x.min(y)),
            (x, y) => x.or(y),
        };
    }
    let sides: std::collections::BTreeSet<String> = areas.iter().filter_map(|a| a.nozzle_side()).collect();
    let label = if sides.len() >= 2 { "Both nozzles".to_string() } else { "Every area".to_string() };
    Some(Reach { rect: r, height_mm: h, label })
}

/// Where a part printed by `nozzles` may sit. One known nozzle with its own area: that
/// area. Both nozzles, an unknown one, or no area for it: where every nozzle reaches.
/// None when the printer has no areas (the whole bed, as before areas).
pub fn reach_for_nozzles(areas: &[PrintAreaSpec], nozzles: &[Option<String>]) -> Option<Reach> {
    if areas.is_empty() {
        return None;
    }
    let mut sides: Vec<String> = Vec::new();
    for n in nozzles {
        match n.as_deref().map(|n| n.trim().to_ascii_lowercase()) {
            Some(n) if n == "left" || n == "right" => {
                if !sides.contains(&n) {
                    sides.push(n);
                }
            }
            _ => return shared_reach(areas),
        }
    }
    if sides.len() == 1 {
        let side = &sides[0];
        let own: Vec<&PrintAreaSpec> = areas.iter().filter(|a| a.nozzle_side().as_deref() == Some(side.as_str())).collect();
        if let Some(a) = own.first() {
            return Some(Reach {
                rect: a.rect(),
                height_mm: a.height_mm,
                label: format!("{} nozzle", capitalize(side)),
            });
        }
    }
    shared_reach(areas)
}

/// The area the user picked by name (or "both"/"shared" for where every nozzle reaches).
pub fn reach_for_area_name(areas: &[PrintAreaSpec], name: &str) -> Option<Reach> {
    let n = name.trim();
    if let Some(a) = areas.iter().find(|a| a.name.trim().eq_ignore_ascii_case(n)) {
        return Some(Reach { rect: a.rect(), height_mm: a.height_mm, label: a.name.trim().to_string() });
    }
    if n.eq_ignore_ascii_case("shared") || n.eq_ignore_ascii_case("both") {
        return shared_reach(areas);
    }
    None
}

/// One part to arrange: its oriented outline, its height, its current turn about Z (kept
/// when auto-rotate is off), and an optional fixed spot (the user dragged it there).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArrangeItem {
    pub hull: Vec<V2>,
    pub height: f64,
    #[serde(default)]
    pub rot_deg: f64,
    #[serde(default)]
    pub pinned: Option<Placement>,
    /// Where it may sit on a printer with print areas; None = anywhere on the bed.
    #[serde(default)]
    pub reach: Option<Reach>,
}

impl ArrangeItem {
    pub fn from_footprint(f: &Footprint) -> Self {
        ArrangeItem {
            hull: f.hull.clone(),
            height: f.height,
            rot_deg: 0.0,
            pinned: None,
            reach: None,
        }
    }

    /// The rectangle it may sit in on `bed`: its reach clipped to the bed, or the bed.
    pub fn allowed_rect(&self, bed: &BedSize) -> [f64; 4] {
        let full = [0.0, 0.0, bed.width_mm, bed.depth_mm];
        match &self.reach {
            Some(r) => [r.rect[0].max(0.0), r.rect[1].max(0.0), r.rect[2].min(full[2]), r.rect[3].min(full[3])],
            None => full,
        }
    }

    /// Build height where it may sit: the lower of the bed's and its area's.
    pub fn height_limit(&self, bed: &BedSize) -> Option<f64> {
        match (bed.height_mm, self.reach.as_ref().and_then(|r| r.height_mm)) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

/// The turn (degrees) that puts the outline's smallest bounding rectangle long side along Y.
pub fn align_y_angle(hull: &[V2]) -> f64 {
    let n = hull.len();
    if n < 3 {
        return 0.0;
    }
    let mut best = (f64::INFINITY, 0.0);
    for i in 0..n {
        let p = hull[i];
        let q = hull[(i + 1) % n];
        let edge = (q[1] - p[1]).atan2(q[0] - p[0]).to_degrees();
        let rot = -edge; // edge lies along +X after this turn
        let b = bbox_2d(&transform_2d(hull, rot, 0.0, 0.0));
        let (w, h) = (b[2] - b[0], b[3] - b[1]);
        let a = w * h;
        if a < best.0 - 1e-6 {
            best = (a, if w > h { rot + 90.0 } else { rot });
        }
    }
    normalize_deg(best.1)
}

fn normalize_deg(d: f64) -> f64 {
    let r = d.rem_euclid(360.0);
    if (r - 360.0).abs() < 1e-9 {
        0.0
    } else {
        r
    }
}

fn rotations_for(item: &ArrangeItem, s: &ArrangeSettings) -> Vec<f64> {
    if s.align_y {
        let a = align_y_angle(&item.hull);
        return vec![a, normalize_deg(a + 180.0)];
    }
    if !s.auto_rotate {
        return vec![item.rot_deg];
    }
    let mut r: Vec<f64> = (0..24).map(|k| k as f64 * 15.0).collect();
    let a = align_y_angle(&item.hull);
    for extra in [a, a + 90.0, a + 180.0, a + 270.0] {
        r.push(normalize_deg(extra));
    }
    r
}

struct Placed {
    bb: [f64; 4],
    /// `poly` grown by the gap (round corners, circumscribed), for no-fit polygons.
    grown: Vec<V2>,
}

impl Placed {
    fn new(poly: Vec<V2>, gap: f64) -> Self {
        let bb = bbox_2d(&poly);
        let grown = grow(&poly, gap);
        Placed { bb, grown }
    }
}

/// Grown by `r` with round corners whose polygon stays outside the true circle.
fn grow(poly: &[V2], r: f64) -> Vec<V2> {
    if r <= 0.0 {
        return poly.to_vec();
    }
    let seg = 16usize;
    offset_convex(poly, r / (std::f64::consts::PI / seg as f64).cos(), seg)
}

/// Removes hull corners that change the outline by less than `tol` (mm), keeping at least
/// eight. The result lies inside the original by at most `tol`.
pub fn simplify_convex(h: &[V2], tol: f64) -> Vec<V2> {
    let mut v = h.to_vec();
    while v.len() > 8 {
        let n = v.len();
        let mut best = (f64::INFINITY, 0usize);
        for i in 0..n {
            let d = point_segment_distance(v[i], v[(i + n - 1) % n], v[(i + 1) % n]);
            if d < best.0 {
                best = (d, i);
            }
        }
        if best.0 > tol {
            break;
        }
        v.remove(best.1);
    }
    v
}

/// Minkowski sum of two convex counter-clockwise polygons.
pub fn minkowski_convex(a: &[V2], b: &[V2]) -> Vec<V2> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let start = |p: &[V2]| {
        (0..p.len())
            .min_by(|&i, &j| p[i][1].total_cmp(&p[j][1]).then(p[i][0].total_cmp(&p[j][0])))
            .unwrap()
    };
    let (ia, ib) = (start(a), start(b));
    let (na, nb) = (a.len(), b.len());
    let mut out = Vec::with_capacity(na + nb);
    let (mut i, mut j) = (0usize, 0usize);
    while i < na || j < nb {
        let pa = a[(ia + i) % na];
        let pb = b[(ib + j) % nb];
        out.push([pa[0] + pb[0], pa[1] + pb[1]]);
        let ea = {
            let q = a[(ia + i + 1) % na];
            [q[0] - pa[0], q[1] - pa[1]]
        };
        let eb = {
            let q = b[(ib + j + 1) % nb];
            [q[0] - pb[0], q[1] - pb[1]]
        };
        let cross = ea[0] * eb[1] - ea[1] * eb[0];
        if j >= nb || (i < na && cross > 0.0) {
            i += 1;
        } else if i >= na || cross < 0.0 {
            j += 1;
        } else {
            i += 1;
            j += 1;
        }
    }
    convex_hull_2d(&out)
}

/// Strictly inside a convex counter-clockwise polygon (touching the edge is outside).
fn strictly_inside(p: V2, poly: &[V2]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        if (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 1e-7 {
            return false;
        }
    }
    true
}

fn fits_on_empty_bed(hull: &[V2], rots: &[f64], area: [f64; 4]) -> bool {
    rots.iter().any(|&r| {
        let b = bbox_2d(&transform_2d(hull, r, 0.0, 0.0));
        b[2] - b[0] <= area[2] - area[0] + 1e-6 && b[3] - b[1] <= area[3] - area[1] + 1e-6
    })
}

fn union_bb(placed: &[Placed]) -> Option<[f64; 4]> {
    let mut it = placed.iter();
    let first = it.next()?.bb;
    Some(it.fold(first, |u, p| [u[0].min(p.bb[0]), u[1].min(p.bb[1]), u[2].max(p.bb[2]), u[3].max(p.bb[3])]))
}

fn pile_score(pile: Option<[f64; 4]>, bb: [f64; 4], x: f64, y: f64) -> f64 {
    let u = match pile {
        Some(p) => [p[0].min(bb[0]), p[1].min(bb[1]), p[2].max(bb[2]), p[3].max(bb[3])],
        None => bb,
    };
    let (w, h) = (u[2] - u[0], u[3] - u[1]);
    // Pile area keeps rows tight; the max-side term keeps the pile square-ish.
    w * h + 0.5 * w.max(h).powi(2) + (x + y) * 0.01
}

/// Where the reference point of `h0` may not go: one no-fit polygon per placed part.
struct Nfp {
    poly: Vec<V2>,
    bb: [f64; 4],
}

fn nfps_for(h0: &[V2], placed: &[Placed]) -> Vec<Nfp> {
    let neg: Vec<V2> = convex_hull_2d(&h0.iter().map(|p| [-p[0], -p[1]]).collect::<Vec<_>>());
    placed
        .iter()
        .map(|p| {
            let poly = minkowski_convex(&p.grown, &neg);
            let bb = bbox_2d(&poly);
            Nfp { poly, bb }
        })
        .collect()
}

fn free_at(nfps: &[Nfp], x: f64, y: f64) -> bool {
    nfps.iter().all(|n| {
        x <= n.bb[0] || x >= n.bb[2] || y <= n.bb[1] || y >= n.bb[3] || !strictly_inside([x, y], &n.poly)
    })
}

fn best_spot(
    hull: &[V2],
    rots: &[f64],
    placed: &[Placed],
    area: [f64; 4],
    step: f64,
    bands: &[[f64; 2]],
) -> Option<(Placement, Vec<V2>)> {
    // By object, tall parts: Y ranges (already grown by the distance to rod) this part's
    // outline may not enter.
    let clear_of_bands = |y0: f64, y1: f64| bands.iter().all(|b| y1 <= b[0] + 1e-9 || y0 >= b[1] - 1e-9);
    let (aw, ad) = (area[2] - area[0], area[3] - area[1]);
    let pile = union_bb(placed);
    let mut best: Option<(f64, Placement)> = None;
    for &r in rots {
        let h0 = transform_2d(hull, r, 0.0, 0.0);
        let b = bbox_2d(&h0);
        // The simplified outline can sit up to SIMPLIFY_MM inside the real one: keep that
        // much from the bed edges too (less only when the part barely fits).
        let mx = edge_margin(aw - (b[2] - b[0]));
        let my = edge_margin(ad - (b[3] - b[1]));
        let (x0, x1) = (area[0] - b[0] + mx, area[2] - b[2] - mx);
        let (y0, y1) = (area[1] - b[1] + my, area[3] - b[3] - my);
        if x1 < x0 - 1e-9 || y1 < y0 - 1e-9 {
            continue;
        }
        let (x1, y1) = (x1.max(x0), y1.max(y0));
        let nfps = nfps_for(&h0, placed);
        // Candidates: a grid over the bed, the bed corners, and every no-fit vertex (spots
        // touching a placed part at exactly the gap).
        let mut cands: Vec<V2> = vec![[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        for bd in bands {
            for y in [bd[1] - b[1], bd[0] - b[3]] {
                if y >= y0 - 1e-9 && y <= y1 + 1e-9 {
                    let y = y.clamp(y0, y1);
                    cands.push([x0, y]);
                    cands.push([x1, y]);
                    cands.push([(x0 + x1) / 2.0, y]);
                }
            }
        }
        for n in &nfps {
            for v in &n.poly {
                if v[0] >= x0 - 1e-9 && v[0] <= x1 + 1e-9 && v[1] >= y0 - 1e-9 && v[1] <= y1 + 1e-9 {
                    cands.push([v[0].clamp(x0, x1), v[1].clamp(y0, y1)]);
                }
                // Slid against the bed edges too.
                if v[1] >= y0 && v[1] <= y1 {
                    cands.push([x0, v[1]]);
                }
                if v[0] >= x0 && v[0] <= x1 {
                    cands.push([v[0], y0]);
                }
            }
        }
        let nx = ((x1 - x0) / step).floor() as usize;
        let ny = ((y1 - y0) / step).floor() as usize;
        for ix in 0..=nx {
            for iy in 0..=ny {
                cands.push([x0 + ix as f64 * step, y0 + iy as f64 * step]);
            }
        }
        for [x, y] in cands {
            let bb = [b[0] + x, b[1] + y, b[2] + x, b[3] + y];
            let score = pile_score(pile, bb, x, y);
            if let Some((bs, _)) = best {
                if score >= bs {
                    continue;
                }
            }
            if clear_of_bands(y + b[1], y + b[3]) && free_at(&nfps, x, y) {
                best = Some((score, Placement { plate: 0, x, y, rot_deg: r }));
            }
        }
    }
    let (_, mut p) = best?;
    // Slide toward the front-left corner so gaps close to the spacing.
    let h0 = transform_2d(hull, p.rot_deg, 0.0, 0.0);
    let b = bbox_2d(&h0);
    let nfps = nfps_for(&h0, placed);
    let (mx, my) = (edge_margin(aw - (b[2] - b[0])), edge_margin(ad - (b[3] - b[1])));
    let ok = |x: f64, y: f64| {
        x + b[0] >= area[0] + mx - 1e-9
            && y + b[1] >= area[1] + my - 1e-9
            && clear_of_bands(y + b[1], y + b[3])
            && free_at(&nfps, x, y)
    };
    let mut fine = step / 2.0;
    while fine >= 0.125 {
        loop {
            let mut moved = false;
            if ok(p.x - fine, p.y) {
                p.x -= fine;
                moved = true;
            }
            if ok(p.x, p.y - fine) {
                p.y -= fine;
                moved = true;
            }
            if !moved {
                break;
            }
        }
        fine /= 2.0;
    }
    Some((p, transform_2d(&h0, 0.0, p.x, p.y)))
}

const SIMPLIFY_MM: f64 = 0.25;

/// Distance kept from the bed edges for a part with `slack` mm of room along one axis.
fn edge_margin(slack: f64) -> f64 {
    SIMPLIFY_MM.min((slack / 2.0).max(0.0))
}

/// Arranges every unpinned item, filling plate 1 first and adding plates as needed. Pinned
/// items stay where they are and act as obstacles. An item larger than the bed stays on
/// plate 1 at the centre (the check reports it as off the plate). Returns one placement per
/// item, in input order.
pub fn arrange(items: &[ArrangeItem], bed: &BedSize, s: &ArrangeSettings) -> Vec<Placement> {
    // Outlines are simplified (at most SIMPLIFY_MM inside the real one), so the gap grows by it.
    let gap = s.min_gap() + SIMPLIFY_MM;
    let mut out: Vec<Option<Placement>> = vec![None; items.len()];
    let mut plates: Vec<Vec<Placed>> = Vec::new();
    let mut plate_has_pin: Vec<bool> = Vec::new();
    let ensure = |plates: &mut Vec<Vec<Placed>>, pins: &mut Vec<bool>, n: usize| {
        while plates.len() <= n {
            plates.push(Vec::new());
            pins.push(false);
        }
    };
    for (i, it) in items.iter().enumerate() {
        if let Some(p) = it.pinned {
            ensure(&mut plates, &mut plate_has_pin, p.plate);
            let poly = transform_2d(&simplify_convex(&it.hull, SIMPLIFY_MM), p.rot_deg, p.x, p.y);
            plates[p.plate].push(Placed::new(poly, gap));
            plate_has_pin[p.plate] = true;
            out[i] = Some(p);
        }
    }
    ensure(&mut plates, &mut plate_has_pin, 0);
    let mut order: Vec<usize> = (0..items.len()).filter(|&i| items[i].pinned.is_none()).collect();
    let rects: Vec<[f64; 4]> = items.iter().map(|it| it.allowed_rect(bed)).collect();
    let rect_area = |r: [f64; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    let any_reach = items.iter().any(|it| it.reach.is_some());
    // Parts that may sit in less of the bed go first (with print areas: parts that need
    // both nozzles take the shared strip before one-nozzle parts fill around them).
    order.sort_by(|&a, &b| {
        rect_area(rects[a])
            .total_cmp(&rect_area(rects[b]))
            .then(polygon_area(&items[b].hull).total_cmp(&polygon_area(&items[a].hull)))
            .then(items[b].height.total_cmp(&items[a].height))
            .then(a.cmp(&b))
    });
    let step = (bed.width_mm.min(bed.depth_mm) / 64.0).clamp(2.0, 8.0);
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); plates.len()];
    // By object: per plate, Y ranges of parts above the rod, and whether a part above the
    // lid is already there (only one may be, printed last).
    let rod_dist = s.dist_to_rod();
    let rod = rod_dist.unwrap_or(0.0);
    let above_rod = |h: f64| rod_dist.is_some() && s.above_rod(h);
    let mut rod_bands: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut lid_used: Vec<bool> = Vec::new();
    for it in items {
        if let Some(p) = it.pinned {
            if rod_bands.len() <= p.plate {
                rod_bands.resize(p.plate + 1, Vec::new());
                lid_used.resize(p.plate + 1, false);
            }
            if above_rod(it.height) {
                let b = bbox_2d(&placed_outline(it, &p));
                rod_bands[p.plate].push([b[1] - rod, b[3] + rod]);
            }
            if s.above_lid(it.height) {
                lid_used[p.plate] = true;
            }
        }
    }
    for idx in order {
        let it = &items[idx];
        let rots = rotations_for(it, s);
        let area = rects[idx];
        if area[2] - area[0] <= 0.0 || area[3] - area[1] <= 0.0 || !fits_on_empty_bed(&it.hull, &rots, area) {
            out[idx] = Some(Placement {
                plate: 0,
                x: (area[0] + area[2]) / 2.0,
                y: (area[1] + area[3]) / 2.0,
                rot_deg: rots[0],
            });
            continue;
        }
        let simple = simplify_convex(&it.hull, SIMPLIFY_MM);
        let mut pi = 0;
        while pi <= items.len() + 1 {
            ensure(&mut plates, &mut plate_has_pin, pi);
            if members.len() <= pi {
                members.resize(pi + 1, Vec::new());
            }
            if rod_bands.len() <= pi {
                rod_bands.resize(pi + 1, Vec::new());
                lid_used.resize(pi + 1, false);
            }
            let tall = above_rod(it.height);
            let over_lid = s.above_lid(it.height);
            if over_lid && lid_used[pi] {
                pi += 1;
                continue;
            }
            let no_bands: [[f64; 2]; 0] = [];
            let bands: &[[f64; 2]] = if tall { &rod_bands[pi] } else { &no_bands };
            if let Some((pl, poly)) = best_spot(&simple, &rots, &plates[pi], area, step, bands) {
                if tall {
                    let b = bbox_2d(&poly);
                    // The real outline can sit up to SIMPLIFY_MM outside the simplified one.
                    rod_bands[pi].push([b[1] - rod - SIMPLIFY_MM, b[3] + rod + SIMPLIFY_MM]);
                }
                if over_lid {
                    lid_used[pi] = true;
                }
                out[idx] = Some(Placement { plate: pi, ..pl });
                plates[pi].push(Placed::new(poly, gap));
                members[pi].push(idx);
                break;
            }
            pi += 1;
        }
    }
    // Centre each plate's pile on the bed (plates holding a pinned part stay as they are).
    for (pi, list) in members.iter().enumerate() {
        if list.is_empty() || plate_has_pin.get(pi).copied().unwrap_or(false) {
            continue;
        }
        let Some(u) = union_bb(&plates[pi]) else { continue };
        let mut dx = bed.width_mm / 2.0 - (u[0] + u[2]) / 2.0;
        let mut dy = bed.depth_mm / 2.0 - (u[1] + u[3]) / 2.0;
        if any_reach {
            // Keep every part inside its own area while centring.
            let (mut lx, mut hx, mut ly, mut hy) = (f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY);
            for &i in list {
                let Some(p) = out[i] else { continue };
                let b = bbox_2d(&placed_outline(&items[i], &p));
                let r = rects[i];
                lx = lx.max(r[0] - b[0]);
                hx = hx.min(r[2] - b[2]);
                ly = ly.max(r[1] - b[1]);
                hy = hy.min(r[3] - b[3]);
            }
            dx = if lx <= hx { dx.clamp(lx, hx) } else { 0.0 };
            dy = if ly <= hy { dy.clamp(ly, hy) } else { 0.0 };
        }
        for &i in list {
            if let Some(p) = out[i].as_mut() {
                p.x += dx;
                p.y += dy;
            }
        }
    }
    out.into_iter().map(|p| p.unwrap_or_default()).collect()
}

// ---- checks ------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlateCheck {
    /// Number of plates used (highest plate + 1).
    pub plates: usize,
    /// Items whose outline leaves the bed.
    pub off_plate: Vec<usize>,
    /// Pairs of items on the same plate whose outlines overlap.
    pub collisions: Vec<[usize; 2]>,
    /// By object: pairs closer than the clearance radius.
    pub clearance_overlaps: Vec<[usize; 2]>,
    /// Items taller than the printer's build height, or their print area's height.
    pub too_tall: Vec<usize>,
    /// Items on the bed but outside the print area that can print them.
    #[serde(default)]
    pub out_of_area: Vec<usize>,
    /// By object: items taller than the height to rod (they print last, back to front).
    pub taller_than_gantry: Vec<usize>,
    /// By object: pairs of items above the height to rod closer front to back (Y) than the
    /// distance to rod; the gantry rod would hit the one printed first.
    #[serde(default)]
    pub rod_conflicts: Vec<[usize; 2]>,
    /// By object: items above the height to lid on a plate that has more than one of them
    /// (only the last printed may go above the lid).
    #[serde(default)]
    pub over_lid: Vec<usize>,
    /// By object: print order per plate, item indices.
    pub order: Vec<Vec<usize>>,
    /// Share of plate 1 covered by outlines, 0..1.
    pub plate1_fill: f64,
    pub tallest_mm: f64,
}

impl PlateCheck {
    /// True when every part is on a plate, nothing overlaps, and nothing is too tall.
    pub fn fits(&self) -> bool {
        self.off_plate.is_empty()
            && self.collisions.is_empty()
            && self.too_tall.is_empty()
            && self.out_of_area.is_empty()
            && self.rod_conflicts.is_empty()
            && self.over_lid.is_empty()
    }
}

pub fn placed_outline(item: &ArrangeItem, p: &Placement) -> Vec<V2> {
    transform_2d(&item.hull, p.rot_deg, p.x, p.y)
}

pub fn check(items: &[ArrangeItem], placements: &[Placement], bed: &BedSize, s: &ArrangeSettings) -> PlateCheck {
    let n = items.len().min(placements.len());
    let polys: Vec<Vec<V2>> = (0..n).map(|i| placed_outline(&items[i], &placements[i])).collect();
    let bbs: Vec<[f64; 4]> = polys.iter().map(|p| bbox_2d(p)).collect();
    let mut c = PlateCheck {
        plates: placements.iter().take(n).map(|p| p.plate + 1).max().unwrap_or(0),
        ..Default::default()
    };
    let eps = 0.01;
    for i in 0..n {
        let b = bbs[i];
        if b[0] < -eps || b[1] < -eps || b[2] > bed.width_mm + eps || b[3] > bed.depth_mm + eps {
            c.off_plate.push(i);
        } else if items[i].reach.is_some() {
            let r = items[i].allowed_rect(bed);
            if b[0] < r[0] - eps || b[1] < r[1] - eps || b[2] > r[2] + eps || b[3] > r[3] + eps {
                c.out_of_area.push(i);
            }
        }
        if let Some(h) = items[i].height_limit(bed) {
            if items[i].height > h + eps {
                c.too_tall.push(i);
            }
        }
        c.tallest_mm = c.tallest_mm.max(items[i].height);
        if s.above_rod(items[i].height) {
            c.taller_than_gantry.push(i);
        }
    }
    for i in 0..n {
        for j in i + 1..n {
            if placements[i].plate != placements[j].plate {
                continue;
            }
            let d = convex_distance(&polys[i], &polys[j]);
            if d <= 0.0 && polys[i].len() >= 3 && polys[j].len() >= 3 && overlap_depth_positive(&polys[i], &polys[j]) {
                c.collisions.push([i, j]);
            }
            if s.sequence == Sequence::ByObject && d < s.clearance_radius_mm - eps {
                c.clearance_overlaps.push([i, j]);
            }
            if let Some(rod) = s.dist_to_rod().filter(|_| s.above_rod(items[i].height) && s.above_rod(items[j].height)) {
                let (a, b) = (bbs[i], bbs[j]);
                let gap = (b[1] - a[3]).max(a[1] - b[3]);
                if gap < rod - eps {
                    c.rod_conflicts.push([i, j]);
                }
            }
        }
    }
    let area1: f64 = (0..n)
        .filter(|&i| placements[i].plate == 0)
        .map(|i| polygon_area(&polys[i]))
        .sum();
    c.plate1_fill = if bed.width_mm > 0.0 && bed.depth_mm > 0.0 {
        (area1 / (bed.width_mm * bed.depth_mm)).min(1.0)
    } else {
        0.0
    };
    if s.height_to_lid().is_some() {
        let plates = c.plates;
        for pl in 0..plates {
            let over: Vec<usize> = (0..n).filter(|&i| placements[i].plate == pl && s.above_lid(items[i].height)).collect();
            if over.len() > 1 {
                c.over_lid.extend(over);
            }
        }
    }
    if s.sequence == Sequence::ByObject {
        c.order = object_order(items, placements, s);
    }
    c
}

/// Touching outlines (shared edge) are not a collision; only real overlap is.
fn overlap_depth_positive(a: &[V2], b: &[V2]) -> bool {
    let shrink = |h: &[V2]| -> Vec<V2> {
        let n = h.len() as f64;
        let cx = h.iter().map(|p| p[0]).sum::<f64>() / n;
        let cy = h.iter().map(|p| p[1]).sum::<f64>() / n;
        h.iter()
            .map(|p| {
                let (dx, dy) = (p[0] - cx, p[1] - cy);
                let l = (dx * dx + dy * dy).sqrt().max(1e-9);
                let k = ((l - 0.05).max(0.0)) / l;
                [cx + dx * k, cy + dy * k]
            })
            .collect()
    };
    !separated(&shrink(a), &shrink(b))
}

/// By-object print order per plate: back to front, left to right, and a part taller than the
/// gantry clearance last.
pub fn object_order(items: &[ArrangeItem], placements: &[Placement], s: &ArrangeSettings) -> Vec<Vec<usize>> {
    let n = items.len().min(placements.len());
    let plates = placements.iter().take(n).map(|p| p.plate + 1).max().unwrap_or(0);
    let row = s.clearance_radius_mm.max(10.0);
    (0..plates)
        .map(|pl| {
            let mut idx: Vec<usize> = (0..n).filter(|&i| placements[i].plate == pl).collect();
            idx.sort_by(|&a, &b| {
                let ta = items[a].height > s.clearance_height_mm;
                let tb = items[b].height > s.clearance_height_mm;
                // Above the lid prints very last; above the rod after the rest.
                s.above_lid(items[a].height)
                    .cmp(&s.above_lid(items[b].height))
                    .then(ta.cmp(&tb))
                    .then((-(placements[a].y / row).round()).total_cmp(&(-(placements[b].y / row).round())))
                    .then(placements[a].x.total_cmp(&placements[b].x))
            });
            idx
        })
        .collect()
}

// ---- 3MF transform ---------------------------------------------------------------------------

/// The 3MF `<item transform>` (12 numbers, row-vector convention) that turns a saved mesh by
/// `q`, then puts its reference point at the placement and its lowest point on the bed.
pub fn item_transform(origin: V3, q: Quat, p: &Placement) -> [f64; 12] {
    let m = quat_matrix(quat_mul(quat_about_z(p.rot_deg), q));
    let rz = quat_about_z(p.rot_deg);
    let o = quat_rotate(rz, origin);
    let t = [p.x - o[0], p.y - o[1], -o[2]];
    [
        m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2], t[0], t[1], t[2],
    ]
}

/// Applies a 3MF transform to a point.
pub fn apply_transform(t: &[f64; 12], v: V3) -> V3 {
    [
        v[0] * t[0] + v[1] * t[3] + v[2] * t[6] + t[9],
        v[0] * t[1] + v[1] * t[4] + v[2] * t[7] + t[10],
        v[0] * t[2] + v[1] * t[5] + v[2] * t[8] + t[11],
    ]
}

// ---- lay on face / auto orient -------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FaceMode {
    #[default]
    ConvexHull,
    Triangle,
}

/// A flat face the part can be put down on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FaceCandidate {
    /// Outward normal in the saved mesh's coordinates.
    pub normal: V3,
    /// Area of the flat face (hull face in hull mode).
    pub area: f64,
    /// Area of the mesh actually touching the bed with this face down.
    pub contact_area: f64,
    /// The centre of mass sits over the face.
    pub stable: bool,
    /// Height with this face down.
    pub height: f64,
    /// Downward-facing area steeper than 45° that is off the bed with this face down.
    pub overhang_area: f64,
    /// Orientation (applied to the saved mesh) that puts this face on the bed.
    pub orientation: Quat,
    /// The face's triangles in the saved mesh's coordinates, for drawing.
    pub triangles: Vec<[V3; 3]>,
}

fn mesh_points(mesh: &TriangleMesh) -> Vec<V3> {
    let (pos, _) = crate::weld_mesh(mesh);
    pos.iter().map(|v| [v[0] as f64, v[1] as f64, v[2] as f64]).collect()
}

fn mesh_triangles(mesh: &TriangleMesh) -> Vec<[V3; 3]> {
    let p = |i: u32| -> Option<V3> {
        mesh.positions
            .get(i as usize)
            .map(|v| [v[0] as f64, v[1] as f64, v[2] as f64])
    };
    mesh.indices
        .iter()
        .filter_map(|t| Some([p(t[0])?, p(t[1])?, p(t[2])?]))
        .collect()
}

fn tri_normal_area(t: &[V3; 3]) -> (V3, f64) {
    let c = cross3(sub3(t[1], t[0]), sub3(t[2], t[0]));
    let l = len3(c);
    if l <= 0.0 {
        return ([0.0, 0.0, 1.0], 0.0);
    }
    ([c[0] / l, c[1] / l, c[2] / l], l / 2.0)
}

/// Centre of mass of a closed mesh (signed tetrahedra); the vertex mean for open meshes.
pub fn center_of_mass(tris: &[[V3; 3]]) -> V3 {
    let mut vol = 0.0;
    let mut c = [0.0; 3];
    for t in tris {
        let v = dot3(t[0], cross3(t[1], t[2])) / 6.0;
        vol += v;
        for k in 0..3 {
            c[k] += v * (t[0][k] + t[1][k] + t[2][k]) / 4.0;
        }
    }
    if vol.abs() > 1e-9 {
        return [c[0] / vol, c[1] / vol, c[2] / vol];
    }
    let n = (tris.len() * 3).max(1) as f64;
    let mut m = [0.0; 3];
    for t in tris {
        for v in t {
            for k in 0..3 {
                m[k] += v[k] / n;
            }
        }
    }
    m
}

/// 3D convex hull (incremental, with horizon edges). Returns outward triangles as indices
/// into `pts`. Empty when the points are flat or too few.
pub fn convex_hull_3d(pts_in: &[V3]) -> Vec<[usize; 3]> {
    use std::collections::HashMap;
    // Models repeat each corner once per triangle: hull the distinct points only (snapped to
    // 1/10000 mm), centred on their middle so the arithmetic stays precise.
    let mut uniq: Vec<V3> = Vec::new();
    let mut back: Vec<usize> = Vec::new();
    {
        let mut seen: HashMap<(i64, i64, i64), ()> = HashMap::new();
        for (i, p) in pts_in.iter().enumerate() {
            if !p.iter().all(|v| v.is_finite()) {
                continue;
            }
            let key = ((p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64, (p[2] * 1e4).round() as i64);
            if seen.insert(key, ()).is_none() {
                uniq.push(*p);
                back.push(i);
            }
        }
    }
    let n = uniq.len();
    if n < 4 {
        return Vec::new();
    }
    let mut c = [0.0; 3];
    for p in &uniq {
        for k in 0..3 {
            c[k] += p[k] / n as f64;
        }
    }
    let pts: Vec<V3> = uniq.iter().map(|p| sub3(*p, c)).collect();
    let pts = &pts[..];
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in pts {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let scale = len3(sub3(hi, lo)).max(1e-9);
    // Points this close to a face's plane count as on it (cylinders and other finely
    // divided curves are full of nearly coplanar points).
    let eps = scale * 1e-5;
    // Initial tetrahedron.
    let i0 = (0..n).min_by(|&a, &b| pts[a][0].total_cmp(&pts[b][0])).unwrap();
    let i1 = (0..n).max_by(|&a, &b| len3(sub3(pts[a], pts[i0])).total_cmp(&len3(sub3(pts[b], pts[i0])))).unwrap();
    let d01 = sub3(pts[i1], pts[i0]);
    let i2 = (0..n)
        .max_by(|&a, &b| {
            len3(cross3(d01, sub3(pts[a], pts[i0]))).total_cmp(&len3(cross3(d01, sub3(pts[b], pts[i0]))))
        })
        .unwrap();
    let nrm = cross3(d01, sub3(pts[i2], pts[i0]));
    if len3(nrm) < eps * scale {
        return Vec::new();
    }
    let i3 = (0..n)
        .max_by(|&a, &b| {
            dot3(nrm, sub3(pts[a], pts[i0])).abs().total_cmp(&dot3(nrm, sub3(pts[b], pts[i0])).abs())
        })
        .unwrap();
    if dot3(norm3(nrm), sub3(pts[i3], pts[i0])).abs() < scale * 1e-7 {
        return Vec::new();
    }
    struct F {
        v: [usize; 3],
        n: V3,
        d: f64,
        alive: bool,
    }
    let make = |v: [usize; 3]| -> F {
        let nn = norm3(cross3(sub3(pts[v[1]], pts[v[0]]), sub3(pts[v[2]], pts[v[0]])));
        F { v, n: nn, d: dot3(nn, pts[v[0]]), alive: true }
    };
    let inner = [
        (pts[i0][0] + pts[i1][0] + pts[i2][0] + pts[i3][0]) / 4.0,
        (pts[i0][1] + pts[i1][1] + pts[i2][1] + pts[i3][1]) / 4.0,
        (pts[i0][2] + pts[i1][2] + pts[i2][2] + pts[i3][2]) / 4.0,
    ];
    let mut faces: Vec<F> = Vec::new();
    let mut edges: HashMap<(usize, usize), usize> = HashMap::new();
    let add_face = |faces: &mut Vec<F>, edges: &mut HashMap<(usize, usize), usize>, v: [usize; 3]| {
        let mut f = make(v);
        if dot3(f.n, inner) - f.d > 0.0 {
            f = make([v[0], v[2], v[1]]);
        }
        let id = faces.len();
        let vv = f.v;
        for k in 0..3 {
            edges.insert((vv[k], vv[(k + 1) % 3]), id);
        }
        faces.push(f);
    };
    for v in [[i0, i1, i2], [i0, i1, i3], [i0, i2, i3], [i1, i2, i3]] {
        add_face(&mut faces, &mut edges, v);
    }
    // Deterministic shuffle so sorted input doesn't degrade.
    let mut order: Vec<usize> = (0..n).collect();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    for i in (1..n).rev() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        order.swap(i, (seed % (i as u64 + 1)) as usize);
    }
    let mut alive: Vec<usize> = (0..faces.len()).collect();
    let mut stamp: Vec<usize> = vec![usize::MAX; faces.len()];
    for (step, &pi) in order.iter().enumerate() {
        if [i0, i1, i2, i3].contains(&pi) {
            continue;
        }
        let p = pts[pi];
        let visible: Vec<usize> = alive
            .iter()
            .copied()
            .filter(|&f| dot3(faces[f].n, p) - faces[f].d > eps)
            .collect();
        if visible.is_empty() {
            continue;
        }
        for &f in &visible {
            stamp[f] = step;
        }
        let mut horizon: Vec<(usize, usize)> = Vec::new();
        for &f in &visible {
            let v = faces[f].v;
            for k in 0..3 {
                let (a, b) = (v[k], v[(k + 1) % 3]);
                let other_visible = edges.get(&(b, a)).map(|&o| stamp[o] == step).unwrap_or(false);
                if !other_visible {
                    horizon.push((a, b));
                }
            }
        }
        for &f in &visible {
            faces[f].alive = false;
            let v = faces[f].v;
            for k in 0..3 {
                let key = (v[k], v[(k + 1) % 3]);
                if edges.get(&key) == Some(&f) {
                    edges.remove(&key);
                }
            }
        }
        alive.retain(|&f| faces[f].alive);
        for (a, b) in horizon {
            let id = faces.len();
            let f = make([a, b, pi]);
            for (x, y) in [(a, b), (b, pi), (pi, a)] {
                edges.insert((x, y), id);
            }
            faces.push(f);
            stamp.push(usize::MAX);
            alive.push(id);
        }
        // A valid hull of k points has at most 2k - 4 faces; far more means the arithmetic
        // went wrong. Stop rather than grow without bound.
        if alive.len() > 2 * n + 64 {
            return Vec::new();
        }
    }
    faces.into_iter().filter(|f| f.alive).map(|f| f.v.map(|i| back[i])).collect()
}

struct Group {
    n: V3,
    d: f64,
    area: f64,
    tris: Vec<[V3; 3]>,
}

fn group_planes(tris: impl Iterator<Item = [V3; 3]>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for t in tris {
        let (n, a) = tri_normal_area(&t);
        if a <= 1e-9 {
            continue;
        }
        let d = dot3(n, t[0]);
        if let Some(g) = groups
            .iter_mut()
            .find(|g| dot3(g.n, n) > 0.9998 && (g.d - d).abs() < 0.05)
        {
            g.area += a;
            g.tris.push(t);
        } else {
            groups.push(Group { n, d, area: a, tris: vec![t] });
        }
    }
    groups
}

fn point_in_triangle_2d(p: V2, a: V2, b: V2, c: V2) -> bool {
    let s = |p1: V2, p2: V2, p3: V2| (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    let d1 = s(p, a, b);
    let d2 = s(p, b, c);
    let d3 = s(p, c, a);
    let neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
    let pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
    !(neg && pos)
}

fn evaluate(group: &Group, mesh_tris: &[[V3; 3]], com: V3) -> FaceCandidate {
    let q = quat_between(group.n, [0.0, 0.0, -1.0]);
    let rot = |v: V3| quat_rotate(q, v);
    let mut zmin = f64::INFINITY;
    let mut zmax = f64::NEG_INFINITY;
    for t in mesh_tris {
        for v in t {
            let z = rot(*v)[2];
            zmin = zmin.min(z);
            zmax = zmax.max(z);
        }
    }
    let mut contact = 0.0;
    let mut overhang = 0.0;
    for t in mesh_tris {
        let (n, a) = tri_normal_area(t);
        let rn = rot(n);
        let r = [rot(t[0]), rot(t[1]), rot(t[2])];
        let low = r.iter().map(|v| v[2]).fold(f64::INFINITY, f64::min);
        let high = r.iter().map(|v| v[2]).fold(f64::NEG_INFINITY, f64::max);
        if rn[2] < -0.999 && high - zmin < 0.05 {
            contact += a;
        } else if rn[2] < -std::f64::consts::FRAC_1_SQRT_2 && low - zmin > 0.2 {
            overhang += a;
        }
    }
    let c = rot(com);
    let stable = group.tris.iter().any(|t| {
        let r = [rot(t[0]), rot(t[1]), rot(t[2])];
        point_in_triangle_2d([c[0], c[1]], [r[0][0], r[0][1]], [r[1][0], r[1][1]], [r[2][0], r[2][1]])
    });
    FaceCandidate {
        normal: group.n,
        area: group.area,
        contact_area: contact,
        stable,
        height: zmax - zmin,
        overhang_area: overhang,
        orientation: q,
        triangles: group.tris.clone(),
    }
}

/// Flat faces the part could be put down on, largest first. `min_area_mm2` drops slivers.
pub fn face_candidates(mesh: &TriangleMesh, mode: FaceMode, min_area_mm2: f64, max_count: usize) -> Vec<FaceCandidate> {
    let tris = mesh_triangles(mesh);
    if tris.is_empty() {
        return Vec::new();
    }
    let com = center_of_mass(&tris);
    let groups = match mode {
        FaceMode::ConvexHull => {
            let pts = mesh_points(mesh);
            let hull = convex_hull_3d(&pts);
            if hull.is_empty() {
                group_planes(tris.iter().copied())
            } else {
                group_planes(hull.iter().map(|f| [pts[f[0]], pts[f[1]], pts[f[2]]]))
            }
        }
        FaceMode::Triangle => group_planes(tris.iter().copied()),
    };
    let mut groups: Vec<Group> = groups.into_iter().filter(|g| g.area >= min_area_mm2).collect();
    groups.sort_by(|a, b| b.area.total_cmp(&a.area));
    groups.truncate(max_count.max(1));
    groups.iter().map(|g| evaluate(g, &tris, com)).collect()
}

/// Picks the best resting face: the largest contact area among stable faces, less the area
/// that would hang over air (a tube on its side touches more of the bed than on its rim, but
/// its inside would need support), within 10% of the best counts as a tie; then the lowest
/// height (within 1 mm), then the least overhang.
pub fn auto_orient(mesh: &TriangleMesh) -> Option<FaceCandidate> {
    let mut c = face_candidates(mesh, FaceMode::ConvexHull, 0.0, 400);
    if c.is_empty() {
        return None;
    }
    if c.iter().any(|f| f.stable) {
        c.retain(|f| f.stable);
    }
    let key = |f: &FaceCandidate| {
        let touch = if f.contact_area > 1e-6 { f.contact_area } else { f.area * 1e-3 };
        touch - f.overhang_area
    };
    let best = c.iter().map(key).fold(f64::NEG_INFINITY, f64::max);
    let slack = best.abs() * 0.1;
    c.retain(|f| key(f) >= best - slack - 1e-9);
    let min_h = c.iter().map(|f| f.height).fold(f64::INFINITY, f64::min);
    c.retain(|f| f.height <= min_h + 1.0);
    c.sort_by(|a, b| a.overhang_area.total_cmp(&b.overhang_area).then(key(b).total_cmp(&key(a))));
    c.into_iter().next()
}

// ---- whole-plate planning ---------------------------------------------------------------

/// One part's orientation, outline and spot, as planned for the plate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlannedPart {
    pub orientation: Quat,
    pub footprint: Footprint,
    pub placement: Placement,
}

impl PlannedPart {
    pub fn transform(&self) -> [f64; 12] {
        item_transform(self.footprint.origin, self.orientation, &self.placement)
    }
}

/// Arranges meshes as saved (or turned by `orientations`, index-aligned) and checks the
/// result. Used by one-click Print! and the fit summary.
pub fn auto_layout(
    meshes: &[&TriangleMesh],
    orientations: &[Quat],
    bed: &BedSize,
    s: &ArrangeSettings,
) -> (Vec<PlannedPart>, PlateCheck) {
    auto_layout_with_reach(meshes, orientations, &[], bed, s)
}

/// `auto_layout` where each part (index-aligned with `meshes`) may have its own reach on a
/// printer with print areas; a missing entry or None is the whole bed.
pub fn auto_layout_with_reach(
    meshes: &[&TriangleMesh],
    orientations: &[Quat],
    reaches: &[Option<Reach>],
    bed: &BedSize,
    s: &ArrangeSettings,
) -> (Vec<PlannedPart>, PlateCheck) {
    let q_of = |i: usize| orientations.get(i).copied().map(quat_normalize).unwrap_or(IDENTITY);
    let feet: Vec<Footprint> = meshes.iter().enumerate().map(|(i, m)| footprint(m, q_of(i))).collect();
    let items: Vec<ArrangeItem> = feet
        .iter()
        .enumerate()
        .map(|(i, f)| ArrangeItem { reach: reaches.get(i).cloned().flatten(), ..ArrangeItem::from_footprint(f) })
        .collect();
    let placements = arrange(&items, bed, s);
    let c = check(&items, &placements, bed, s);
    let parts = feet
        .into_iter()
        .zip(placements)
        .enumerate()
        .map(|(i, (footprint, placement))| PlannedPart { orientation: q_of(i), footprint, placement })
        .collect();
    (parts, c)
}

/// Item indices per plate, in print order (by object) or input order (by layer).
pub fn plate_groups(parts: &[PlannedPart], c: &PlateCheck) -> Vec<Vec<usize>> {
    let plates = parts.iter().map(|p| p.placement.plate + 1).max().unwrap_or(0);
    (0..plates)
        .map(|pl| {
            if let Some(order) = c.order.get(pl).filter(|o| !o.is_empty()) {
                order.clone()
            } else {
                (0..parts.len()).filter(|&i| parts[i].placement.plate == pl).collect()
            }
        })
        .filter(|g: &Vec<usize>| !g.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An open tube (a pen-cup sleeve): `seg` sides, radius `r`, wall `t`, height `h`.
    fn tube(seg: usize, r: f32, t: f32, h: f32) -> TriangleMesh {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        let ring = |rad: f32, z: f32, positions: &mut Vec<[f32; 3]>| {
            let base = positions.len() as u32;
            for k in 0..seg {
                let a = k as f32 / seg as f32 * std::f32::consts::TAU;
                positions.push([rad * a.cos(), rad * a.sin(), z]);
            }
            base
        };
        let ob = ring(r, 0.0, &mut positions);
        let ot = ring(r, h, &mut positions);
        let ib = ring(r - t, 0.0, &mut positions);
        let it = ring(r - t, h, &mut positions);
        let s = seg as u32;
        for k in 0..s {
            let n = (k + 1) % s;
            indices.push([ob + k, ob + n, ot + n]);
            indices.push([ob + k, ot + n, ot + k]);
            indices.push([ib + k, it + n, ib + n]);
            indices.push([ib + k, it + k, it + n]);
            indices.push([ob + k, ib + n, ob + n]);
            indices.push([ob + k, ib + k, ib + n]);
            indices.push([ot + k, ot + n, it + n]);
            indices.push([ot + k, it + n, it + k]);
        }
        TriangleMesh { name: "tube".into(), positions, indices }
    }

    #[test]
    fn hull_of_a_finely_divided_cylinder_is_closed_and_small() {
        // Every corner listed once per triangle, like a model file, and 160 sides.
        let m = tube(160, 40.0, 2.0, 90.0);
        let pts: Vec<V3> = m
            .indices
            .iter()
            .flat_map(|t| t.iter().map(|&i| m.positions[i as usize]))
            .map(|v| [v[0] as f64, v[1] as f64, v[2] as f64])
            .collect();
        let hull = convex_hull_3d(&pts);
        assert!(!hull.is_empty());
        // Closed: every edge is shared with exactly one face going the other way.
        let mut edges = std::collections::HashMap::new();
        for f in &hull {
            for k in 0..3 {
                let a = pts[f[k]].map(|v| (v * 1e4).round() as i64);
                let b = pts[f[(k + 1) % 3]].map(|v| (v * 1e4).round() as i64);
                *edges.entry((a, b)).or_insert(0) += 1;
            }
        }
        for (&(a, b), &n) in &edges {
            assert_eq!(n, 1, "edge used twice");
            assert_eq!(edges.get(&(b, a)), Some(&1), "open edge");
        }
        // A closed triangulated hull of k corners has 2k - 4 faces; 640 distinct points here
        // (corners on the flat ends may be used too).
        assert!(hull.len() >= 2 * 320 - 4 && hull.len() <= 2 * 640 - 4, "{} faces", hull.len());
    }

    #[test]
    fn open_tube_stays_upright() {
        let m = tube(10, 35.0, 2.0, 100.0);
        let c = auto_orient(&m).unwrap();
        let down = quat_rotate(c.orientation, [0.0, 0.0, -1.0]);
        // Standing on either rim (the tube is the same both ways up), never on its side.
        assert!(down[2].abs() > 0.999, "tilted: {:?}", c.orientation);
    }

    #[test]
    fn round_parts_stay_on_the_bed_despite_outline_simplification() {
        // A finely divided disc (like a coaster) loses corners when simplified; the real
        // outline must still be on the bed after arranging.
        let disc: Vec<V2> = (0..96)
            .map(|k| {
                let a = k as f64 / 96.0 * std::f64::consts::TAU;
                [53.2 * a.cos(), 53.2 * a.sin()]
            })
            .collect();
        let items: Vec<ArrangeItem> = (0..6)
            .map(|_| ArrangeItem { hull: disc.clone(), height: 5.0, rot_deg: 0.0, pinned: None, reach: None })
            .collect();
        let bed = BedSize { width_mm: 256.0, depth_mm: 256.0, height_mm: None };
        let s = ArrangeSettings::default();
        let p = arrange(&items, &bed, &s);
        let c = check(&items, &p, &bed, &s);
        assert!(c.off_plate.is_empty(), "{c:?}");
        assert!(c.collisions.is_empty());
    }

    fn rect(w: f64, d: f64) -> Vec<V2> {
        vec![[-w / 2.0, -d / 2.0], [w / 2.0, -d / 2.0], [w / 2.0, d / 2.0], [-w / 2.0, d / 2.0]]
    }
    fn item(w: f64, d: f64) -> ArrangeItem {
        ArrangeItem { hull: rect(w, d), height: 10.0, rot_deg: 0.0, pinned: None, reach: None }
    }
    fn bed(w: f64, d: f64) -> BedSize {
        BedSize { width_mm: w, depth_mm: d, height_mm: None }
    }
    fn layer(spacing: f64) -> ArrangeSettings {
        ArrangeSettings { spacing_mm: spacing, auto_rotate: false, ..Default::default() }
    }

    /// Closed axis-aligned box mesh.
    pub(crate) fn box_mesh(w: f32, d: f32, h: f32) -> TriangleMesh {
        let p = vec![
            [0.0, 0.0, 0.0], [w, 0.0, 0.0], [w, d, 0.0], [0.0, d, 0.0],
            [0.0, 0.0, h], [w, 0.0, h], [w, d, h], [0.0, d, h],
        ];
        let i = vec![
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
            [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ];
        TriangleMesh { name: "box".into(), positions: p, indices: i }
    }

    // ---- print areas ----------------------------------------------------------------------
    // Test data only, not any printer's real numbers: a 325 x 320 mm bed where the left
    // nozzle reaches 325 x 320 x 320 from x = 0, the right nozzle 305 x 320 x 325 from
    // x = 20, and an explicit "Both" area of 300 x 320 x 320 from x = 20 (so x 20..320).

    fn dual_areas() -> Vec<PrintAreaSpec> {
        let a = |name: &str, x: f64, w: f64, h: f64| PrintAreaSpec {
            name: name.into(),
            x_mm: x,
            y_mm: 0.0,
            width_mm: w,
            depth_mm: 320.0,
            height_mm: Some(h),
            nozzle: None,
        };
        vec![a("Left nozzle", 0.0, 325.0, 320.0), a("Right nozzle", 20.0, 305.0, 325.0), a("Both", 20.0, 300.0, 320.0)]
    }
    fn dual_bed() -> BedSize {
        BedSize { width_mm: 325.0, depth_mm: 320.0, height_mm: Some(325.0) }
    }
    fn side(n: &str) -> Vec<Option<String>> {
        vec![Some(n.to_string())]
    }
    fn in_rect(b: [f64; 4], r: [f64; 4]) -> bool {
        b[0] >= r[0] - 1e-6 && b[1] >= r[1] - 1e-6 && b[2] <= r[2] + 1e-6 && b[3] <= r[3] + 1e-6
    }

    #[test]
    fn each_nozzle_reaches_its_own_area_and_shared_parts_the_overlap() {
        let areas = dual_areas();
        let l = reach_for_nozzles(&areas, &side("left")).unwrap();
        assert_eq!((l.rect, l.height_mm, l.label.as_str()), ([0.0, 0.0, 325.0, 320.0], Some(320.0), "Left nozzle"));
        let r = reach_for_nozzles(&areas, &side("Right")).unwrap();
        assert_eq!((r.rect, r.height_mm, r.label.as_str()), ([20.0, 0.0, 325.0, 320.0], Some(325.0), "Right nozzle"));
        let both = reach_for_nozzles(&areas, &[Some("left".into()), Some("right".into())]).unwrap();
        assert_eq!((both.rect, both.height_mm, both.label.as_str()), ([20.0, 0.0, 320.0, 320.0], Some(320.0), "Both nozzles"));
        // Unknown nozzle (a feeder with no nozzle set, or a filament not loaded): shared.
        assert_eq!(reach_for_nozzles(&areas, &[None]).unwrap(), both);
        assert_eq!(reach_for_nozzles(&areas, &[]).unwrap(), both); // nothing known: shared
        // An explicit nozzle field wins over the name.
        let mut named = areas.clone();
        named[0].name = "A".into();
        named[0].nozzle = Some("left".into());
        assert_eq!(reach_for_nozzles(&named, &side("left")).unwrap().rect, [0.0, 0.0, 325.0, 320.0]);
        assert_eq!(reach_for_area_name(&areas, "right nozzle").unwrap().rect, [20.0, 0.0, 325.0, 320.0]);
        assert_eq!(reach_for_area_name(&areas, "shared").unwrap().rect, [20.0, 0.0, 320.0, 320.0]);
    }

    #[test]
    fn printers_without_areas_arrange_exactly_as_before() {
        assert_eq!(reach_for_nozzles(&[], &side("left")), None);
        assert_eq!(reach_for_nozzles(&[], &[None]), None);
        let meshes: Vec<TriangleMesh> = (0..7).map(|i| box_mesh(20.0 + i as f32 * 7.0, 30.0, 10.0 + i as f32)).collect();
        let refs: Vec<&TriangleMesh> = meshes.iter().collect();
        let b = bed(180.0, 180.0);
        let s = ArrangeSettings::default();
        let (a, ca) = auto_layout(&refs, &[], &b, &s);
        let (b2, cb) = auto_layout_with_reach(&refs, &[], &vec![None; 7], &b, &s);
        assert_eq!(a, b2);
        assert_eq!(ca, cb);
        assert!(cb.out_of_area.is_empty());
    }

    #[test]
    fn mixed_plate_packs_one_nozzle_parts_outside_the_shared_strip() {
        let areas = dual_areas();
        let bed = dual_bed();
        let both = reach_for_nozzles(&areas, &[None]);
        let left = reach_for_nozzles(&areas, &side("left"));
        let mut items: Vec<ArrangeItem> = Vec::new();
        // Two big two-color parts fill the shared strip...
        for _ in 0..2 {
            items.push(ArrangeItem { reach: both.clone(), ..item(145.0, 300.0) });
        }
        // ...and three thin left-nozzle parts can only go in the left-only strip.
        for _ in 0..3 {
            items.push(ArrangeItem { reach: left.clone(), ..item(12.0, 80.0) });
        }
        let s = layer(5.0);
        let p = arrange(&items, &bed, &s);
        let c = check(&items, &p, &bed, &s);
        assert!(c.fits(), "{c:?} {p:?}");
        assert_eq!(c.plates, 1, "{p:?}");
        for (i, it) in items.iter().enumerate() {
            let b = bbox_2d(&placed_outline(it, &p[i]));
            assert!(in_rect(b, it.allowed_rect(&bed)), "{i} {b:?}");
            if i >= 2 {
                assert!(b[2] <= 20.0 + 1e-6, "left part {i} in the shared strip: {b:?}");
            }
        }
    }

    #[test]
    fn shared_parts_overflow_to_more_plates() {
        let areas = dual_areas();
        let both = reach_for_nozzles(&areas, &[None]);
        let items: Vec<ArrangeItem> =
            (0..4).map(|_| ArrangeItem { reach: both.clone(), ..item(145.0, 300.0) }).collect();
        let s = layer(5.0);
        let p = arrange(&items, &dual_bed(), &s);
        let c = check(&items, &p, &dual_bed(), &s);
        assert!(c.fits(), "{c:?}");
        assert_eq!(c.plates, 2);
        // Without areas the same parts need only... still two (the bed is 325 wide), but
        // a part as wide as the left area fits only where the left nozzle reaches.
        let wide = vec![ArrangeItem { reach: both.clone(), ..item(310.0, 50.0) }];
        let c = check(&wide, &arrange(&wide, &dual_bed(), &s), &dual_bed(), &s);
        assert!(!c.fits(), "310 mm can't fit the 300 mm shared strip: {c:?}");
        let wide = vec![ArrangeItem { reach: reach_for_nozzles(&areas, &side("left")), ..item(310.0, 50.0) }];
        let c = check(&wide, &arrange(&wide, &dual_bed(), &s), &dual_bed(), &s);
        assert!(c.fits(), "{c:?}");
    }

    #[test]
    fn height_limit_follows_the_area() {
        let areas = dual_areas();
        let s = layer(5.0);
        let tall = |n: &str| ArrangeItem { height: 322.0, reach: reach_for_nozzles(&areas, &side(n)), ..item(40.0, 40.0) };
        let items = vec![tall("right"), tall("left")];
        let c = check(&items, &arrange(&items, &dual_bed(), &s), &dual_bed(), &s);
        assert_eq!(c.too_tall, vec![1], "{c:?}");
    }

    #[test]
    fn a_part_moved_where_its_nozzle_cannot_reach_is_out_of_area() {
        let areas = dual_areas();
        let s = layer(5.0);
        let items = vec![
            ArrangeItem { reach: reach_for_nozzles(&areas, &side("right")), ..item(10.0, 10.0) },
            ArrangeItem { reach: reach_for_nozzles(&areas, &side("left")), ..item(4.0, 10.0) },
        ];
        let p = vec![
            Placement { plate: 0, x: 10.0, y: 100.0, rot_deg: 0.0 }, // x 5..15: left-only strip
            Placement { plate: 0, x: 322.5, y: 100.0, rot_deg: 0.0 }, // x 320.5..324.5: left reaches it
        ];
        let c = check(&items, &p, &dual_bed(), &s);
        assert_eq!(c.out_of_area, vec![0]);
        assert!(c.off_plate.is_empty());
        assert!(!c.fits());
    }

    // ---- extruder clearance (by object) ----------------------------------------------------

    fn by_object(dist: Option<f64>, lid: Option<f64>) -> ArrangeSettings {
        ArrangeSettings {
            sequence: Sequence::ByObject,
            auto_rotate: false,
            clearance_radius_mm: 20.0,
            clearance_height_mm: 30.0,
            clearance_dist_to_rod_mm: dist,
            clearance_height_to_lid_mm: lid,
            ..Default::default()
        }
    }

    #[test]
    fn old_plate_settings_still_load() {
        let s: ArrangeSettings = serde_json::from_str(r#"{"spacing_mm":4,"sequence":"by_object","clearance_radius_mm":40,"clearance_height_mm":25}"#).unwrap();
        assert_eq!((s.clearance_radius_mm, s.clearance_height_mm), (40.0, 25.0));
        assert_eq!((s.clearance_dist_to_rod_mm, s.clearance_height_to_lid_mm), (None, None));
        assert_eq!(s.dist_to_rod(), None, "no distance to rod set: no front-to-back check");
        let s: ArrangeSettings = serde_json::from_str(r#"{"clearance_height_to_rod_mm":22}"#).unwrap();
        assert_eq!(s.clearance_height_mm, 22.0);
    }

    #[test]
    fn tall_parts_keep_the_distance_to_rod_front_to_back() {
        let tall = || ArrangeItem { height: 60.0, ..item(30.0, 30.0) };
        let items = vec![tall(), tall(), item(30.0, 30.0)];
        let s = by_object(Some(70.0), None);
        let bed = bed(250.0, 250.0);
        let p = arrange(&items, &bed, &s);
        let c = check(&items, &p, &bed, &s);
        assert!(c.fits(), "{c:?} {p:?}");
        assert_eq!(c.plates, 1);
        let (a, b) = (bbox_2d(&placed_outline(&items[0], &p[0])), bbox_2d(&placed_outline(&items[1], &p[1])));
        let gap = (b[1] - a[3]).max(a[1] - b[3]);
        assert!(gap >= 70.0 - 1e-6, "gap {gap}");
        // Side by side (same Y) is a conflict even when far apart in X.
        let side = vec![
            Placement { plate: 0, x: 40.0, y: 100.0, rot_deg: 0.0 },
            Placement { plate: 0, x: 200.0, y: 100.0, rot_deg: 0.0 },
            Placement { plate: 0, x: 120.0, y: 220.0, rot_deg: 0.0 },
        ];
        let c = check(&items, &side, &bed, &s);
        assert_eq!(c.rod_conflicts, vec![[0, 1]]);
        assert!(!c.fits());
        // A short part next to a tall one is fine (it prints first).
        assert!(!c.rod_conflicts.iter().flatten().any(|&i| i == 2));
        // When the bed is too shallow for the distance, the second tall part overflows.
        let shallow = BedSize { width_mm: 250.0, depth_mm: 120.0, height_mm: None };
        let p = arrange(&items[..2], &shallow, &s);
        assert_eq!(check(&items[..2], &p, &shallow, &s).plates, 2);
        // By layer ignores it, and so does a printer with no distance to rod set.
        let c = check(&items, &side, &bed, &layer(5.0));
        assert!(c.rod_conflicts.is_empty());
        let c = check(&items, &side, &bed, &by_object(None, None));
        assert!(c.rod_conflicts.is_empty());
    }

    #[test]
    fn only_the_last_part_may_go_above_the_lid() {
        let high = || ArrangeItem { height: 120.0, ..item(20.0, 20.0) };
        let items = vec![high(), high(), item(20.0, 20.0)];
        let s = by_object(Some(0.0), Some(100.0));
        let bed = BedSize { width_mm: 250.0, depth_mm: 250.0, height_mm: Some(250.0) };
        let p = arrange(&items, &bed, &s);
        let c = check(&items, &p, &bed, &s);
        assert!(c.fits(), "{c:?}");
        assert_ne!(p[0].plate, p[1].plate, "one part above the lid per plate");
        // The one above the lid prints last on its plate.
        let pl = p[0].plate;
        assert_eq!(*c.order[pl].last().unwrap(), 0, "{:?}", c.order);
        // Both on one plate: flagged.
        let same = vec![
            Placement { plate: 0, x: 40.0, y: 40.0, rot_deg: 0.0 },
            Placement { plate: 0, x: 200.0, y: 200.0, rot_deg: 0.0 },
            Placement { plate: 0, x: 120.0, y: 120.0, rot_deg: 0.0 },
        ];
        let c = check(&items, &same, &bed, &s);
        assert_eq!(c.over_lid, vec![0, 1]);
        assert!(!c.fits());
        // No lid set: no limit.
        assert!(check(&items, &same, &bed, &by_object(Some(0.0), None)).over_lid.is_empty());
    }

    #[test]
    fn hull_2d_of_square_with_inner_points() {
        let pts = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [5.0, 5.0], [2.0, 7.0], [10.0, 5.0]];
        let h = convex_hull_2d(&pts);
        assert_eq!(h.len(), 4);
        assert!((polygon_area(&h) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn distance_between_convex_polygons() {
        let a = transform_2d(&rect(10.0, 10.0), 0.0, 0.0, 0.0);
        let b = transform_2d(&rect(10.0, 10.0), 0.0, 17.0, 0.0);
        assert!((convex_distance(&a, &b) - 7.0).abs() < 1e-9);
        let c = transform_2d(&rect(10.0, 10.0), 0.0, 8.0, 3.0);
        assert_eq!(convex_distance(&a, &c), 0.0);
    }

    #[test]
    fn arrange_keeps_spacing_and_stays_on_the_bed() {
        let items: Vec<ArrangeItem> = (0..9).map(|_| item(50.0, 50.0)).collect();
        let b = bed(256.0, 256.0);
        let s = layer(5.0);
        let p = arrange(&items, &b, &s);
        let c = check(&items, &p, &b, &s);
        assert_eq!(c.plates, 1);
        assert!(c.fits(), "{c:?}");
        for i in 0..items.len() {
            for j in i + 1..items.len() {
                let d = convex_distance(&placed_outline(&items[i], &p[i]), &placed_outline(&items[j], &p[j]));
                assert!(d >= 5.0 - 1e-6, "{i} {j} {d}");
            }
        }
    }

    #[test]
    fn arrange_packs_squares_close_to_the_best_grid() {
        // 16 squares of 55 mm with 5 mm spacing fit 4x4 in 235 mm: a 240 mm bed must take them.
        let items: Vec<ArrangeItem> = (0..16).map(|_| item(55.0, 55.0)).collect();
        let b = bed(240.0, 240.0);
        let p = arrange(&items, &b, &layer(5.0));
        assert!(p.iter().all(|q| q.plate == 0), "{p:?}");
    }

    #[test]
    fn overflow_goes_to_plate_two_at_the_exact_count() {
        // 4 per plate on a 110 mm bed (2x2 of 50 mm with 5 mm spacing).
        let items: Vec<ArrangeItem> = (0..5).map(|_| item(50.0, 50.0)).collect();
        let b = bed(110.0, 110.0);
        let p = arrange(&items, &b, &layer(5.0));
        assert_eq!(p.iter().filter(|q| q.plate == 0).count(), 4);
        assert_eq!(p.iter().filter(|q| q.plate == 1).count(), 1);
        let c = check(&items, &p, &b, &layer(5.0));
        assert_eq!(c.plates, 2);
        assert!(c.fits(), "{c:?}");
    }

    #[test]
    fn part_bigger_than_the_bed_stays_on_plate_one_and_is_flagged() {
        let items = vec![item(300.0, 40.0), item(20.0, 20.0)];
        let b = bed(200.0, 200.0);
        let s = ArrangeSettings::default();
        let p = arrange(&items, &b, &s);
        assert_eq!(p[0].plate, 0);
        let c = check(&items, &p, &b, &s);
        assert_eq!(c.off_plate, vec![0]);
    }

    #[test]
    fn auto_rotate_fits_a_long_part_diagonally_or_turned() {
        let items = vec![item(30.0, 150.0)];
        let b = bed(160.0, 100.0);
        let p = arrange(&items, &b, &ArrangeSettings::default());
        let c = check(&items, &p, &b, &ArrangeSettings::default());
        assert!(c.fits(), "{p:?} {c:?}");
        // Without rotation it can't fit.
        let p2 = arrange(&items, &b, &layer(5.0));
        assert!(!check(&items, &p2, &b, &layer(5.0)).fits());
    }

    #[test]
    fn align_to_y_puts_the_long_side_along_y() {
        let items = vec![item(120.0, 20.0)];
        let s = ArrangeSettings { align_y: true, ..Default::default() };
        let p = arrange(&items, &bed(256.0, 256.0), &s);
        let b = bbox_2d(&placed_outline(&items[0], &p[0]));
        assert!(b[3] - b[1] > b[2] - b[0], "{b:?}");
    }

    #[test]
    fn by_object_spreads_parts_by_the_clearance_radius() {
        let items: Vec<ArrangeItem> = (0..4).map(|_| item(30.0, 30.0)).collect();
        let s = ArrangeSettings { sequence: Sequence::ByObject, clearance_radius_mm: 35.0, auto_rotate: false, ..Default::default() };
        let b = bed(256.0, 256.0);
        let p = arrange(&items, &b, &s);
        let c = check(&items, &p, &b, &s);
        assert!(c.clearance_overlaps.is_empty(), "{c:?}");
        assert_eq!(c.order.len(), 1);
        assert_eq!(c.order[0].len(), 4);
    }

    #[test]
    fn overlap_and_clearance_are_detected() {
        let items = vec![item(40.0, 40.0), item(40.0, 40.0), item(40.0, 40.0)];
        let pl = vec![
            Placement { plate: 0, x: 50.0, y: 50.0, rot_deg: 0.0 },
            Placement { plate: 0, x: 80.0, y: 50.0, rot_deg: 0.0 }, // overlaps the first
            Placement { plate: 0, x: 150.0, y: 50.0, rot_deg: 0.0 }, // 30 mm from the second
        ];
        let s = ArrangeSettings { sequence: Sequence::ByObject, clearance_radius_mm: 35.0, ..Default::default() };
        let c = check(&items, &pl, &bed(256.0, 256.0), &s);
        assert_eq!(c.collisions, vec![[0, 1]]);
        assert!(c.clearance_overlaps.contains(&[1, 2]));
        // Touching edges are not a collision.
        let touch = vec![
            Placement { plate: 0, x: 50.0, y: 50.0, rot_deg: 0.0 },
            Placement { plate: 0, x: 90.0, y: 50.0, rot_deg: 0.0 },
        ];
        let c2 = check(&items[..2], &touch, &bed(256.0, 256.0), &ArrangeSettings::default());
        assert!(c2.collisions.is_empty());
    }

    #[test]
    fn too_tall_uses_the_build_height_only_when_set() {
        let items = vec![ArrangeItem { height: 200.0, ..item(20.0, 20.0) }];
        let p = vec![Placement { plate: 0, x: 50.0, y: 50.0, rot_deg: 0.0 }];
        let s = ArrangeSettings::default();
        assert!(check(&items, &p, &bed(100.0, 100.0), &s).too_tall.is_empty());
        let tall = BedSize { height_mm: Some(150.0), ..bed(100.0, 100.0) };
        assert_eq!(check(&items, &p, &tall, &s).too_tall, vec![0]);
    }

    #[test]
    fn by_object_prints_the_tall_part_last() {
        let mut items: Vec<ArrangeItem> = (0..3).map(|_| item(20.0, 20.0)).collect();
        items[0].height = 80.0;
        let s = ArrangeSettings { sequence: Sequence::ByObject, ..Default::default() };
        let p = arrange(&items, &bed(256.0, 256.0), &s);
        let c = check(&items, &p, &bed(256.0, 256.0), &s);
        assert_eq!(*c.order[0].last().unwrap(), 0);
        assert_eq!(c.taller_than_gantry, vec![0]);
    }

    #[test]
    fn pinned_parts_stay_and_others_avoid_them() {
        let mut items: Vec<ArrangeItem> = (0..3).map(|_| item(40.0, 40.0)).collect();
        let pin = Placement { plate: 0, x: 100.0, y: 100.0, rot_deg: 0.0 };
        items[1].pinned = Some(pin);
        let b = bed(200.0, 200.0);
        let p = arrange(&items, &b, &layer(5.0));
        assert_eq!(p[1], pin);
        assert!(check(&items, &p, &b, &layer(5.0)).fits());
    }

    #[test]
    fn hull_3d_of_a_box_has_twelve_triangles() {
        let m = box_mesh(10.0, 20.0, 30.0);
        let pts = mesh_points(&m);
        let mut more = pts.clone();
        more.push([5.0, 10.0, 15.0]); // inside
        let h = convex_hull_3d(&more);
        assert_eq!(h.len(), 12);
    }

    #[test]
    fn lay_flat_puts_a_standing_plate_on_its_largest_face() {
        // A 100 x 4 x 60 plate standing on its thin edge.
        let m = box_mesh(100.0, 4.0, 60.0);
        let best = auto_orient(&m).unwrap();
        assert!((best.height - 4.0).abs() < 1e-6, "{}", best.height);
        let f = footprint(&m, best.orientation);
        assert!((f.height - 4.0).abs() < 1e-4);
        assert!((f.area - 6000.0).abs() < 1.0, "{}", f.area);
    }

    #[test]
    fn face_candidates_in_both_modes() {
        let m = box_mesh(10.0, 20.0, 30.0);
        let hull = face_candidates(&m, FaceMode::ConvexHull, 0.0, 50);
        assert_eq!(hull.len(), 6);
        assert!(hull.iter().all(|f| f.stable));
        assert!((hull[0].area - 600.0).abs() < 1e-6);
        let tri = face_candidates(&m, FaceMode::Triangle, 250.0, 50);
        assert_eq!(tri.len(), 4); // 20x30 and 10x30 faces, not the 10x20 ends
        // Putting a candidate down makes its normal point at the bed.
        for c in &hull {
            let n = quat_rotate(c.orientation, c.normal);
            assert!((n[2] + 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn auto_orient_prefers_the_solid_bottom_of_a_cup() {
        // An open-top cup: base 40x40, 30 tall. The hull top (the rim's square) is the
        // same size as the bottom, but only the bottom is solid, so contact area picks it.
        let mut positions: Vec<[f32; 3]> = Vec::new();
        let mut indices: Vec<[u32; 3]> = Vec::new();
        let mut quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| {
            let i = positions.len() as u32;
            positions.extend([a, b, c, d]);
            indices.push([i, i + 1, i + 2]);
            indices.push([i, i + 2, i + 3]);
        };
        let (w, h, t) = (40.0f32, 30.0f32, 2.0f32);
        quad([0., 0., 0.], [0., w, 0.], [w, w, 0.], [w, 0., 0.]); // bottom, facing down
        quad([0., 0., 0.], [w, 0., 0.], [w, 0., h], [0., 0., h]);
        quad([w, 0., 0.], [w, w, 0.], [w, w, h], [w, 0., h]);
        quad([w, w, 0.], [0., w, 0.], [0., w, h], [w, w, h]);
        quad([0., w, 0.], [0., 0., 0.], [0., 0., h], [0., w, h]);
        // rim ring on top (four thin strips)
        quad([0., 0., h], [w, 0., h], [w, t, h], [0., t, h]);
        quad([0., w - t, h], [w, w - t, h], [w, w, h], [0., w, h]);
        let m = TriangleMesh { name: "cup".into(), positions, indices };
        let best = auto_orient(&m).unwrap();
        let n = best.normal;
        assert!(n[2] < -0.99, "picked {n:?}");
    }

    #[test]
    fn transform_rotates_and_places_the_reference_point() {
        let m = box_mesh(40.0, 20.0, 10.0);
        let q = quat_between([0.0, -1.0, 0.0], [0.0, 0.0, -1.0]); // front face down
        let f = footprint(&m, q);
        let p = Placement { plate: 0, x: 100.0, y: 80.0, rot_deg: 90.0 };
        let t = item_transform(f.origin, q, &p);
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for v in &m.positions {
            let w = apply_transform(&t, [v[0] as f64, v[1] as f64, v[2] as f64]);
            for k in 0..3 {
                lo[k] = lo[k].min(w[k]);
                hi[k] = hi[k].max(w[k]);
            }
        }
        assert!(lo[2].abs() < 1e-6, "{lo:?}");
        assert!(((lo[0] + hi[0]) / 2.0 - 100.0).abs() < 1e-6);
        assert!(((lo[1] + hi[1]) / 2.0 - 80.0).abs() < 1e-6);
        // 40 wide, turned 90°, is 40 deep; height is the old depth (20).
        assert!((hi[1] - lo[1] - 40.0).abs() < 1e-6, "{lo:?} {hi:?}");
        assert!((hi[2] - lo[2] - 20.0).abs() < 1e-6);
        // The outline at that spot matches the transformed mesh.
        let item = ArrangeItem::from_footprint(&f);
        let b = bbox_2d(&placed_outline(&item, &p));
        assert!((b[0] - lo[0]).abs() < 1e-6 && (b[3] - hi[1]).abs() < 1e-6);
    }
}
