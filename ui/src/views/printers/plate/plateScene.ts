// The plate view's 3D scene (three.js): bed, parts, outlines, by-object capsules and bed
// numbers, lay-on-face candidates, picking and the camera. React owns the data; this file
// only draws it and reports what the pointer hits.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BedSize, FaceCandidate, PlateMesh, PlatePart, Pose, V2 } from "./plateModel";
import { TWEEN_MS, blendPose, easeOutCubic, offsetOutline, placedOutline, poseOf } from "./plateModel";

const RED = new THREE.Color("#ff453a");
const WHITE = new THREE.Color("#ffffff");
const SEL_TINT = new THREE.Color("#0a84ff");

interface PartObj {
  outer: THREE.Group;
  mid: THREE.Group;
  mesh: THREE.Mesh;
  outline: THREE.Mesh;
  outlineMat: THREE.ShaderMaterial;
  mat: THREE.MeshStandardMaterial;
  pose: Pose;
  from: Pose;
  to: Pose;
  t0: number;
  meshKey: string;
}

export interface SceneLook {
  selected: Set<string>;
  problems: Set<string>;
  /** By object: grow each outline by half the clearance radius; capsules in `capRed` are red. */
  capsules: { radius: number; red: Set<string> } | null;
  /** By object: print order numbers painted on the bed. */
  numbers: Map<string, number> | null;
}

export class PlateScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private bedGroup = new THREE.Group();
  private overlay = new THREE.Group();
  private reachGroup = new THREE.Group();
  private reachKey = "";
  private parts = new Map<string, PartObj>();
  private geos = new Map<string, { geo: THREE.BufferGeometry }>();
  /** Outline thickness in mm, kept about 2 px on screen (updated every frame). */
  private outlineThick = { value: 0.6 };
  private faceMeshes: { mesh: THREE.Mesh; cand: FaceCandidate }[] = [];
  private faceOwner: string | null = null;
  private hoverFace: THREE.Mesh | null = null;
  private raf = 0;
  private bed: BedSize = { width_mm: 220, depth_mm: 220 };
  private camTween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
  private ray = new THREE.Raycaster();
  private numberTex = new Map<number, THREE.Texture>();
  onFrame: (() => void) | null = null;
  private key!: THREE.DirectionalLight;

  constructor(private readonly host: HTMLElement, opts?: { preserveDrawingBuffer?: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!opts?.preserveDrawingBuffer });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    // Left drag selects and moves parts; right drag turns the view; middle drag pans.
    this.controls.mouseButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    const hemi = new THREE.HemisphereLight(0xffffff, 0x6b6f78, 1.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(-0.6, -0.9, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(1, 0.6, 0.8);
    this.scene.add(fill);
    this.key = key;
    this.scene.add(this.bedGroup, this.overlay, this.reachGroup);
    this.resize();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    for (const g of this.geos.values()) g.geo.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** The bed; `shade` hatches where no print area reaches (`none`) and, more lightly, where
   *  only some nozzles reach (`partial`), with `edges` drawn as thin dashed lines. */
  setBed(bed: BedSize, plateLabel: string, shade?: BedShade) {
    this.bed = bed;
    for (const c of this.bedGroup.children) disposeObj(c);
    this.bedGroup.clear();
    this.reachKey = "";
    const { width_mm: w, depth_mm: d } = bed;
    const tex = gridTexture(w, d, shade);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(w, d, 2),
      [
        new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.72, metalness: 0.05 }),
        new THREE.MeshStandardMaterial({ color: 0x1c1d21 }),
      ]
    );
    top.position.set(w / 2, d / 2, -1);
    top.receiveShadow = true;
    this.bedGroup.add(top);
    const label = textPlane(plateLabel, 44, "#d8dbe0", "rgba(0,0,0,0)");
    label.scale.setScalar(Math.max(w, d) / 256);
    label.position.set(w / 2, -9 * (Math.max(w, d) / 256), 0.05);
    this.bedGroup.add(label);
    const s = Math.max(w, d);
    const sh = this.key.shadow.camera as THREE.OrthographicCamera;
    sh.left = -s * 0.8;
    sh.right = s * 0.8;
    sh.top = s * 0.8;
    sh.bottom = -s * 0.8;
    sh.near = 1;
    sh.far = s * 5;
    sh.updateProjectionMatrix();
    this.key.position.set(w / 2 - s * 0.6, d / 2 - s * 0.9, s * 1.6);
    this.key.target.position.set(w / 2, d / 2, 0);
  }

  /** Camera presets: an angled overview (default) or straight down, framing the whole bed. */
  viewPreset(kind: "iso" | "top", animate = true) {
    const { width_mm: w, depth_mm: d } = this.bed;
    const radius = Math.hypot(w, d) / 2;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fit = (radius * (kind === "iso" ? 0.86 : 0.9)) / Math.sin(Math.min(vfov, hfov) / 2);
    const target = new THREE.Vector3(w / 2, d / 2, 0);
    const dir = kind === "top" ? new THREE.Vector3(0, -0.0001, 1) : new THREE.Vector3(-0.22, -0.78, 0.82).normalize();
    this.moveCamera(target, target.clone().add(dir.multiplyScalar(fit)), animate);
  }

  /** Smoothly frames a point on the bed (Jump to). */
  focus(x: number, y: number, radius: number) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(120, radius * 4.2);
    const target = new THREE.Vector3(x, y, 0);
    this.moveCamera(target, target.clone().add(dir.multiplyScalar(dist)), true);
  }

  private moveCamera(target: THREE.Vector3, pos: THREE.Vector3, animate: boolean) {
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
      this.controls.update();
      return;
    }
    this.camTween = {
      from: [this.controls.target.clone(), this.camera.position.clone()],
      to: [target, pos],
      t0: performance.now(),
    };
  }

  private geoFor(key: string, m: PlateMesh) {
    let g = this.geos.get(key);
    if (!g) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
      geo.setIndex(outwardWinding(m.positions, m.indices));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      g = { geo };
      this.geos.set(key, g);
    }
    return g;
  }

  /**
   * Shows `parts` (those on `plate`), tweening any part whose pose changed. `instant`
   * skips the tween (dragging).
   */
  sync(parts: PlatePart[], meshes: Record<string, PlateMesh>, plate: number, look: SceneLook, instant: boolean) {
    const now = performance.now();
    const seen = new Set<string>();
    for (const p of parts) {
      seen.add(p.unit_id);
      let o = this.parts.get(p.unit_id);
      const target = poseOf(p);
      if (!o) {
        const m = meshes[p.mesh_key];
        if (!m) continue;
        const g = this.geoFor(p.mesh_key, m);
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.hex || "#9aa0a6"), roughness: 0.55, metalness: 0.04, flatShading: true });
        const mesh = new THREE.Mesh(g.geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.unitId = p.unit_id;
        // Selection / problem outline: the model drawn again from the back, pushed out along
        // its normals, so a clean silhouette shows around it in white or red.
        const outlineMat = new THREE.ShaderMaterial({
          uniforms: { uThick: this.outlineThick, uColor: { value: new THREE.Color(0xffffff) } },
          vertexShader:
            "uniform float uThick; void main(){ vec3 p = position + normalize(normal) * uThick; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }",
          fragmentShader: "uniform vec3 uColor; void main(){ gl_FragColor = vec4(uColor, 1.0); }",
          side: THREE.BackSide,
        });
        const outline = new THREE.Mesh(g.geo, outlineMat);
        outline.visible = false;
        mesh.add(outline);
        const mid = new THREE.Group();
        mid.add(mesh);
        const outer = new THREE.Group();
        outer.add(mid);
        this.scene.add(outer);
        o = { outer, mid, mesh, outline, outlineMat, mat, pose: target, from: target, to: target, t0: 0, meshKey: p.mesh_key };
        this.parts.set(p.unit_id, o);
      } else if (!samePose(o.to, target)) {
        if (instant) {
          o.pose = o.from = o.to = target;
          o.t0 = 0;
        } else {
          o.from = o.pose;
          o.to = target;
          o.t0 = now;
        }
      }
      o.mat.color.set(p.hex || "#9aa0a6");
      o.outer.visible = p.placement.plate === plate;
      const bad = look.problems.has(p.unit_id);
      const sel = look.selected.has(p.unit_id);
      o.mat.emissive.copy(bad ? RED : sel ? SEL_TINT : new THREE.Color(0x000000));
      o.mat.emissiveIntensity = bad ? 0.38 : sel ? 0.16 : 0;
      o.outline.visible = sel || bad;
      (o.outlineMat.uniforms.uColor.value as THREE.Color).copy(sel ? WHITE : RED);
      this.apply(o);
    }
    for (const [id, o] of this.parts) {
      if (!seen.has(id)) {
        this.scene.remove(o.outer);
        o.mat.dispose();
        this.parts.delete(id);
        if (this.faceOwner === id) this.clearFaces();
      }
    }
    this.drawOverlay(parts.filter((p) => p.placement.plate === plate), look);
  }

  private apply(o: PartObj) {
    const p = o.pose;
    o.outer.position.set(p.x, p.y, 0);
    o.outer.rotation.set(0, 0, (p.rot_deg * Math.PI) / 180);
    o.mid.position.set(-p.origin[0], -p.origin[1], -p.origin[2]);
    o.mesh.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3]);
  }

  private drawOverlay(parts: PlatePart[], look: SceneLook) {
    for (const c of this.overlay.children) disposeObj(c);
    this.overlay.clear();
    if (look.capsules) {
      const r = look.capsules.radius / 2;
      for (const p of parts) {
        const out = offsetOutline(placedOutline(p), r);
        const red = look.capsules.red.has(p.unit_id);
        const shape = new THREE.Shape(out.map(([x, y]) => new THREE.Vector2(x, y)));
        const fill = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({ color: red ? 0xff453a : 0xb8bcc4, transparent: true, opacity: red ? 0.28 : 0.2, depthWrite: false })
        );
        fill.position.z = 0.06;
        fill.renderOrder = 1;
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(out.map(([x, y]) => new THREE.Vector3(x, y, 0.08))),
          new THREE.LineBasicMaterial({ color: red ? 0xff453a : 0xd5d8de, transparent: true, opacity: 0.85 })
        );
        this.overlay.add(fill, line);
      }
    }
    if (look.numbers) {
      const sz = Math.max(this.bed.width_mm, this.bed.depth_mm) / 256;
      for (const p of parts) {
        const n = look.numbers.get(p.unit_id);
        if (n == null) continue;
        const spot = numberSpot(placedOutline(p), this.bed, 9 * sz);
        const disc = new THREE.Mesh(new THREE.PlaneGeometry(14 * sz, 14 * sz), new THREE.MeshBasicMaterial({ map: this.numTex(n), transparent: true, depthWrite: false }));
        disc.position.set(spot[0], spot[1], 0.12);
        disc.renderOrder = 2;
        this.overlay.add(disc);
      }
    }
  }

  /** Dims the bed outside `rect` (where the selected parts can go) and outlines it, with
   *  `label` at its back edge. Null clears it. */
  setReach(rect: [number, number, number, number] | null, label: string) {
    const key = rect ? `${rect.join(",")}|${label}|${this.bed.width_mm}x${this.bed.depth_mm}` : "";
    if (key === this.reachKey) return;
    this.reachKey = key;
    for (const c of this.reachGroup.children) disposeObj(c);
    this.reachGroup.clear();
    if (!rect) return;
    const { width_mm: w, depth_mm: d } = this.bed;
    const scale = Math.min(4, 2048 / Math.max(w, d));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(d * scale);
    const g = c.getContext("2d")!;
    const X = (mm: number) => mm * scale;
    const Y = (mm: number) => c.height - mm * scale;
    const [x0, y0, x1, y1] = [Math.max(0, rect[0]), Math.max(0, rect[1]), Math.min(w, rect[2]), Math.min(d, rect[3])];
    g.fillStyle = "rgba(8,9,12,0.42)";
    g.fillRect(0, 0, c.width, c.height);
    if (x1 > x0 && y1 > y0) {
      g.clearRect(X(x0), Y(y1), X(x1) - X(x0), Y(y0) - Y(y1));
      g.strokeStyle = "rgba(10,132,255,0.95)";
      g.lineWidth = Math.max(2, scale * 0.8);
      g.setLineDash([scale * 4, scale * 2.5]);
      g.strokeRect(X(x0) + 1, Y(y1) + 1, X(x1) - X(x0) - 2, Y(y0) - Y(y1) - 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
    plane.position.set(w / 2, d / 2, 0.06);
    plane.renderOrder = 1;
    this.reachGroup.add(plane);
    if (label && x1 > x0 && y1 > y0) {
      const k = Math.max(w, d) / 256;
      const tag = textPlane(label, 40, "#ffffff", "rgba(10,132,255,0.92)");
      tag.scale.setScalar(k * 0.8);
      tag.position.set((x0 + x1) / 2, Math.min(d, y1) + 7 * k, 0.08);
      tag.renderOrder = 3;
      this.reachGroup.add(tag);
    }
  }

  private numTex(n: number) {
    let t = this.numberTex.get(n);
    if (!t) {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d")!;
      g.fillStyle = "rgba(255,255,255,0.92)";
      g.beginPath();
      g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#1c1c1e";
      g.font = "700 64px -apple-system, Segoe UI, Roboto, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(n), 64, 68);
      t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.numberTex.set(n, t);
    }
    return t;
  }

  private tick(now: number) {
    for (const o of this.parts.values()) {
      if (o.t0 > 0) {
        const t = (now - o.t0) / TWEEN_MS;
        o.pose = t >= 1 ? o.to : blendPose(o.from, o.to, t);
        if (t >= 1) o.t0 = 0;
        this.apply(o);
      }
    }
    if (this.camTween) {
      const t = Math.min(1, (now - this.camTween.t0) / 380);
      const k = easeOutCubic(t);
      this.controls.target.lerpVectors(this.camTween.from[0], this.camTween.to[0], k);
      this.camera.position.lerpVectors(this.camTween.from[1], this.camTween.to[1], k);
      if (t >= 1) this.camTween = null;
    }
    this.controls.update();
    // ~2 px outline whatever the zoom.
    const dist = this.camera.position.distanceTo(this.controls.target);
    const pxPerMm = this.host.clientHeight / (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360));
    this.outlineThick.value = Math.min(4, Math.max(0.2, 2.6 / pxPerMm));
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }

  get animating() {
    return !!this.camTween || [...this.parts.values()].some((o) => o.t0 > 0);
  }

  // ---- picking -------------------------------------------------------------------------

  private ndc(clientX: number, clientY: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  pickPart(clientX: number, clientY: number): string | null {
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const meshes = [...this.parts.values()].filter((o) => o.outer.visible).map((o) => o.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    return hit ? (hit.object.userData.unitId as string) : null;
  }

  /** Where the pointer meets the bed plane (z = 0), in bed mm. */
  bedPoint(clientX: number, clientY: number): V2 | null {
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p) ? [p.x, p.y] : null;
  }

  /** Screen position (CSS px in the host) of a bed point. */
  screenOf(x: number, y: number, z = 0): [number, number] {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return [((v.x + 1) / 2) * this.host.clientWidth, ((1 - v.y) / 2) * this.host.clientHeight];
  }

  // ---- lay on face -----------------------------------------------------------------------

  showFaces(unitId: string, cands: FaceCandidate[]) {
    this.clearFaces();
    const o = this.parts.get(unitId);
    if (!o) return;
    this.faceOwner = unitId;
    for (const c of cands) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(c.triangles.length);
      const off = 0.25;
      for (let i = 0; i < c.triangles.length; i += 3) {
        pos[i] = c.triangles[i] + c.normal[0] * off;
        pos[i + 1] = c.triangles[i + 1] + c.normal[1] * off;
        pos[i + 2] = c.triangles[i + 2] + c.normal[2] * off;
      }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      m.renderOrder = 3;
      o.mesh.add(m);
      this.faceMeshes.push({ mesh: m, cand: c });
    }
  }

  clearFaces() {
    for (const f of this.faceMeshes) {
      f.mesh.removeFromParent();
      f.mesh.geometry.dispose();
      (f.mesh.material as THREE.Material).dispose();
    }
    this.faceMeshes = [];
    this.faceOwner = null;
    this.hoverFace = null;
  }

  pickFace(clientX: number, clientY: number, hover: boolean): FaceCandidate | null {
    if (!this.faceMeshes.length) return null;
    this.ray.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const hit = this.ray.intersectObjects(this.faceMeshes.map((f) => f.mesh), false)[0];
    const f = hit ? this.faceMeshes.find((x) => x.mesh === hit.object) ?? null : null;
    if (hover) {
      if (this.hoverFace && this.hoverFace !== f?.mesh) (this.hoverFace.material as THREE.MeshBasicMaterial).opacity = 0.42;
      this.hoverFace = f?.mesh ?? null;
      if (f) (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    }
    return f?.cand ?? null;
  }

  get faceCount() {
    return this.faceMeshes.length;
  }
}

/** Triangles wound so normals point out of the part (some files are wound inside out),
 *  which the selection outline needs. */
function outwardWinding(pos: number[], idx: number[]): number[] {
  let vol = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    vol +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol >= 0) return idx;
  const out = idx.slice();
  for (let i = 0; i + 2 < out.length; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2], out[i + 1]];
  return out;
}

function samePose(a: Pose, b: Pose) {
  const e = 1e-6;
  return (
    Math.abs(a.x - b.x) < e &&
    Math.abs(a.y - b.y) < e &&
    Math.abs(a.rot_deg - b.rot_deg) < e &&
    a.q.every((v, i) => Math.abs(v - b.q[i]) < e) &&
    a.origin.every((v, i) => Math.abs(v - b.origin[i]) < e)
  );
}

function disposeObj(o: THREE.Object3D) {
  const m = o as THREE.Mesh;
  m.geometry?.dispose?.();
  const mat = m.material as THREE.Material | undefined;
  mat?.dispose?.();
}

/** A bed number goes just in front of the part, or behind it when the front is off the bed. */
function numberSpot(outline: V2[], bed: BedSize, gap: number): V2 {
  let minY = Infinity, maxY = -Infinity, cx = 0;
  for (const [x, y] of outline) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    cx += x;
  }
  cx /= outline.length || 1;
  const y = minY - gap >= gap * 0.6 ? minY - gap : maxY + gap;
  return [Math.max(gap, Math.min(bed.width_mm - gap, cx)), Math.max(gap * 0.6, Math.min(bed.depth_mm - gap * 0.6, y))];
}

/** Bed shading for print areas (bed mm rectangles `[x0, y0, x1, y1]`). */
export interface BedShade {
  none: [number, number, number, number][];
  partial: [number, number, number, number][];
  edges: [number, number, number, number][];
}

function gridTexture(w: number, d: number, shade?: BedShade): THREE.Texture {
  const px = 4;
  const c = document.createElement("canvas");
  const scale = Math.min(px, 2048 / Math.max(w, d));
  c.width = Math.round(w * scale);
  c.height = Math.round(d * scale);
  const g = c.getContext("2d")!;
  g.fillStyle = "#33363d";
  g.fillRect(0, 0, c.width, c.height);
  for (let mm = 0; mm <= Math.max(w, d); mm += 10) {
    const major = mm % 50 === 0;
    g.strokeStyle = major ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.065)";
    g.lineWidth = major ? 1.6 : 1;
    if (mm <= w) {
      g.beginPath();
      g.moveTo(mm * scale, 0);
      g.lineTo(mm * scale, c.height);
      g.stroke();
    }
    if (mm <= d) {
      g.beginPath();
      g.moveTo(0, c.height - mm * scale);
      g.lineTo(c.width, c.height - mm * scale);
      g.stroke();
    }
  }
  if (shade) {
    const X = (mm: number) => mm * scale;
    const Y = (mm: number) => c.height - mm * scale;
    const hatch = (r: [number, number, number, number], fill: string, line: string, gap: number) => {
      const [x0, y0, x1, y1] = [X(r[0]), Y(r[3]), X(r[2]), Y(r[1])];
      g.save();
      g.beginPath();
      g.rect(x0, y0, x1 - x0, y1 - y0);
      g.clip();
      g.fillStyle = fill;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = line;
      g.lineWidth = Math.max(1.5, scale * 0.45);
      const step = gap * scale;
      for (let k = -c.height; k < c.width + c.height; k += step) {
        g.beginPath();
        g.moveTo(k, c.height);
        g.lineTo(k + c.height, 0);
        g.stroke();
      }
      g.restore();
    };
    // Where no nozzle reaches: plainly off-limits. Where only one does: a light hatch.
    for (const r of shade.none) hatch(r, "rgba(0,0,0,0.30)", "rgba(255,255,255,0.13)", 5);
    for (const r of shade.partial) hatch(r, "rgba(0,0,0,0.10)", "rgba(255,255,255,0.075)", 7);
    g.strokeStyle = "rgba(255,255,255,0.28)";
    g.lineWidth = Math.max(1.5, scale * 0.4);
    g.setLineDash([scale * 3, scale * 2]);
    for (const r of shade.edges) {
      for (const xmm of [r[0], r[2]]) {
        if (xmm <= 0.01 || xmm >= w - 0.01) continue;
        g.beginPath();
        g.moveTo(X(xmm), Y(Math.max(0, r[1])));
        g.lineTo(X(xmm), Y(Math.min(d, r[3])));
        g.stroke();
      }
      for (const ymm of [r[1], r[3]]) {
        if (ymm <= 0.01 || ymm >= d - 0.01) continue;
        g.beginPath();
        g.moveTo(X(Math.max(0, r[0])), Y(ymm));
        g.lineTo(X(Math.min(w, r[2])), Y(ymm));
        g.stroke();
      }
    }
    g.setLineDash([]);
  }
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, c.width - 3, c.height - 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textPlane(text: string, px: number, color: string, bg: string): THREE.Mesh {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = `600 ${px}px -apple-system, Segoe UI, Roboto, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + px;
  c.width = w;
  c.height = Math.ceil(px * 1.5);
  g.font = `600 ${px}px -apple-system, Segoe UI, Roboto, sans-serif`;
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const k = 0.22;
  return new THREE.Mesh(new THREE.PlaneGeometry(c.width * k, c.height * k), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
}
