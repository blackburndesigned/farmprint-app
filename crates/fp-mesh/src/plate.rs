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
    /// Radius around the nozzle that must stay clear of finished parts (by object).
    pub clearance_radius_mm: f64,
    /// Nozzle tip to the lowest part of the gantry (by object).
    pub clearance_height_mm: f64,
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
}

impl ArrangeItem {
    pub fn from_footprint(f: &Footprint) -> Self {
        ArrangeItem {
            hull: f.hull.clone(),
            height: f.height,
            rot_deg: 0.0,
            pinned: None,
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

fn fits_on_empty_bed(hull: &[V2], rots: &[f64], bed: &BedSize) -> bool {
    rots.iter().any(|&r| {
        let b = bbox_2d(&transform_2d(hull, r, 0.0, 0.0));
        b[2] - b[0] <= bed.width_mm + 1e-6 && b[3] - b[1] <= bed.depth_mm + 1e-6
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
    bed: &BedSize,
    step: f64,
) -> Option<(Placement, Vec<V2>)> {
    let pile = union_bb(placed);
    let mut best: Option<(f64, Placement)> = None;
    for &r in rots {
        let h0 = transform_2d(hull, r, 0.0, 0.0);
        let b = bbox_2d(&h0);
        let (x0, x1) = (-b[0], bed.width_mm - b[2]);
        let (y0, y1) = (-b[1], bed.depth_mm - b[3]);
        if x1 < x0 - 1e-9 || y1 < y0 - 1e-9 {
            continue;
        }
        let (x1, y1) = (x1.max(x0), y1.max(y0));
        let nfps = nfps_for(&h0, placed);
        // Candidates: a grid over the bed, the bed corners, and every no-fit vertex (spots
        // touching a placed part at exactly the gap).
        let mut cands: Vec<V2> = vec![[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
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
            if free_at(&nfps, x, y) {
                best = Some((score, Placement { plate: 0, x, y, rot_deg: r }));
            }
        }
    }
    let (_, mut p) = best?;
    // Slide toward the front-left corner so gaps close to the spacing.
    let h0 = transform_2d(hull, p.rot_deg, 0.0, 0.0);
    let b = bbox_2d(&h0);
    let nfps = nfps_for(&h0, placed);
    let ok = |x: f64, y: f64| x + b[0] >= -1e-9 && y + b[1] >= -1e-9 && free_at(&nfps, x, y);
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
    order.sort_by(|&a, &b| {
        polygon_area(&items[b].hull)
            .total_cmp(&polygon_area(&items[a].hull))
            .then(items[b].height.total_cmp(&items[a].height))
            .then(a.cmp(&b))
    });
    let step = (bed.width_mm.min(bed.depth_mm) / 64.0).clamp(2.0, 8.0);
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); plates.len()];
    for idx in order {
        let it = &items[idx];
        let rots = rotations_for(it, s);
        if !fits_on_empty_bed(&it.hull, &rots, bed) {
            out[idx] = Some(Placement {
                plate: 0,
                x: bed.width_mm / 2.0,
                y: bed.depth_mm / 2.0,
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
            if let Some((pl, poly)) = best_spot(&simple, &rots, &plates[pi], bed, step) {
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
        let dx = bed.width_mm / 2.0 - (u[0] + u[2]) / 2.0;
        let dy = bed.depth_mm / 2.0 - (u[1] + u[3]) / 2.0;
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
    /// Items taller than the printer's build height (only when it is set).
    pub too_tall: Vec<usize>,
    /// By object: items taller than the gantry clearance (allowed once per plate, last).
    pub taller_than_gantry: Vec<usize>,
    /// By object: print order per plate, item indices.
    pub order: Vec<Vec<usize>>,
    /// Share of plate 1 covered by outlines, 0..1.
    pub plate1_fill: f64,
    pub tallest_mm: f64,
}

impl PlateCheck {
    /// True when every part is on a plate, nothing overlaps, and nothing is too tall.
    pub fn fits(&self) -> bool {
        self.off_plate.is_empty() && self.collisions.is_empty() && self.too_tall.is_empty()
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
        }
        if let Some(h) = bed.height_mm {
            if items[i].height > h + eps {
                c.too_tall.push(i);
            }
        }
        c.tallest_mm = c.tallest_mm.max(items[i].height);
        if s.sequence == Sequence::ByObject && items[i].height > s.clearance_height_mm + eps {
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
                ta.cmp(&tb)
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
pub fn convex_hull_3d(pts: &[V3]) -> Vec<[usize; 3]> {
    use std::collections::HashMap;
    let n = pts.len();
    if n < 4 {
        return Vec::new();
    }
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in pts {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let scale = len3(sub3(hi, lo)).max(1e-9);
    let eps = scale * 1e-9;
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
            .filter(|&f| dot3(faces[f].n, p) - faces[f].d > eps * 10.0)
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
    }
    faces.into_iter().filter(|f| f.alive).map(|f| f.v).collect()
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

/// Picks the best resting face: the largest contact area among stable faces (within 10% of
/// the best counts as a tie), then the lowest height (within 1 mm), then the least overhang.
pub fn auto_orient(mesh: &TriangleMesh) -> Option<FaceCandidate> {
    let mut c = face_candidates(mesh, FaceMode::ConvexHull, 0.0, 400);
    if c.is_empty() {
        return None;
    }
    if c.iter().any(|f| f.stable) {
        c.retain(|f| f.stable);
    }
    let key = |f: &FaceCandidate| if f.contact_area > 1e-6 { f.contact_area } else { f.area * 1e-3 };
    let best_area = c.iter().map(key).fold(0.0, f64::max);
    c.retain(|f| key(f) >= best_area * 0.9 - 1e-9);
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
    let q_of = |i: usize| orientations.get(i).copied().map(quat_normalize).unwrap_or(IDENTITY);
    let feet: Vec<Footprint> = meshes.iter().enumerate().map(|(i, m)| footprint(m, q_of(i))).collect();
    let items: Vec<ArrangeItem> = feet.iter().map(ArrangeItem::from_footprint).collect();
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

    fn rect(w: f64, d: f64) -> Vec<V2> {
        vec![[-w / 2.0, -d / 2.0], [w / 2.0, -d / 2.0], [w / 2.0, d / 2.0], [-w / 2.0, d / 2.0]]
    }
    fn item(w: f64, d: f64) -> ArrangeItem {
        ArrangeItem { hull: rect(w, d), height: 10.0, rot_deg: 0.0, pinned: None }
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
