import { useState } from "react";
import { motion, AnimatePresence, Reorder } from "motion/react";
import {
  Server,
  ScrollText,
  Settings,
  Plus,
  KeyRound,
  FileCode2,
  TerminalSquare,
  FolderOpen,
  ChevronRight,
  LayoutGrid,
  X,
} from "lucide-react";
import type { SshConn, SshKey, SshScript, SshServer, UnitsTab, ViewKind } from "../core/types.i";
import { leaves, type ConnGroup } from "./splitLayout.u";
import { UnitGroups } from "./UnitGroups.c";
import { useDragOrder } from "../hooks/useDragOrder.h";
import { ROW_ICON, ScrollArea, OsLogo, NavItem, RowActions } from "../components";

/**
 * Sidebar of the SSH Client mode. Same anatomy as the Agent sidebar — nav
 * buttons on top, a collapsible tree below, Settings pinned at the bottom.
 * Four sections, all collapsing exactly like Projects does in the agent:
 *
 * * Connections — the open tabs: a terminal/SFTP connection on its own
 *   (SFTP rows read "SFTP {name}") or a split grid ("Grid of N"). Clicking a
 *   row shows it as it was left; dragging a single connection onto a pane
 *   splits that pane; the hover × closes the tab (and its PTY sessions).
 * * Servers / Credentials / Scripts — the saved unit collections; the gear
 *   opens the right-hand panel form, "+" creates.
 */
export function SshSidebar({
  width,
  startResize,
  servers,
  keys,
  scripts,
  conns,
  groups,
  activeGroup,
  connected,
  view,
  activePanel,
  onOpenConn,
  onSelectGroup,
  onCloseGroup,
  onReorderGroups,
  onOpenPanel,
  onReorder,
  onPasteScript,
  onShowView,
  onAdd,
  onOpenSettings,
  onUnitsChanged,
  onDragConn,
  onDropConn,
}: {
  width: number;
  startResize: (e: React.MouseEvent) => void;
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  /** Open connections (terminal + SFTP). */
  conns: SshConn[];
  /** The tabs they sit in — alone or split into a grid. */
  groups: ConnGroup[];
  /** Tab on screen (null when Units / Logs are). */
  activeGroup: string | null;
  /** Server ids with a live pooled connection (accent dot). */
  connected: string[];
  view: ViewKind;
  /** Row whose form is open in the right-hand panel (highlighted here). */
  activePanel: { kind: "server" | "key" | "script" | "proxy"; id?: string } | null;
  /** Focus the server's connection of this kind; fresh=true opens a new one. */
  onOpenConn: (serverId: string, kind: "terminal" | "sftp", fresh?: boolean) => void;
  onSelectGroup: (groupId: string) => void;
  /** Closes a tab — every connection of a grid. */
  onCloseGroup: (groupId: string) => void;
  onReorderGroups: (ids: string[]) => void;
  onOpenPanel: (target: { kind: "server" | "key" | "script"; id: string }) => void;
  /** A section was dragged into a new order (ids top to bottom). */
  onReorder: (kind: "server" | "key" | "script", ids: string[]) => void;
  /** Pastes a script into the terminal on screen; null when no terminal is. */
  onPasteScript: ((script: SshScript) => void) | null;
  onShowView: (v: "units" | "ssh-logs") => void;
  onAdd: (tab: UnitsTab) => void;
  onOpenSettings: () => void;
  /** Units changed from the sidebar (a group was deleted) — reload them. */
  onUnitsChanged: () => void;
  /** A Connections row is being dragged (pointer in viewport px)… */
  onDragConn: (connId: string, x: number, y: number) => void;
  /** …and was let go there — over a pane it lands in the split view. */
  onDropConn: (connId: string, x: number, y: number) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  /* Section collapse state — the same pattern as Projects in the agent sidebar. */
  const [open, setOpen] = useState<Record<string, boolean>>({
    connections: true,
    servers: true,
    keys: true,
    scripts: true,
  });
  const toggle = (name: string) => setOpen((prev) => ({ ...prev, [name]: !prev[name] }));

  /** Section header: label + count + hover chevron, optional "+" on the right. */
  const sectionHeader = (name: string, title: string, count: number, tab?: UnitsTab, addLabel?: string) => (
    <div className="group mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
      <button
        className="flex h-6 items-center gap-1 rounded-md text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
        onClick={() => toggle(name)}
        title={open[name] ? "Collapse" : "Expand"}
      >
        {title}
        <motion.span
          animate={{ rotate: open[name] ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="flex items-center opacity-0 transition-opacity group-hover:opacity-100"
        >
          <ChevronRight size={12} strokeWidth={2} />
        </motion.span>
      </button>
      {count ? "" : ""}
      {tab && (
        <span className="ml-auto flex items-center gap-2">
          <button
            className="flex items-center justify-center rounded-md p-0.5 text-[var(--text-muted)] opacity-60 transition-all hover:opacity-100"
            onClick={() => onAdd(tab)}
            title={addLabel}
          >
            <Plus size={14} strokeWidth={1.5} />
          </button>
        </span>
      )}
    </div>
  );

  /** Collapsible body of a section — exact copy of the Projects animation. */
  const sectionBody = (name: string, children: React.ReactNode) => (
    <AnimatePresence initial={false}>
      {open[name] && (
        <motion.div
          className="flex shrink-0 flex-col gap-0.5 overflow-hidden"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "server";
  /** The connection of a single-connection tab (grids are not dragged onto panes). */
  const soleConn = (groupId: string) => {
    const ids = leaves(groups.find((g) => g.id === groupId)?.layout ?? null);
    return ids.length === 1 ? ids[0] : null;
  };

  return (
    <aside
      className="selectable relative flex shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight"
      style={{ width: width + "px" }}
    >
      {/* Header: the two pages of this mode */}
      <div className="px-2.5 pt-3">
        <nav className="flex flex-col gap-2">
          <NavItem
            active={view === "units"}
            icon={<Server size={16} strokeWidth={1.5} className="shrink-0" />}
            onClick={() => onShowView("units")}
          >
            <span>Units</span>
          </NavItem>
          <NavItem
            active={view === "ssh-logs"}
            icon={<ScrollText size={16} strokeWidth={1.5} className="shrink-0" />}
            onClick={() => onShowView("ssh-logs")}
          >
            <span>Logs</span>
          </NavItem>
        </nav>
      </div>

      {/* Collections tree — same rows as conversations */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollArea
          className="min-h-0 flex-1"
          innerClassName="flex flex-col gap-0.5 px-2.5 pt-2 [&>*]:shrink-0"
        >
          {/* ---- Connections: every open terminal / SFTP page ---- */}
          {sectionHeader("connections", "Connections", groups.length)}
          {sectionBody(
            "connections",
            groups.length === 0 ? (
              <div className="shrink-0 px-2 py-1.5 text-center text-[12px] text-[var(--text-dim)]">
                No open connections.
              </div>
            ) : (
              <SideDragList
                items={groups}
                onReorder={onReorderGroups}
                onHover={(id) => setHovered(id && "grp-" + id)}
                onDragItem={(id, x, y) => {
                  const only = soleConn(id);
                  if (only) onDragConn(only, x, y);
                }}
                onDropItem={(id, x, y) => {
                  const only = soleConn(id);
                  if (only) onDropConn(only, x, y);
                }}
              >
              {(g) => {
                const ids = leaves(g.layout);
                const isActive = activeGroup === g.id;
                const isHover = hovered === "grp-" + g.id;
                const c = ids.length === 1 ? conns.find((x) => x.id === ids[0]) : undefined;
                const isSftp = c?.kind === "sftp";
                const srv = c && servers.find((x) => x.id === c.serverId);
                const label =
                  ids.length > 1
                    ? `Grid of ${ids.length}`
                    : c
                      ? (isSftp ? "SFTP " : "") + serverName(c.serverId)
                      : "Connection";
                return (
                  <>
                    <NavItem active={isActive} hovered={isHover} onClick={() => onSelectGroup(g.id)}>
                      {/* A grid shows the grid icon; a terminal the SERVER LOGO
                          (no console icon — it duplicated the logo); SFTP the
                          folder icon. */}
                      {ids.length > 1 ? (
                        <LayoutGrid size={18} strokeWidth={1.5} className="shrink-0 text-[var(--accent)]" />
                      ) : isSftp ? (
                        <FolderOpen size={18} strokeWidth={1.5} className="shrink-0 text-[var(--accent)]" />
                      ) : srv ? (
                        <OsLogo os={srv.os} seed={srv.id} name={srv.name} />
                      ) : (
                        <TerminalSquare size={18} strokeWidth={1.5} className="shrink-0 text-[var(--accent)]" />
                      )}
                      <span className="truncate">{label}</span>
                    </NavItem>
                    {/* Hover: close the tab (kills its PTY sessions). */}
                    <RowActions show={isHover}>
                      <button
                        className={ROW_ICON}
                        title={ids.length > 1 ? "Close the grid and its connections" : "Close connection"}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseGroup(g.id);
                        }}
                      >
                        <X size={13} strokeWidth={1.5} />
                      </button>
                    </RowActions>
                  </>
                );
              }}
              </SideDragList>
            )
          )}

          {/* ---- Servers ---- */}
          {sectionHeader("servers", "Servers", servers.length, "servers", "Add server")}
          {sectionBody(
            "servers",
            <UnitGroups kind="server" items={servers} variant="sidebar" onChanged={onUnitsChanged} onReorder={(ids) => onReorder("server", ids)} onHover={(id) => setHovered(id && "srv-" + id)}>
            {(s) => {
              const live = connected.includes(s.id);
              const panelActive = activePanel?.kind === "server" && activePanel.id === s.id;
              const hoverKey = "srv-" + s.id;
              const isHover = hovered === hoverKey;
              return (
                <>
                  <NavItem
                    active={panelActive}
                    hovered={isHover}
                    onClick={() => onOpenConn(s.id, "terminal", true)}
                  >
                    {/* OS logo (detected on connect) with a live dot */}
                    <span className="relative shrink-0">
                      <OsLogo os={s.os} seed={s.id} name={s.name} size={20} />
                      <span
                        className={
                          "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[var(--bg-sidebar)] " +
                          (live ? "bg-[var(--diff-add,#4ec9b0)]" : "bg-[var(--text-dim)]")
                        }
                        title={live ? "Connected" : "Idle"}
                      />
                    </span>
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--text-dim)]">
                      {s.host}
                    </span>
                  </NavItem>
                  {/* Hover actions: files + settings */}
                  <RowActions show={isHover}>
                    <button
                      className={ROW_ICON}
                      title="Open SFTP"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenConn(s.id, "sftp", true);
                      }}
                    >
                      <FolderOpen size={13} strokeWidth={1.5} />
                    </button>
                    <button
                      className={ROW_ICON}
                      title="Server settings"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPanel({ kind: "server", id: s.id });
                      }}
                    >
                      <Settings size={13} strokeWidth={1.5} />
                    </button>
                  </RowActions>
                </>
              );
            }}
            </UnitGroups>
          )}

          {/* ---- Credentials ---- */}
          {sectionHeader("keys", "Credentials", keys.length, "keys", "Add credential")}
          {sectionBody(
            "keys",
            <UnitGroups kind="key" items={keys} variant="sidebar" onChanged={onUnitsChanged} onReorder={(ids) => onReorder("key", ids)}>
            {(k) => {
              const active = activePanel?.kind === "key" && activePanel.id === k.id;
              return (
                <NavItem
                  active={active}
                  onClick={() => onOpenPanel({ kind: "key", id: k.id })}
                >
                  <KeyRound size={13} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate">{k.name}</span>
                  {k.fingerprint && (
                    <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--text-dim)]">
                      {k.fingerprint.slice(0, 16)}
                    </span>
                  )}
                </NavItem>
              );
            }}
            </UnitGroups>
          )}

          {/* ---- Scripts ---- */}
          {sectionHeader("scripts", "Scripts", scripts.length, "scripts", "Add script")}
          {sectionBody(
            "scripts",
            <UnitGroups kind="script" items={scripts} variant="sidebar" onChanged={onUnitsChanged} onReorder={(ids) => onReorder("script", ids)} onHover={(id) => setHovered(id && "script:" + id)}>
            {(s) => {
              const active = activePanel?.kind === "script" && activePanel.id === s.id;
              const rowKey = "script:" + s.id;
              return (
                <>
                  <NavItem
                    active={active}
                    // With a terminal on screen the script is pasted into it;
                    // otherwise the click opens the script's form.
                    onClick={() =>
                      onPasteScript ? onPasteScript(s) : onOpenPanel({ kind: "script", id: s.id })
                    }
                    title={onPasteScript ? "Paste into the terminal" : "Open a terminal to paste this script — click to edit"}
                  >
                    <FileCode2 size={13} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate">{s.name}</span>
                  </NavItem>
                  <RowActions show={hovered === rowKey}>
                    <button
                      className={ROW_ICON}
                      title="Edit script"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPanel({ kind: "script", id: s.id });
                      }}
                    >
                      <Settings size={13} strokeWidth={1.5} />
                    </button>
                  </RowActions>
                </>
              );
            }}
            </UnitGroups>
          )}

          <div className="h-2 shrink-0" />
        </ScrollArea>
      </div>

      {/* Footer: Settings, like the Agent sidebar */}
      <div className="mt-auto shrink-0 px-2.5 pb-3 pt-1">
        <NavItem icon={<Settings size={16} strokeWidth={1.5} className="shrink-0" />} onClick={onOpenSettings}>
          <span>Settings</span>
        </NavItem>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} />
    </aside>
  );
}

/**
 * A sidebar section in the user's own order: grab a row and drag it up or
 * down (no buttons). A drop never counts as a click on the row. With
 * onDragItem/onDropItem the pointer is reported too (rows dragged out of the
 * sidebar onto the split view).
 */
function SideDragList<T extends { id: string }>({
  items,
  onReorder,
  onHover,
  onDragItem,
  onDropItem,
  children,
}: {
  items: T[];
  onReorder: (ids: string[]) => void;
  /** Row hover in/out (null = left), for the rows' hover actions. */
  onHover?: (id: string | null) => void;
  onDragItem?: (id: string, x: number, y: number) => void;
  onDropItem?: (id: string, x: number, y: number) => void;
  children: (item: T) => React.ReactNode;
}) {
  const drag = useDragOrder(items, onReorder);
  return (
    <Reorder.Group axis="y" values={drag.order} onReorder={drag.setOrder} as="div" className="flex flex-col gap-0.5">
      {drag.order.map((item) => (
        <Reorder.Item
          key={item.id}
          value={item}
          as="div"
          className="relative shrink-0 select-none rounded-xl"
          onDragStart={drag.onDragStart}
          onDrag={onDragItem && ((_, info) => onDragItem(item.id, info.point.x, info.point.y))}
          onDragEnd={(_, info) => {
            drag.onDragEnd();
            onDropItem?.(item.id, info.point.x, info.point.y);
          }}
          onClickCapture={drag.suppressClick}
          whileDrag={{ scale: 1.03, zIndex: 10, backgroundColor: "var(--row-solid-hover)" }}
          onMouseEnter={() => onHover?.(item.id)}
          onMouseLeave={() => onHover?.(null)}
        >
          {children(item)}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}
