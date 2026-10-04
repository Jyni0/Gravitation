import { useRef, useState } from "react";
import { Columns2, FolderOpen, GripVertical, Rows2, X } from "lucide-react";
import type { SshConn, SshServer } from "../core/types.i";
import { TerminalView } from "../views/TerminalView.p";
import { FilesView } from "../views/FilesView.p";
import { IconButton, OsLogo, cx } from "../components";
import {
  dividers,
  dropTarget,
  leaves,
  paneDrag,
  paneRects,
  registerPane,
  usePaneDrag,
  type DropZone,
  type Layout,
  type NodePath,
  type Rect,
} from "./splitLayout.u";

/** Space between panes, px (half on each side of a divider). */
const GAP = 3;
/** Pointer travel before a header press turns into a drag, px. */
const DRAG_START = 4;

/**
 * The open connections laid out side by side (Termius split view). Every
 * pane is positioned absolutely from the layout tree, so splitting, moving
 * or resizing never remounts the panes that stay — a file browser keeps its
 * folder, a terminal its screen. Drag a pane by its header (or a Connections
 * row from the sidebar) onto another pane: an edge splits it, the middle
 * swaps the two; dropped anywhere else it leaves the grid as its own tab.
 * Dividers drag to resize. Pane headers exist only in a grid — a single
 * connection fills the page like a plain tab.
 */
export function SplitWorkspace({
  layout,
  conns,
  servers,
  activeConn,
  onFocus,
  onDrop,
  onDetach,
  onRatio,
  onSplit,
  onClose,
  onSession,
  onOpenConn,
}: {
  layout: Layout;
  conns: SshConn[];
  servers: SshServer[];
  /** Focused pane (keyboard, scripts paste here). */
  activeConn: string | null;
  onFocus: (connId: string) => void;
  /** A connection was dropped on a pane. */
  onDrop: (connId: string, target: string, zone: DropZone) => void;
  /** A pane dropped outside every pane: out of the grid, into its own tab. */
  onDetach: (connId: string) => void;
  onRatio: (path: NodePath, ratio: number) => void;
  /** Opens a new connection of the same server next to this pane. */
  onSplit: (connId: string, dir: "row" | "col") => void;
  onClose: (connId: string) => void;
  onSession: (connId: string, sessionId: string | null) => void;
  onOpenConn: (serverId: string, kind: "terminal" | "sftp") => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = usePaneDrag();
  const target = drag ? dropTarget(drag.x, drag.y) : null;
  /** A divider is being dragged: panes ignore the pointer meanwhile. */
  const [resizing, setResizing] = useState<"row" | "col" | null>(null);
  const rects = paneRects(layout);
  const shown = leaves(layout);
  const split = shown.length > 1;

  const startResize = (e: React.PointerEvent, path: NodePath, dir: "row" | "col", box: Rect) => {
    e.preventDefault();
    const host = boxRef.current?.getBoundingClientRect();
    if (!host) return;
    setResizing(dir);
    const move = (ev: PointerEvent) => {
      const f =
        dir === "row"
          ? ((ev.clientX - host.left) / host.width - box.x) / box.w
          : ((ev.clientY - host.top) / host.height - box.y) / box.h;
      onRatio(path, f);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={boxRef}
      className={cx("relative min-h-0 flex-1 overflow-hidden", resizing && "select-none")}
      style={resizing ? { cursor: resizing === "row" ? "col-resize" : "row-resize" } : undefined}
    >
      {shown.map((connId) => {
        const r = rects.get(connId)!;
        const conn = conns.find((c) => c.id === connId);
        const server = conn && servers.find((s) => s.id === conn.serverId);
        // A single pane fills the page edge to edge, like a plain tab.
        const inset = split ? GAP : 0;
        return (
          <div
            key={connId}
            ref={(el) => registerPane(connId, el)}
            className={cx(
              "absolute flex min-h-0 min-w-0 flex-col overflow-hidden",
              split && "rounded-xl border",
              split && (activeConn === connId ? "border-[var(--accent)]/60" : "border-[var(--border-soft)]"),
              resizing && "pointer-events-none",
            )}
            style={{
              left: `calc(${r.x * 100}% + ${inset}px)`,
              top: `calc(${r.y * 100}% + ${inset}px)`,
              width: `calc(${r.w * 100}% - ${inset * 2}px)`,
              height: `calc(${r.h * 100}% - ${inset * 2}px)`,
            }}
            onPointerDownCapture={() => activeConn !== connId && onFocus(connId)}
          >
            {split && (
              <PaneHeader
                conn={conn}
                server={server}
                active={activeConn === connId}
                onSplit={(dir) => onSplit(connId, dir)}
                onClose={() => onClose(connId)}
                onDrop={onDrop}
                onDetach={onDetach}
              />
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {!conn || !server ? (
                <PaneGone onClose={() => onClose(connId)} />
              ) : conn.kind === "terminal" ? (
                <TerminalView
                  server={server}
                  connId={conn.id}
                  onSession={(sid) => onSession(conn.id, sid)}
                  onOpenFiles={() => onOpenConn(server.id, "sftp")}
                  onClose={() => onClose(conn.id)}
                />
              ) : (
                <FilesView
                  server={server}
                  onOpenTerminal={() => onOpenConn(server.id, "terminal")}
                  onClose={() => onClose(conn.id)}
                />
              )}
              {drag && target?.conn === connId && drag.conn !== connId && <DropPreview zone={target.zone} />}
            </div>
          </div>
        );
      })}

      {/* Dividers: a wide invisible grip over each split line. */}
      {dividers(layout).map((d) => {
        const row = d.dir === "row";
        const line = row ? d.box.x + d.box.w * d.at : d.box.y + d.box.h * d.at;
        return (
          <div
            key={d.path.join("") || "root"}
            className={cx(
              "group absolute z-20 flex items-center justify-center",
              row ? "cursor-col-resize" : "cursor-row-resize",
            )}
            style={
              row
                ? { left: `calc(${line * 100}% - 4px)`, width: 8, top: `${d.box.y * 100}%`, height: `${d.box.h * 100}%` }
                : { top: `calc(${line * 100}% - 4px)`, height: 8, left: `${d.box.x * 100}%`, width: `${d.box.w * 100}%` }
            }
            onPointerDown={(e) => startResize(e, d.path, d.dir, d.box)}
          >
            <div
              className={cx(
                "rounded-full bg-[var(--accent)] opacity-0 transition-opacity group-hover:opacity-60",
                row ? "h-10 w-[3px]" : "h-[3px] w-10",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The pane's strip: what it shows, split buttons, close. Pressing and moving
 * it drags the connection to another pane.
 */
function PaneHeader({
  conn,
  server,
  active,
  onSplit,
  onClose,
  onDrop,
  onDetach,
}: {
  conn: SshConn | undefined;
  server: SshServer | undefined;
  active: boolean;
  onSplit: (dir: "row" | "col") => void;
  onClose: () => void;
  onDrop: (connId: string, target: string, zone: DropZone) => void;
  onDetach: (connId: string) => void;
}) {
  const startDrag = (e: React.PointerEvent) => {
    if (!conn || e.button !== 0 || (e.target as Element).closest("button")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START) return;
      dragging = true;
      paneDrag.set({ conn: conn.id, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) return;
      const t = dropTarget(ev.clientX, ev.clientY);
      paneDrag.set(null);
      if (t) onDrop(conn.id, t.conn, t.zone);
      else onDetach(conn.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const sftp = conn?.kind === "sftp";
  return (
    <div
      className={cx(
        "flex h-8 shrink-0 cursor-grab select-none items-center gap-1.5 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] pl-1.5 pr-1 text-[12px] active:cursor-grabbing",
        active ? "text-[var(--text-main)]" : "text-[var(--text-muted)]",
      )}
      onPointerDown={startDrag}
      title="Drag onto another pane to split or swap — or out of the grid into its own tab"
    >
      <GripVertical size={12} className="shrink-0 text-[var(--text-dim)]" />
      {sftp ? (
        <FolderOpen size={14} strokeWidth={1.5} className="shrink-0 text-[var(--accent)]" />
      ) : server ? (
        <OsLogo os={server.os} seed={server.id} name={server.name} size={14} />
      ) : null}
      <span className="min-w-0 truncate font-medium">
        {sftp ? "SFTP " : ""}
        {server?.name ?? "server"}
      </span>
      {server && (
        <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--text-dim)]">
          {server.username}@{server.host}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center">
        <IconButton label="Split right" size="xs" onClick={() => onSplit("row")}>
          <Columns2 size={13} strokeWidth={1.6} />
        </IconButton>
        <IconButton label="Split down" size="xs" onClick={() => onSplit("col")}>
          <Rows2 size={13} strokeWidth={1.6} />
        </IconButton>
        <IconButton label="Close connection" size="xs" tone="danger" onClick={onClose}>
          <X size={13} strokeWidth={1.6} />
        </IconButton>
      </span>
    </div>
  );
}

/** Where the dragged connection will go: half of the pane, or all of it (swap). */
function DropPreview({ zone }: { zone: DropZone }) {
  const box: Record<DropZone, React.CSSProperties> = {
    left: { left: 0, top: 0, width: "50%", height: "100%" },
    right: { right: 0, top: 0, width: "50%", height: "100%" },
    top: { left: 0, top: 0, width: "100%", height: "50%" },
    bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
    center: { inset: 0 },
  };
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        className="absolute rounded-lg border-2 border-[var(--accent)] bg-[var(--accent)]/15 transition-all duration-100"
        style={box[zone]}
      />
    </div>
  );
}

/** A pane whose server was deleted. */
function PaneGone({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl border border-dashed border-[var(--border)] p-6 text-center">
        <div className="text-[13px] font-medium text-[var(--text-main)]">Server not found</div>
        <div className="mt-1 text-[12px] text-[var(--text-muted)]">This unit is no longer saved — it may have been deleted.</div>
        <button
          className="mt-3 h-7 rounded-lg border border-[var(--border)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={onClose}
        >
          Close pane
        </button>
      </div>
    </div>
  );
}
