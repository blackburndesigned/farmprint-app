// The plate view: see and adjust the plate before Print! sends it. Optional: one-click
// Print! arranges automatically; this opens from "Arrange plate…" in the printer picker.
// Layout decisions (arrange, auto orient, lay-on-face candidates, checks) come from the
// backend; this view draws them, animates them, and lets the user drag, turn and remove.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CircleAlert,
  CircleCheck,
  GripVertical,
  Layers,
  LayoutGrid,
  ListOrdered,
  Maximize,
  Move,
  Plus,
  Printer as PrinterIcon,
  RotateCw,
  Scan,
  Undo2,
  Redo2,
  WandSparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { Icon } from "../../../icons";
import type { Printer } from "../../../types";
import { getShopSettings, saveShopSettingsPatch } from "../../../settingsStore";
import { plateArrange, plateAutoOrient, plateCheck, plateFaceCandidates, platePrepare } from "./plateApi";
import {
  DEFAULT_SETTINGS,
  History,
  type ArrangeSettings,
  type BedSize,
  type FaceCandidate,
  type FaceMode,
  type PlateCheck,
  type PlateMesh,
  type PlatePart,
  type PlateState,
  type PrintLayout,
  type V2,
  bbox,
  biggerThanBed,
  effectiveOrder,
  fitHeadline,
  layoutFor,
  liveProblems,
  normalizeSettings,
  placedOutline,
  platesInUse,
  removeFromJob,
  reorder,
  sizeLabel,
  transform2d,
} from "./plateModel";
import { PlateScene } from "./plateScene";
import { PlateOutlineThumb } from "./PlateFitSummary";
import "./plate.css";

type Tool = "select" | "move" | "rotate" | "face";

export interface PlateViewProps {
  unitIds: string[];
  printers: Printer[];
  printerId: string;
  onCancel: () => void;
  /** Send exactly this layout (the parts left in the job) to the chosen printer. */
  onSend: (args: { unitIds: string[]; printerId: string; layout: PrintLayout }) => void;
  /** Screenshots and tests: start from this state instead of the backend's. */
  initial?: { prepared: import("./plateModel").PreparedPlate; select?: string[]; tool?: Tool; arrangeOpen?: boolean; faceFor?: string };
}

const emptyCheck: PlateCheck = {
  plates: 1,
  fits: true,
  off_plate: [],
  collisions: [],
  clearance_overlaps: [],
  too_tall: [],
  taller_than_gantry: [],
  order: [],
  plate1_fill: 0,
  tallest_mm: 0,
};

export const PlateView: React.FC<PlateViewProps> = ({ unitIds, printers, printerId: printerId0, onCancel, onSend, initial }) => {
  const [printerId, setPrinterId] = useState(printerId0);
  const printer = printers.find((p) => p.id === printerId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meshes, setMeshes] = useState<Record<string, PlateMesh> | null>(null);
  const [state, setState] = useState<PlateState>({ parts: [], plateCount: 1, order: null });
  const [bed, setBed] = useState<BedSize>({ width_mm: 220, depth_mm: 220 });
  const [settings, setSettings] = useState<ArrangeSettings>(DEFAULT_SETTINGS);
  const [check, setCheck] = useState<PlateCheck>(emptyCheck);
  const [plate, setPlate] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>("select");
  const [faceMode, setFaceMode] = useState<FaceMode>("convex_hull");
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toastHidden, setToastHidden] = useState<string>("");
  const [live, setLive] = useState<{ off: Set<string>; hit: Set<string> } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [faceHint, setFaceHint] = useState<string | null>(null);
  const history = useRef(new History());
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PlateScene | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const parts = state.parts;

  // ---- load -------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const apply = (prep: import("./plateModel").PreparedPlate) => {
      if (cancelled) return;
      setMeshes(prep.meshes);
      setState({ parts: prep.parts, plateCount: Math.max(1, platesInUse(prep.parts)), order: null });
      setBed(prep.bed);
      setSettings(normalizeSettings(prep.settings));
      setCheck(prep.check);
      if (initial?.select) setSelected(new Set(initial.select));
      if (initial?.tool) setTool(initial.tool);
      if (initial?.arrangeOpen) setArrangeOpen(true);
    };
    if (initial) apply(initial.prepared);
    else
      platePrepare(unitIds, printerId0)
        .then(apply)
        .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // Loaded once per opening; printer changes keep the user's layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- history ------------------------------------------------------------------------------
  const [, setHistoryTick] = useState(0);
  const bumpHistory = () => setHistoryTick((n) => n + 1);
  const commit = useCallback((next: PlateState | ((s: PlateState) => PlateState)) => {
    history.current.push(stateRef.current);
    bumpHistory();
    setState(next);
  }, []);
  const travel = useCallback((dir: "undo" | "redo") => {
    const to = dir === "undo" ? history.current.undo(stateRef.current) : history.current.redo(stateRef.current);
    bumpHistory();
    if (to) {
      setState(to);
      setSelected((s) => new Set([...s].filter((id) => to.parts.some((p) => p.unit_id === id))));
    }
  }, []);
  const undo = useCallback(() => travel("undo"), [travel]);
  const redo = useCallback(() => travel("redo"), [travel]);

  // ---- backend check after every change (debounced, stale replies dropped) ------------------
  const checkSeq = useRef(0);
  useEffect(() => {
    if (!parts.length || initial) return;
    const n = ++checkSeq.current;
    const t = window.setTimeout(() => {
      plateCheck(parts, bed, settings)
        .then((c) => n === checkSeq.current && setCheck(c))
        .catch(() => undefined);
    }, 90);
    return () => window.clearTimeout(t);
  }, [parts, bed, settings, initial]);

  // A printer change keeps the layout but uses the new bed and its remembered settings.
  const changePrinter = (id: string) => {
    setPrinterId(id);
    const p = printers.find((x) => x.id === id);
    const ok = (v?: number | null) => (typeof v === "number" && v > 0 ? v : null);
    const w = ok(p?.bed_x_mm);
    const d = ok(p?.bed_y_mm);
    setBed({ width_mm: w ?? 220, depth_mm: d ?? 220, height_mm: ok(p?.bed_z_mm), known: !!(w && d) });
    setSettings(normalizeSettings(getShopSettings().printer_plate?.[id]));
  };

  const persistSettings = (s: ArrangeSettings) => {
    setSettings(s);
    if (!printerId || initial) return;
    const all = { ...(getShopSettings().printer_plate ?? {}) };
    all[printerId] = s;
    void saveShopSettingsPatch({ printer_plate: all }).catch(() => undefined);
  };

  // ---- derived ------------------------------------------------------------------------------
  const plateCount = Math.max(state.plateCount, platesInUse(parts), 1);
  const order = useMemo(() => effectiveOrder(parts, state.order, check.order), [parts, state.order, check.order]);
  const bigger = useMemo(() => biggerThanBed(parts, bed), [parts, bed]);
  const problems = useMemo(() => {
    if (live) return new Set([...live.off, ...live.hit]);
    return new Set([...check.off_plate, ...check.collisions.flat(), ...check.too_tall]);
  }, [live, check]);
  const byObject = settings.sequence === "by_object";
  const clearanceIds = useMemo(() => new Set(byObject ? check.clearance_overlaps.flat() : []), [byObject, check.clearance_overlaps]);
  const numbers = useMemo(() => {
    if (!byObject) return null;
    const m = new Map<string, number>();
    order.forEach((o) => o.forEach((id, i) => m.set(id, i + 1)));
    return m;
  }, [byObject, order]);
  const partById = useMemo(() => new Map(parts.map((p) => [p.unit_id, p])), [parts]);
  const plateProblems = (pl: number) => parts.some((p) => p.placement.plate === pl && problems.has(p.unit_id));
  // Sending is blocked only by what can't print: off the plate, too tall, bigger than the bed,
  // or (by object) two parts taller than the gantry. Overlaps and clearance warn but allow it.
  const gantryClash = settings.sequence === "by_object" && check.taller_than_gantry.length >= 2;
  const blocked = check.off_plate.length > 0 || check.too_tall.length > 0 || bigger.length > 0 || gantryClash;

  // ---- scene --------------------------------------------------------------------------------
  useEffect(() => {
    if (!hostRef.current || !meshes) return;
    const sc = new PlateScene(hostRef.current, { preserveDrawingBuffer: !!initial });
    sceneRef.current = sc;
    const ro = new ResizeObserver(() => sc.resize());
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      sc.dispose();
      sceneRef.current = null;
    };
  }, [meshes, initial]);

  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    sc.setBed(bed, `Plate ${plate + 1}`);
  }, [bed, plate, meshes]);
  const framed = useRef(false);
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc || framed.current) return;
    framed.current = true;
    sc.viewPreset("iso", false);
  }, [meshes]);

  const dragging = useRef(false);
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc || !meshes) return;
    sc.sync(
      parts,
      meshes,
      plate,
      {
        selected,
        problems,
        capsules: byObject ? { radius: settings.clearance_radius_mm, red: clearanceIds } : null,
        numbers,
      },
      dragging.current
    );
  }, [parts, meshes, plate, selected, problems, byObject, settings.clearance_radius_mm, clearanceIds, numbers]);

  // ---- lay on face ----------------------------------------------------------------------------
  const faceTarget = tool === "face" && selected.size === 1 ? [...selected][0] : null;
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    if (!faceTarget) {
      sc.clearFaces();
      setFaceHint(tool === "face" ? "Select one part, then click the face it should sit on." : null);
      return;
    }
    let stop = false;
    setFaceHint("Finding flat faces…");
    plateFaceCandidates(faceTarget, faceMode)
      .then((c) => {
        if (stop) return;
        sc.showFaces(faceTarget, c);
        setFaceHint(c.length ? "Click a white face to put it on the bed. Esc to finish." : "No flat faces found. Try Triangle faces.");
      })
      .catch((e) => !stop && setFaceHint(String(e instanceof Error ? e.message : e)));
    return () => {
      stop = true;
    };
  }, [faceTarget, faceMode, tool, parts.length]);

  const layOnFace = (id: string, c: FaceCandidate) => {
    commit((s) => ({
      ...s,
      parts: s.parts.map((p) => (p.unit_id === id ? { ...p, orientation: c.orientation, footprint: c.footprint } : p)),
    }));
  };

  // ---- actions --------------------------------------------------------------------------------
  const runArrange = async (s: ArrangeSettings, pinned?: Set<string>, base?: PlatePart[]) => {
    const src = base ?? stateRef.current.parts;
    setBusy("Arranging…");
    try {
      const r = await plateArrange(src, bed, s, pinned);
      commit((st) => ({
        ...st,
        parts: src.map((p) => ({ ...p, placement: r.placements[p.unit_id] ?? p.placement, footprint: r.footprints[p.unit_id] ?? p.footprint })),
        plateCount: Math.max(1, r.check.plates),
        order: null,
      }));
      setCheck(r.check);
      setPlate((pl) => Math.min(pl, Math.max(0, r.check.plates - 1)));
    } finally {
      setBusy(null);
    }
  };

  const autoOrient = async () => {
    const ids = selected.size ? [...selected] : parts.map((p) => p.unit_id);
    setBusy("Orienting…");
    try {
      const r = await plateAutoOrient(ids);
      const next = stateRef.current.parts.map((p) => (r[p.unit_id] ? { ...p, orientation: r[p.unit_id].orientation, footprint: r[p.unit_id].footprint } : p));
      // Turned parts get new outlines: arrange them, keeping the others where they are.
      const pinned = selected.size ? new Set(parts.filter((p) => !selected.has(p.unit_id)).map((p) => p.unit_id)) : undefined;
      await runArrange(settings, pinned, next);
    } finally {
      setBusy(null);
    }
  };

  const deleteSelected = () => {
    if (!selected.size) return;
    if (selected.size >= parts.length) return; // a job keeps at least one part
    commit((s) => ({ ...s, parts: removeFromJob(s.parts, selected), order: null }));
    setSelected(new Set());
  };

  const rotateSelected = (deg: number) => {
    if (!selected.size) return;
    const sel = parts.filter((p) => selected.has(p.unit_id) && p.placement.plate === plate);
    if (!sel.length) return;
    const cx = sel.reduce((a, p) => a + p.placement.x, 0) / sel.length;
    const cy = sel.reduce((a, p) => a + p.placement.y, 0) / sel.length;
    commit((s) => ({
      ...s,
      parts: s.parts.map((p) => {
        if (!selected.has(p.unit_id) || p.placement.plate !== plate) return p;
        const [[x, y]] = transform2d([[p.placement.x - cx, p.placement.y - cy]], deg, cx, cy);
        return { ...p, placement: { ...p.placement, x, y, rot_deg: (((p.placement.rot_deg + deg) % 360) + 360) % 360 } };
      }),
    }));
  };

  const nudge = (dx: number, dy: number) => {
    if (!selected.size) return;
    commit((s) => ({
      ...s,
      parts: s.parts.map((p) => (selected.has(p.unit_id) ? { ...p, placement: { ...p.placement, x: p.placement.x + dx, y: p.placement.y + dy } } : p)),
    }));
  };

  const addPlate = () => {
    const n = plateCount + 1;
    setState((s) => ({ ...s, plateCount: n }));
    setPlate(n - 1);
  };

  /** Moves a part to another plate: it goes into the first free spot there (or the middle). */
  const moveToPlate = async (id: string, to: number) => {
    const p = partById.get(id);
    if (!p || p.placement.plate === to) return;
    const there = parts.filter((q) => q.placement.plate === to);
    const local = [...there.map((q) => ({ ...q, placement: { ...q.placement, plate: 0 } })), { ...p, placement: { ...p.placement, plate: 0 } }];
    let spot = { plate: to, x: bed.width_mm / 2, y: bed.depth_mm / 2, rot_deg: p.placement.rot_deg };
    try {
      const r = await plateArrange(local, bed, settings, new Set(there.map((q) => q.unit_id)));
      const got = r.placements[id];
      if (got && got.plate === 0) spot = { ...got, plate: to };
    } catch {
      // keep the middle of the plate; the check shows if it overlaps
    }
    commit((s) => ({ ...s, parts: s.parts.map((q) => (q.unit_id === id ? { ...q, placement: spot } : q)), order: null }));
    setPlate(to);
  };

  const jumpTo = (ids: string[]) => {
    const ps = ids.map((i) => partById.get(i)).filter((p): p is PlatePart => !!p);
    if (!ps.length) return;
    setPlate(ps[0].placement.plate);
    setSelected(new Set(ps.map((p) => p.unit_id)));
    const pts: V2[] = ps.flatMap((p) => placedOutline(p));
    const b = bbox(pts);
    sceneRef.current?.focus((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.max(b[2] - b[0], b[3] - b[1]) / 2 + settings.clearance_radius_mm);
  };

  const send = () => {
    if (blocked) return;
    onSend({ unitIds: parts.map((p) => p.unit_id), printerId, layout: layoutFor(parts, order) });
  };

  // ---- keyboard -------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      // The plate view owns the keyboard while open: undo here must never reach the app's
      // own undo (which would undo a shop action behind the window).
      e.stopImmediatePropagation();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(parts.filter((p) => p.placement.plate === plate).map((p) => p.unit_id)));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        if (arrangeOpen) setArrangeOpen(false);
        else if (tool !== "select") setTool("select");
        else setSelected(new Set());
      } else if (e.key === "r" || e.key === "R") {
        rotateSelected(e.shiftKey ? -90 : 90);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const s = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft") nudge(-s, 0);
        if (e.key === "ArrowRight") nudge(s, 0);
        if (e.key === "ArrowUp") nudge(0, s);
        if (e.key === "ArrowDown") nudge(0, -s);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---- pointer: select, marquee, drag to move or turn, lay on face -------------------------
  const drag = useRef<{
    kind: "move" | "rotate" | "marquee";
    start: V2;
    startClient: [number, number];
    base: PlateState;
    ids: Set<string>;
    centre: V2;
    moved: boolean;
    additive: boolean;
  } | null>(null);

  const localXY = (e: React.PointerEvent): [number, number] => {
    const r = hostRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const sc = sceneRef.current;
    if (!sc || e.button !== 0) return;
    setArrangeOpen(false);
    if (tool === "face" && faceTarget) {
      const c = sc.pickFace(e.clientX, e.clientY, false);
      if (c) {
        layOnFace(faceTarget, c);
        return;
      }
    }
    const hit = sc.pickPart(e.clientX, e.clientY);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const bp = sc.bedPoint(e.clientX, e.clientY) ?? [0, 0];
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (hit) {
      let sel = selected;
      if (additive) {
        sel = new Set(selected);
        if (sel.has(hit)) sel.delete(hit);
        else sel.add(hit);
      } else if (!selected.has(hit)) sel = new Set([hit]);
      setSelected(sel);
      if (tool === "face") return;
      const ids = new Set([...sel].filter((id) => partById.get(id)?.placement.plate === plate));
      const on = parts.filter((p) => ids.has(p.unit_id));
      const centre: V2 = [on.reduce((a, p) => a + p.placement.x, 0) / (on.length || 1), on.reduce((a, p) => a + p.placement.y, 0) / (on.length || 1)];
      drag.current = { kind: tool === "rotate" ? "rotate" : "move", start: bp, startClient: [e.clientX, e.clientY], base: stateRef.current, ids, centre, moved: false, additive };
    } else {
      const [x, y] = localXY(e);
      drag.current = { kind: "marquee", start: bp, startClient: [x, y], base: stateRef.current, ids: new Set(), centre: [0, 0], moved: false, additive };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const sc = sceneRef.current;
    if (!sc) return;
    const d = drag.current;
    if (!d) {
      if (tool === "face") sc.pickFace(e.clientX, e.clientY, true);
      return;
    }
    if (d.kind === "marquee") {
      const [x, y] = localXY(e);
      if (Math.hypot(x - d.startClient[0], y - d.startClient[1]) > 4) d.moved = true;
      if (d.moved) setMarquee({ x0: d.startClient[0], y0: d.startClient[1], x1: x, y1: y });
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) < 3) return;
    d.moved = true;
    dragging.current = true;
    const bp = sc.bedPoint(e.clientX, e.clientY);
    if (!bp) return;
    let next: PlatePart[];
    if (d.kind === "move") {
      const dx = bp[0] - d.start[0];
      const dy = bp[1] - d.start[1];
      next = d.base.parts.map((p) => (d.ids.has(p.unit_id) ? { ...p, placement: { ...p.placement, x: p.placement.x + dx, y: p.placement.y + dy } } : p));
    } else {
      const a0 = Math.atan2(d.start[1] - d.centre[1], d.start[0] - d.centre[0]);
      const a1 = Math.atan2(bp[1] - d.centre[1], bp[0] - d.centre[0]);
      const step = e.shiftKey ? 45 : 5;
      const deg = Math.round(((a1 - a0) * 180) / Math.PI / step) * step;
      next = d.base.parts.map((p) => {
        if (!d.ids.has(p.unit_id)) return p;
        const [[x, y]] = transform2d([[p.placement.x - d.centre[0], p.placement.y - d.centre[1]]], deg, d.centre[0], d.centre[1]);
        return { ...p, placement: { ...p.placement, x, y, rot_deg: (((p.placement.rot_deg + deg) % 360) + 360) % 360 } };
      });
    }
    setState((s) => ({ ...s, parts: next }));
    setLive(liveProblems(next, plate, bed));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const sc = sceneRef.current;
    const d = drag.current;
    drag.current = null;
    dragging.current = false;
    if (!sc || !d) return;
    if (d.kind === "marquee") {
      setMarquee(null);
      if (!d.moved) {
        if (!d.additive) setSelected(new Set());
        return;
      }
      const [x, y] = localXY(e);
      const [x0, x1] = [Math.min(x, d.startClient[0]), Math.max(x, d.startClient[0])];
      const [y0, y1] = [Math.min(y, d.startClient[1]), Math.max(y, d.startClient[1])];
      const inside = parts.filter((p) => {
        if (p.placement.plate !== plate) return false;
        const [sx, sy] = sc.screenOf(p.placement.x, p.placement.y, p.footprint.height / 2);
        return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
      });
      setSelected((s) => new Set([...(d.additive ? s : []), ...inside.map((p) => p.unit_id)]));
      return;
    }
    setLive(null);
    if (d.moved) {
      history.current.push(d.base);
      bumpHistory();
    }
  };

  // ---- render ---------------------------------------------------------------------------------
  const headline = fitHeadline({ ...check, plates: Math.max(check.plates, 1) }, bigger.length);
  const nSel = selected.size;
  const bedLabel = `${Math.round(bed.width_mm)} × ${Math.round(bed.depth_mm)}${bed.height_mm ? ` × ${Math.round(bed.height_mm)}` : ""} mm`;
  const clearanceKey = check.clearance_overlaps.map((p) => p.join("+")).join(",");
  const showToast = byObject && check.clearance_overlaps.length > 0 && toastHidden !== clearanceKey;
  const listOrder: PlatePart[] = byObject
    ? order.flatMap((o) => o.map((id) => partById.get(id)).filter((p): p is PlatePart => !!p))
    : [...parts].sort((a, b) => a.placement.plate - b.placement.plate);
  const thumbSummary = useMemo(
    () => ({ bed, outlines: parts.map((p) => ({ unit_id: p.unit_id, hex: p.hex, plate: p.placement.plate, outline: placedOutline(p) })) }),
    [bed, parts]
  );
  const tallest = parts.reduce((m, p) => Math.max(m, p.footprint.height), 0);
  const fill = (() => {
    const a = parts.filter((p) => p.placement.plate === plate).reduce((s, p) => s + p.footprint.area, 0);
    return Math.min(1, a / (bed.width_mm * bed.depth_mm));
  })();

  const toolBtn = (t: Tool, icon: typeof Move, label: string, title: string) => (
    <button type="button" className={`fp-plate-tool${tool === t ? " active" : ""}`} title={title} onClick={() => setTool(tool === t ? "select" : t)}>
      <Icon icon={icon} size={14} /> {label}
    </button>
  );

  const [dragRow, setDragRow] = useState<string | null>(null);

  return (
    <div className="fp-modal-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="fp-modal-window fp-plate-win" role="dialog" aria-modal="true" aria-label="Arrange plate" onClick={(e) => e.stopPropagation()}>
        <div className="fp-modal-header">
          <div style={{ minWidth: 0 }}>
            <div className="fp-modal-title">
              Arrange plate · {parts.length} part{parts.length === 1 ? "" : "s"}
              {printer ? ` for ${printer.name}` : ""}
            </div>
            <div className="fp-plate-sub">The slicer opens the plate exactly as laid out here.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label className="fp-plate-printer" title="Printer">
              <Icon icon={PrinterIcon} size={13} />
              <select value={printerId} onChange={(e) => changePrinter(e.target.value)} aria-label="Printer">
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span className="fp-plate-printer-bed">{bedLabel}</span>
            </label>
            <span className="fp-plate-hdrlbl">Print sequence</span>
            <div className="fp-mode-toggle" role="radiogroup" aria-label="Print sequence">
              <button type="button" className={`fp-mode-btn${!byObject ? " active" : ""}`} onClick={() => persistSettings({ ...settings, sequence: "by_layer" })}>
                <Icon icon={Layers} size={12} /> By layer
              </button>
              <button type="button" className={`fp-mode-btn${byObject ? " active" : ""}`} onClick={() => persistSettings({ ...settings, sequence: "by_object" })}>
                <Icon icon={ListOrdered} size={12} /> By object
              </button>
            </div>
            <button type="button" className="fp-btn fp-btn-sm fp-btn-ghost" aria-label="Close" onClick={onCancel}>
              <Icon icon={X} size={14} />
            </button>
          </div>
        </div>

        <div className="fp-plate-body">
          {/* Plates */}
          <div className="fp-plate-col">
            {Array.from({ length: plateCount }, (_, pl) => {
              const n = parts.filter((p) => p.placement.plate === pl).length;
              return (
                <button key={pl} type="button" className={`fp-plate-thumbcard${pl === plate ? " active" : ""}`} onClick={() => setPlate(pl)}>
                  <span className="fp-plate-thumbnum">{pl + 1}</span>
                  {plateProblems(pl) && <span className="fp-plate-thumbbad" title="Something on this plate needs attention">!</span>}
                  <PlateOutlineThumb summary={thumbSummary} plate={pl} size={100} problems={problems} />
                  <span className="fp-plate-thumbmeta">
                    <b>Plate {pl + 1}</b>
                    <span>{n === 0 ? "empty" : `${n} part${n === 1 ? "" : "s"}`}</span>
                  </span>
                </button>
              );
            })}
            <button type="button" className="fp-btn fp-btn-sm fp-plate-addplate" onClick={addPlate}>
              <Icon icon={Plus} size={13} /> Add plate
            </button>
          </div>

          {/* Viewport */}
          <div className="fp-plate-main">
            <div className="fp-plate-toolbar">
              <button type="button" className="fp-plate-tool" title="Turn parts so their largest flat face sits on the bed (selected parts, or all)" onClick={() => void autoOrient()} disabled={!!busy}>
                <Icon icon={WandSparkles} size={14} /> Auto orient
              </button>
              <div style={{ position: "relative" }}>
                <button type="button" className={`fp-plate-tool${arrangeOpen ? " active" : ""}`} onClick={() => setArrangeOpen((o) => !o)} title="Arrange settings">
                  <Icon icon={LayoutGrid} size={14} /> Arrange
                </button>
                {arrangeOpen && (
                  <ArrangePopover
                    settings={settings}
                    printerName={printer?.name ?? "this printer"}
                    onChange={persistSettings}
                    onArrange={(s) => {
                      setArrangeOpen(false);
                      void runArrange(s);
                    }}
                  />
                )}
              </div>
              {toolBtn("face", ArrowDownToLine, "Lay on face", "Click a flat face to put it on the bed")}
              <span className="fp-plate-sep" />
              {toolBtn("move", Move, "Move", "Drag parts to move them")}
              {toolBtn("rotate", RotateCw, "Rotate", "Drag to turn the selected parts (Shift: 45° steps). R turns 90°.")}
              <span className="fp-plate-sep" />
              <button type="button" className="fp-plate-tool" onClick={addPlate}>
                <Icon icon={Plus} size={14} /> Add plate
              </button>
              <button type="button" className="fp-plate-tool" onClick={undo} disabled={!history.current.canUndo} title="Undo (⌘Z / Ctrl+Z)">
                <Icon icon={Undo2} size={14} />
              </button>
              <button type="button" className="fp-plate-tool" onClick={redo} disabled={!history.current.canRedo} title="Redo (⇧⌘Z / Ctrl+Shift+Z)">
                <Icon icon={Redo2} size={14} />
              </button>
              {tool === "face" && (
                <div className="fp-mode-toggle fp-plate-facemode" role="radiogroup" aria-label="Faces">
                  <button type="button" className={`fp-mode-btn${faceMode === "convex_hull" ? " active" : ""}`} onClick={() => setFaceMode("convex_hull")}>
                    Convex hull
                  </button>
                  <button type="button" className={`fp-mode-btn${faceMode === "triangle" ? " active" : ""}`} onClick={() => setFaceMode("triangle")}>
                    Triangle faces
                  </button>
                </div>
              )}
              <span className="fp-plate-hint">{busy ?? faceHint ?? (nSel ? "Drag to move · R to turn · Delete removes from this job" : "Drag on the bed to select · Right-drag to turn the view")}</span>
            </div>
            <div
              className={`fp-plate-viewport tool-${tool}`}
              ref={hostRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              {loadError && (
                <div className="fp-plate-loaderr">
                  <Icon icon={CircleAlert} size={16} /> {loadError}
                </div>
              )}
              {!meshes && !loadError && <div className="fp-plate-loading">Loading models…</div>}
              {marquee && (
                <div
                  className="fp-plate-marquee"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                  }}
                />
              )}
              <div className="fp-plate-viewbtns" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" title="Overview" onClick={() => sceneRef.current?.viewPreset("iso")}>
                  <Icon icon={Maximize} size={13} />
                </button>
                <button type="button" title="Top view" onClick={() => sceneRef.current?.viewPreset("top")}>
                  <Icon icon={Scan} size={13} />
                </button>
              </div>
              {showToast && (
                <div className="fp-plate-toast" onPointerDown={(e) => e.stopPropagation()}>
                  <Icon icon={TriangleAlert} size={16} />
                  <div style={{ flex: 1 }}>
                    <div className="fp-plate-toast-title">Too close for printing by object</div>
                    <div>
                      {new Set(check.clearance_overlaps.flat()).size} parts are closer than {settings.clearance_radius_mm} mm, so the print head could hit a finished part.{" "}
                      <button type="button" className="fp-link-btn" onClick={() => jumpTo(check.clearance_overlaps[0])}>
                        Jump to
                      </button>{" "}
                      ·{" "}
                      <button type="button" className="fp-link-btn" onClick={() => void runArrange(settings)}>
                        Arrange
                      </button>
                    </div>
                  </div>
                  <button type="button" className="fp-plate-toast-x" aria-label="Dismiss" onClick={() => setToastHidden(clearanceKey)}>
                    <Icon icon={X} size={13} />
                  </button>
                </div>
              )}
            </div>
            <div className="fp-plate-status">
              <span className={`fp-fit-chip fp-fit-${headline.tone}`}>
                <Icon icon={headline.tone === "ok" ? CircleCheck : headline.tone === "warn" ? TriangleAlert : CircleAlert} size={12} /> {headline.text}
              </span>
              <span>
                {parts.length} part{parts.length === 1 ? "" : "s"} · {Math.round(fill * 100)}% of the bed used · tallest part {Math.round(tallest)}
                {bed.height_mm ? ` of ${Math.round(bed.height_mm)}` : ""} mm
                {nSel ? ` · ${nSel} selected` : ""}
                {byObject && check.taller_than_gantry.length === 1 ? " · 1 taller than the gantry, prints last" : ""}
                {gantryClash ? ` · ${check.taller_than_gantry.length} taller than the gantry clearance` : ""}
              </span>
            </div>
          </div>

          {/* Parts */}
          <div className="fp-plate-side">
            <div className="fp-plate-sidehdr">{byObject ? "Print order" : "Parts"}</div>
            <div className="fp-plate-list">
              {listOrder.map((p) => {
                const bad = problems.has(p.unit_id) || clearanceIds.has(p.unit_id);
                const num = numbers?.get(p.unit_id);
                return (
                  <div
                    key={p.unit_id}
                    className={`fp-plate-row${selected.has(p.unit_id) ? " selected" : ""}${bad ? " bad" : ""}${dragRow === p.unit_id ? " dragging" : ""}`}
                    draggable={byObject}
                    onDragStart={() => setDragRow(p.unit_id)}
                    onDragEnd={() => setDragRow(null)}
                    onDragOver={(e) => byObject && dragRow && e.preventDefault()}
                    onDrop={() => {
                      if (!dragRow || dragRow === p.unit_id) return;
                      const a = partById.get(dragRow);
                      if (!a || a.placement.plate !== p.placement.plate) return;
                      const pl = p.placement.plate;
                      commit((s) => ({ ...s, order: reorder(order, pl, dragRow, order[pl].indexOf(p.unit_id)) }));
                    }}
                    onClick={(e) => {
                      const add = e.shiftKey || e.metaKey || e.ctrlKey;
                      setSelected((s) => {
                        if (!add) return new Set([p.unit_id]);
                        const n = new Set(s);
                        if (n.has(p.unit_id)) n.delete(p.unit_id);
                        else n.add(p.unit_id);
                        return n;
                      });
                      if (p.placement.plate !== plate) setPlate(p.placement.plate);
                    }}
                    onDoubleClick={() => jumpTo([p.unit_id])}
                  >
                    {byObject && <Icon icon={GripVertical} size={13} className="fp-plate-grip" />}
                    {num != null && <span className="fp-plate-num">{num}</span>}
                    <span className="fp-plate-swatch" style={{ background: p.hex || "#9aa0a6" }} />
                    <span className="fp-plate-rowtext">
                      <b>{p.name}</b>
                      <span>
                        {[p.customer_name, p.product_name].filter(Boolean).join(" · ")} · {sizeLabel(p.footprint)}
                      </span>
                    </span>
                    <select
                      className="fp-plate-chip"
                      value={p.placement.plate}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => void moveToPlate(p.unit_id, Number(e.target.value))}
                      aria-label={`Plate for ${p.name}`}
                    >
                      {Array.from({ length: plateCount }, (_, i) => (
                        <option key={i} value={i}>
                          Plate {i + 1}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="fp-plate-summary">
              <div>
                <span>Print sequence</span>
                <b>{byObject ? "By object" : "By layer"}</b>
              </div>
              <div>
                <span>Plates</span>
                <b>{plateCount}</b>
              </div>
              <div>
                <span>{byObject ? "Clearance" : "Spacing"}</span>
                <b>{byObject ? `${settings.clearance_radius_mm} mm radius` : `${settings.spacing_mm} mm`}</b>
              </div>
              <div>
                <span>Bed used (Plate {plate + 1})</span>
                <b>{Math.round(fill * 100)}%</b>
              </div>
            </div>
          </div>
        </div>

        <div className="fp-plate-footer">
          <span className="fp-plate-footnote">
            {blocked
              ? gantryClash
                ? "Only one part taller than the gantry clearance can print by object. Move one to another plate or print by layer."
                : "Parts off the plate or too big can't be sent. Move or turn them first."
              : check.collisions.length
                ? "Some parts overlap. They'll overlap in the slicer too."
                : "Slot numbers come from the printer's loaded filament, as before. Removed parts stay in Parts to Print."}
          </span>
          <button type="button" className="fp-btn fp-btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="fp-btn fp-btn-sm fp-btn-primary" disabled={blocked || !parts.length || !!busy} onClick={send} title={blocked ? "Some parts can't print as laid out" : "Send to the slicer"}>
            <Icon icon={PrinterIcon} size={14} /> {plateCount > 1 ? `Send ${plateCount} plates to slicer` : "Send to slicer"}
          </button>
        </div>
      </div>
    </div>
  );
};

const ArrangePopover: React.FC<{
  settings: ArrangeSettings;
  printerName: string;
  onChange: (s: ArrangeSettings) => void;
  onArrange: (s: ArrangeSettings) => void;
}> = ({ settings, printerName, onChange, onArrange }) => {
  const [spacing, setSpacing] = useState(String(settings.spacing_mm));
  const [radius, setRadius] = useState(String(settings.clearance_radius_mm));
  const [height, setHeight] = useState(String(settings.clearance_height_mm));
  const num = (v: string, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const byObject = settings.sequence === "by_object";
  return (
    <div className="fp-plate-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="fp-plate-pop-title">Arrange</div>
      <label className="fp-plate-pop-row">
        <span>Spacing</span>
        <span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={spacing}
            onChange={(e) => setSpacing(e.target.value)}
            onBlur={() => onChange({ ...settings, spacing_mm: num(spacing, settings.spacing_mm) })}
          />{" "}
          mm
        </span>
      </label>
      {byObject && (
        <>
          <label className="fp-plate-pop-row">
            <span>Clearance radius</span>
            <span>
              <input type="number" min={0} value={radius} onChange={(e) => setRadius(e.target.value)} onBlur={() => onChange({ ...settings, clearance_radius_mm: num(radius, settings.clearance_radius_mm) })} /> mm
            </span>
          </label>
          <label className="fp-plate-pop-row">
            <span>Clearance height</span>
            <span>
              <input type="number" min={0} value={height} onChange={(e) => setHeight(e.target.value)} onBlur={() => onChange({ ...settings, clearance_height_mm: num(height, settings.clearance_height_mm) })} /> mm
            </span>
          </label>
        </>
      )}
      <label className="fp-plate-pop-check">
        <input type="checkbox" checked={settings.auto_rotate} onChange={(e) => onChange({ ...settings, auto_rotate: e.target.checked })} /> Auto-rotate for arrangement
      </label>
      <label className="fp-plate-pop-check">
        <input type="checkbox" checked={settings.align_y} onChange={(e) => onChange({ ...settings, align_y: e.target.checked })} /> Align to Y axis
      </label>
      <div className="fp-plate-pop-btns">
        <button
          type="button"
          className="fp-btn fp-btn-sm"
          onClick={() => {
            const d = { ...DEFAULT_SETTINGS, sequence: settings.sequence };
            setSpacing(String(d.spacing_mm));
            setRadius(String(d.clearance_radius_mm));
            setHeight(String(d.clearance_height_mm));
            onChange(d);
          }}
        >
          Reset
        </button>
        <button
          type="button"
          className="fp-btn fp-btn-sm fp-btn-primary"
          onClick={() => {
            const next = { ...settings, spacing_mm: num(spacing, settings.spacing_mm), clearance_radius_mm: num(radius, settings.clearance_radius_mm), clearance_height_mm: num(height, settings.clearance_height_mm) };
            onChange(next);
            onArrange(next);
          }}
        >
          <Icon icon={LayoutGrid} size={13} /> Arrange
        </button>
      </div>
      <div className="fp-plate-pop-foot">Remembered for {printerName}. By layer packs tight; by object spreads parts by the clearance.</div>
    </div>
  );
};

export default PlateView;
