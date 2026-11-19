import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Windowing for long lists of variable-height cards (Orders, ANDON lanes, Shop Flow).
 * A child is mounted only while it is within `margin` px of its scroll container's
 * visible area; elsewhere it is an empty box of its last measured height, so the
 * scrollbar stays right and a 500-order shop mounts only the cards on screen.
 * Pictures inside a card load only once the card is mounted, i.e. visible.
 */

type Entry = { el: Element; set: (v: boolean) => void };
const observers = new Map<string, { io: IntersectionObserver; entries: Map<Element, Entry> }>();
let rootIds = new WeakMap<Element, string>();
let nextRootId = 1;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY + s.overflowX)) return p;
    p = p.parentElement;
  }
  return null;
}

function observe(el: Element, root: HTMLElement | null, margin: number, set: (v: boolean) => void) {
  let rid = "viewport";
  if (root) {
    rid = rootIds.get(root) ?? `r${nextRootId++}`;
    rootIds.set(root, rid);
  }
  const key = `${rid}:${margin}`;
  let o = observers.get(key);
  if (!o) {
    const entries = new Map<Element, Entry>();
    const io = new IntersectionObserver(
      (list) => {
        for (const it of list) entries.get(it.target)?.set(it.isIntersecting);
      },
      { root, rootMargin: `${margin}px` }
    );
    o = { io, entries };
    observers.set(key, o);
  }
  o.entries.set(el, { el, set });
  o.io.observe(el);
  const obs = o;
  return () => {
    obs.io.unobserve(el);
    obs.entries.delete(el);
    if (obs.entries.size === 0) {
      obs.io.disconnect();
      observers.delete(key);
    }
  };
}

/** Test hook: forget cached observers (roots are re-registered on next mount). */
export function resetLazyMountObservers() {
  observers.forEach((o) => o.io.disconnect());
  observers.clear();
  rootIds = new WeakMap();
}

export const LazyMount: React.FC<{
  /** Height used before the child has ever been measured. */
  estimate: number;
  /** Mount immediately (first screenful) instead of waiting for the observer. */
  eager?: boolean;
  margin?: number;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}> = ({ estimate, eager = false, margin = 800, style, className, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(eager || typeof IntersectionObserver === "undefined");
  const height = useRef(estimate);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    return observe(el, scrollParent(el), margin, setVisible);
  }, [margin]);

  // Remember the real height while mounted, for the placeholder when scrolled away.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!visible || !el) return;
    const measure = () => {
      if (el.offsetHeight > 0) height.current = el.offsetHeight;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  return (
    <div
      ref={ref}
      className={className}
      style={visible ? style : { ...style, height: height.current, minHeight: height.current }}
    >
      {visible ? children : null}
    </div>
  );
};
