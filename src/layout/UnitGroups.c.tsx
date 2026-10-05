import { useMemo } from "react";
import { motion, AnimatePresence, Reorder, useDragControls } from "motion/react";
import { ChevronRight, Trash2 } from "lucide-react";
import * as db from "../core/db.r";
import { layoutUnits, mergeOrder, useUnitGroups, type LayoutEntry, type UnitKind } from "../core/unitGroups.u";
import { useDragOrder } from "../hooks/useDragOrder.h";
import { ROW_ICON } from "../components";

/**
 * A units list with groups, in the user's order. The top level mixes units
 * without a group and groups: drag a unit row, or a group by its header, to
 * place it anywhere among them (kept, and shared by the sidebar and the
 * Units page). Rows inside a group drag within that group. A group header
 * collapses on click; its trash deletes the group (its units stay, without a
 * group). `children` draws one row.
 *
 * `variant`: "sidebar" = plain rows under quiet labels; "page" = the Units
 * page cards under small-caps headers.
 */
export function UnitGroups<T extends { id: string; group?: string }>({
  kind,
  items,
  variant,
  onReorder,
  onChanged,
  onHover,
  children,
}: {
  kind: UnitKind;
  items: T[];
  variant: "sidebar" | "page";
  /** Rows of a group were dragged: the whole list in its new order (ids). */
  onReorder: (ids: string[]) => void;
  /** Units changed (a group was deleted) — reload them. */
  onChanged: () => void;
  /** Row hover in/out (null = left), for the rows' hover actions. */
  onHover?: (id: string | null) => void;
  children: (item: T) => React.ReactNode;
}) {
  const view = useUnitGroups(variant);
  const order = view.order(kind);
  const entries = useMemo(() => layoutUnits(items, order), [items, order]);
  const drag = useDragOrder(entries, (ids) => view.setOrder(kind, ids));
  const all = items.map((x) => x.id);
  const reorder = (ids: string[]) => onReorder(mergeOrder(all, ids));
  const side = variant === "sidebar";

  const deleteGroup = async (name: string, count: number) => {
    const what = count === 1 ? "Its unit stays" : `Its ${count} units stay`;
    if (!confirm(`Delete the group "${name}"? ${what}, without a group.`)) return;
    await db.ungroupSshUnits(kind, name).catch(() => {});
    onChanged();
  };

  return (
    <Reorder.Group
      axis="y"
      values={drag.order}
      onReorder={drag.setOrder}
      as="div"
      className={side ? "flex flex-col gap-0.5" : "flex flex-col gap-3"}
    >
      {drag.order.map((e) => {
        const g = e.group;
        if (g) {
          return (
            <GroupItem
              key={e.id}
              entry={e}
              group={g}
              side={side}
              collapsed={view.isCollapsed(kind, g.name)}
              onToggle={() => view.toggleCollapsed(kind, g.name)}
              onDelete={() => void deleteGroup(g.name, g.items.length)}
              drag={drag}
            >
              <RowList items={g.items} side={side} onReorder={reorder} onHover={onHover}>
                {children}
              </RowList>
            </GroupItem>
          );
        }
        const unit = e.unit as T;
        return (
          <Reorder.Item
            key={e.id}
            value={e}
            as="div"
            className={side ? "relative shrink-0 select-none rounded-xl" : cardClass + " relative select-none"}
            onDragStart={drag.onDragStart}
            onDragEnd={drag.onDragEnd}
            onClickCapture={drag.suppressClick}
            whileDrag={side ? SIDE_DRAG : PAGE_DRAG}
            onMouseEnter={() => onHover?.(unit.id)}
            onMouseLeave={() => onHover?.(null)}
          >
            {children(unit)}
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
  );
}

const cardClass = "overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]";
const SIDE_DRAG = { scale: 1.03, zIndex: 10, backgroundColor: "var(--row-solid-hover)" };
const PAGE_DRAG = { scale: 1.015, boxShadow: "0 8px 24px rgba(0,0,0,0.28)", zIndex: 10 };

/** The rows of one group, dragged among themselves. */
function RowList<T extends { id: string }>({
  items,
  side,
  onReorder,
  onHover,
  children,
}: {
  items: T[];
  side: boolean;
  onReorder: (ids: string[]) => void;
  onHover?: (id: string | null) => void;
  children: (item: T) => React.ReactNode;
}) {
  const drag = useDragOrder(items, onReorder);
  return (
    <Reorder.Group
      axis="y"
      values={drag.order}
      onReorder={drag.setOrder}
      as="div"
      className={side ? "flex flex-col gap-0.5" : cardClass + " flex flex-col"}
    >
      {drag.order.map((item, i) => (
        <Reorder.Item
          key={item.id}
          value={item}
          as="div"
          className={side ? "relative shrink-0 select-none rounded-xl" : "relative select-none bg-[var(--bg-surface)]"}
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          onClickCapture={drag.suppressClick}
          whileDrag={side ? SIDE_DRAG : PAGE_DRAG}
          onMouseEnter={() => onHover?.(item.id)}
          onMouseLeave={() => onHover?.(null)}
        >
          {!side && i > 0 && <div className="h-px bg-[var(--border-soft)]" />}
          {children(item)}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}

/** One group: a header that drags the whole group, then its rows. */
function GroupItem<T>({
  entry,
  group,
  side,
  collapsed,
  onToggle,
  onDelete,
  drag,
  children,
}: {
  entry: LayoutEntry<T>;
  group: { name: string; items: T[] };
  side: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onDelete: () => void;
  drag: ReturnType<typeof useDragOrder<LayoutEntry<T>>>;
  children: React.ReactNode;
}) {
  // Only the header starts the drag — rows inside keep their own.
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={entry}
      as="div"
      className={"relative flex flex-col rounded-xl" + (side ? "" : " mt-1")}
      dragListener={false}
      dragControls={controls}
      onDragStart={drag.onDragStart}
      onDragEnd={drag.onDragEnd}
      whileDrag={{ zIndex: 10, opacity: 0.85 }}
    >
      <GroupHeader
        side={side}
        name={group.name}
        count={group.items.length}
        collapsed={collapsed}
        onToggle={onToggle}
        onDelete={onDelete}
        onGrab={(e) => controls.start(e)}
        suppressClick={drag.suppressClick}
      />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </Reorder.Item>
  );
}

function GroupHeader({
  side,
  name,
  count,
  collapsed,
  onToggle,
  onDelete,
  onGrab,
  suppressClick,
}: {
  side: boolean;
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onDelete: () => void;
  /** Pointer down on the header — may become a drag of the group. */
  onGrab: (e: React.PointerEvent) => void;
  /** Swallows the click a drop fires on the header. */
  suppressClick: (e: React.MouseEvent) => void;
}) {
  const chevron = (
    <motion.span animate={{ rotate: collapsed ? 0 : 90 }} transition={{ duration: 0.15 }} className="flex shrink-0">
      <ChevronRight size={side ? 11 : 12} strokeWidth={2} />
    </motion.span>
  );
  const trash = (
    <button
      className={
        (side ? ROW_ICON : "rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)]") +
        " ml-auto opacity-0 transition-opacity hover:text-[var(--diff-del)] group-hover/grp:opacity-100"
      }
      title="Delete group (its units stay)"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onDelete}
    >
      <Trash2 size={12} strokeWidth={1.6} />
    </button>
  );
  const title = (collapsed ? "Expand" : "Collapse") + " — drag to move the group";

  if (side) {
    // A label, not a row: dim text, count and chevron only on hover (shown
    // while collapsed so a closed group still reads as one).
    return (
      <div
        className="group/grp flex h-6 shrink-0 touch-none select-none items-center pr-0.5"
        onPointerDown={onGrab}
        onClickCapture={suppressClick}
      >
        <button
          className="flex min-w-0 items-center gap-1 pl-2.5 text-left text-[11.5px] text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
          onClick={onToggle}
          title={title}
        >
          <span className="truncate">{name}</span>
          <span
            className={
              "flex items-center gap-1 transition-opacity group-hover/grp:opacity-100 " +
              (collapsed ? "opacity-100" : "opacity-0")
            }
          >
            <span className="text-[10.5px]">{count}</span>
            {chevron}
          </span>
        </button>
        {trash}
      </div>
    );
  }
  return (
    <div
      className="group/grp mb-1.5 flex touch-none select-none items-center px-1"
      onPointerDown={onGrab}
      onClickCapture={suppressClick}
    >
      <button
        className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
        onClick={onToggle}
        title={title}
      >
        {chevron}
        <span className="truncate">{name}</span>
        <span className="font-normal normal-case tracking-normal">{count}</span>
      </button>
      {trash}
    </div>
  );
}
