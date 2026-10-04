import { useSyncExternalStore } from "react";

/**
 * Split view of open connections (Termius-style): a binary tree whose leaves
 * are connection ids. A split cuts its box in two — side by side ("row") or
 * stacked ("col") — at `ratio` (share of the first child).
 */
export type Layout =
  | { kind: "leaf"; conn: string }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: Layout; b: Layout };

/**
 * A tab of the Connections list: one connection on its own, or several
 * split into a grid. Each keeps its arrangement while another is shown.
 */
export interface ConnGroup {
  id: string;
  layout: Layout;
  /** Pane last focused in it — focused again when the group comes back. */
  focus?: string;
}

/** Where a dragged connection lands on a pane: one of its edges, or the pane itself. */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/** Path from the root to a node: "a" / "b" per level. */
export type NodePath = ("a" | "b")[];

/** A box in fractions of the workspace (0..1). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const leaf = (conn: string): Layout => ({ kind: "leaf", conn });

/** Connection ids in reading order (left→right, top→bottom). */
export function leaves(l: Layout | null): string[] {
  if (!l) return [];
  return l.kind === "leaf" ? [l.conn] : [...leaves(l.a), ...leaves(l.b)];
}

/** The layout without `conn`; its sibling takes the freed space. */
export function removeConn(l: Layout | null, conn: string): Layout | null {
  if (!l) return null;
  if (l.kind === "leaf") return l.conn === conn ? null : l;
  const a = removeConn(l.a, conn);
  const b = removeConn(l.b, conn);
  if (!a) return b;
  if (!b) return a;
  return a === l.a && b === l.b ? l : { ...l, a, b };
}

/** `from` swapped for `to` wherever it sits. */
export function replaceConn(l: Layout, from: string, to: string): Layout {
  if (l.kind === "leaf") return l.conn === from ? leaf(to) : l;
  return { ...l, a: replaceConn(l.a, from, to), b: replaceConn(l.b, from, to) };
}

/**
 * Drops `conn` on the pane of `target`. An edge splits that pane in two with
 * `conn` on that side; the centre puts `conn` in the pane (a connection that
 * was already shown elsewhere trades places with it).
 */
export function dropConn(l: Layout | null, conn: string, target: string, zone: DropZone): Layout {
  if (!l) return leaf(conn);
  if (conn === target) return l;
  const shown = leaves(l).includes(conn);
  if (zone === "center") {
    if (!shown) return replaceConn(l, target, conn);
    const tmp = "\u0000swap";
    return replaceConn(replaceConn(replaceConn(l, conn, tmp), target, conn), tmp, target);
  }
  const base = removeConn(l, conn) ?? leaf(target);
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "top";
  const split = (node: Layout): Layout => {
    if (node.kind === "leaf") {
      if (node.conn !== target) return node;
      return { kind: "split", dir, ratio: 0.5, a: first ? leaf(conn) : node, b: first ? node : leaf(conn) };
    }
    return { ...node, a: split(node.a), b: split(node.b) };
  };
  return split(base);
}

/** The layout with the split at `path` cut at `ratio` (kept away from the edges). */
export function setRatio(l: Layout, path: NodePath, ratio: number): Layout {
  if (l.kind === "leaf") return l;
  if (path.length === 0) return { ...l, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  const [head, ...rest] = path;
  return { ...l, [head]: setRatio(l[head], rest, ratio) };
}

/** Every pane's box, keyed by connection id. */
export function paneRects(l: Layout | null, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()) {
  if (!l) return out;
  if (l.kind === "leaf") {
    out.set(l.conn, r);
    return out;
  }
  const [ra, rb] = splitRect(r, l.dir, l.ratio);
  paneRects(l.a, ra, out);
  paneRects(l.b, rb, out);
  return out;
}

/** Every split's divider: the split's own box (for dragging) and its path. */
export function dividers(l: Layout | null, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: NodePath = []) {
  const out: { path: NodePath; dir: "row" | "col"; box: Rect; at: number }[] = [];
  if (!l || l.kind === "leaf") return out;
  out.push({ path, dir: l.dir, box: r, at: l.ratio });
  const [ra, rb] = splitRect(r, l.dir, l.ratio);
  out.push(...dividers(l.a, ra, [...path, "a"]), ...dividers(l.b, rb, [...path, "b"]));
  return out;
}

function splitRect(r: Rect, dir: "row" | "col", ratio: number): [Rect, Rect] {
  return dir === "row"
    ? [
        { ...r, w: r.w * ratio },
        { ...r, x: r.x + r.w * ratio, w: r.w * (1 - ratio) },
      ]
    : [
        { ...r, h: r.h * ratio },
        { ...r, y: r.y + r.h * ratio, h: r.h * (1 - ratio) },
      ];
}

/** The zone of a pane under a point (fractions of the pane): the nearest edge
 *  within a quarter of the pane, else the pane itself. */
export function zoneAt(rx: number, ry: number): DropZone {
  const edges: [DropZone, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  const [zone, dist] = edges.reduce((best, e) => (e[1] < best[1] ? e : best));
  return dist < 0.25 ? zone : "center";
}

/* ---------- The connection being dragged (sidebar row or pane header) ---------- */

export interface PaneDrag {
  conn: string;
  /** Pointer, viewport px. */
  x: number;
  y: number;
}

let current: PaneDrag | null = null;
const subscribers = new Set<() => void>();

export const paneDrag = {
  get: () => current,
  set(next: PaneDrag | null) {
    current = next;
    subscribers.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subscribers.add(f);
    return () => {
      subscribers.delete(f);
    };
  },
};

/** The live drag (null when nothing is dragged). */
export function usePaneDrag(): PaneDrag | null {
  return useSyncExternalStore(paneDrag.subscribe, paneDrag.get);
}

/** Mounted panes — where a drop can land. */
const PANES = new Map<string, HTMLElement>();

export function registerPane(conn: string, el: HTMLElement | null) {
  if (el) PANES.set(conn, el);
  else PANES.delete(conn);
}

/** The pane and zone under a viewport point, if any. */
export function dropTarget(x: number, y: number): { conn: string; zone: DropZone } | null {
  for (const [conn, el] of PANES) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 0 && r.height > 0) {
      return { conn, zone: zoneAt((x - r.left) / r.width, (y - r.top) / r.height) };
    }
  }
  return null;
}
