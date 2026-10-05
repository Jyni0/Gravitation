import { useSyncExternalStore } from "react";
import * as db from "./db.r";

/**
 * Unit groups: every server / credential / script / proxy may be filed under
 * a group (its `group` field, "" = none). Kept in the `ssh_unit_groups`
 * setting: the order of the groups and the ungrouped units between them per
 * unit kind (shared by the sidebar and the Units page) and which groups are collapsed
 * (in the sidebar and on the page separately).
 */
export type UnitKind = "server" | "key" | "script" | "proxy";

interface GroupState {
  /** "where:kind:name" of the collapsed groups. */
  collapsed: string[];
  /** Top-level entries per unit kind, top to bottom (see layoutUnits). */
  order: Partial<Record<UnitKind, string[]>>;
}

const SETTING = "ssh_unit_groups";
const NO_ORDER: string[] = [];
let state: GroupState = { collapsed: [], order: {} };
let loaded = false;
const subscribers = new Set<() => void>();

function publish(next: GroupState) {
  state = next;
  subscribers.forEach((f) => f());
  void db.setSetting(SETTING, JSON.stringify(next)).catch(() => {});
}

function load() {
  if (loaded) return;
  loaded = true;
  void db
    .getSetting(SETTING)
    .then((raw) => {
      if (!raw) return;
      const v = JSON.parse(raw) as Partial<GroupState>;
      state = { collapsed: v.collapsed ?? [], order: v.order ?? {} };
      subscribers.forEach((f) => f());
    })
    .catch(() => {});
}

const subscribe = (f: () => void) => {
  load();
  subscribers.add(f);
  return () => {
    subscribers.delete(f);
  };
};

/** Group order and the collapsed groups of one place (the sidebar and the
 *  Units page fold their groups independently), with their setters. */
export function useUnitGroups(where: "sidebar" | "page") {
  const s = useSyncExternalStore(subscribe, () => state);
  const key = (kind: UnitKind, name: string) => where + ":" + kind + ":" + name;
  return {
    order: (kind: UnitKind) => s.order[kind] ?? NO_ORDER,
    setOrder: (kind: UnitKind, names: string[]) => publish({ ...state, order: { ...state.order, [kind]: names } }),
    isCollapsed: (kind: UnitKind, name: string) => s.collapsed.includes(key(kind, name)),
    toggleCollapsed: (kind: UnitKind, name: string) => {
      const k = key(kind, name);
      const c = state.collapsed;
      publish({ ...state, collapsed: c.includes(k) ? c.filter((x) => x !== k) : [...c, k] });
    },
  };
}

/** Units without a group (in their order), then each group — in `order`,
 *  groups not placed yet after them A→Z. */
export function groupUnits<T extends { group?: string }>(items: T[], order: string[] = NO_ORDER) {
  const loose: T[] = [];
  const byName = new Map<string, T[]>();
  for (const it of items) {
    const g = it.group?.trim() ?? "";
    if (!g) loose.push(it);
    else byName.set(g, [...(byName.get(g) ?? []), it]);
  }
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const groups = [...byName.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, list]) => ({ name, items: list }));
  return { loose, groups };
}

/** One top-level entry of a units list: a unit without a group, or a group. */
export type LayoutEntry<T> =
  | { id: string; unit: T; group?: undefined }
  | { id: string; unit?: undefined; group: { name: string; items: T[] } };

/**
 * The top level of a units list in the user's order — units without a group
 * placed between the groups as they were dragged. `order` holds entry ids
 * ("u:<unit id>" / "g:<group name>"; a bare name is a group, as saved before
 * units could be placed). Unplaced units go first, unplaced groups last.
 */
export function layoutUnits<T extends { id: string; group?: string }>(items: T[], order: string[] = NO_ORDER) {
  const { loose, groups } = groupUnits(items);
  const byId = new Map<string, LayoutEntry<T>>();
  for (const u of loose) byId.set("u:" + u.id, { id: "u:" + u.id, unit: u });
  for (const g of groups) byId.set("g:" + g.name, { id: "g:" + g.name, group: g });
  const placed: LayoutEntry<T>[] = [];
  for (const raw of order) {
    const id = raw.startsWith("u:") || raw.startsWith("g:") ? raw : "g:" + raw;
    const e = byId.get(id);
    if (e && !placed.includes(e)) placed.push(e);
  }
  const rest = (pick: (e: LayoutEntry<T>) => boolean) => [...byId.values()].filter((e) => pick(e) && !placed.includes(e));
  return [...rest((e) => !!e.unit), ...placed, ...rest((e) => !!e.group)];
}

/** Group names in use, A→Z (the form's suggestions). */
export function groupNames(items: { group?: string }[]): string[] {
  return groupUnits(items).groups.map((g) => g.name);
}

/** The full order after one group's rows were dragged into `sub` order: the
 *  group keeps its slots in the list, its rows fill them in the new order. */
export function mergeOrder(all: string[], sub: string[]): string[] {
  const moved = new Set(sub);
  let i = 0;
  return all.map((id) => (moved.has(id) ? sub[i++] : id));
}
