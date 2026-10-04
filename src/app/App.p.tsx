import { useState, useEffect, useRef, useCallback } from "react";
import { AnimatePresence } from "motion/react";
import * as db from "../core/db.r";
import type { SshConn, SshKey, SshProxy, SshScript, SshServer, Theme, UnitsTab, ViewKind } from "../core/types.i";
import { THEMES } from "../core/types.i";
import { useBlockContextMenu } from "../hooks/useBlockContextMenu.h";
import { TitleBar } from "../layout/TitleBar.c";
import { SshSidebar } from "../layout/SshSidebar.c";
import { UnitsView } from "../views/UnitsView.p";
import { SshLogsView } from "../views/SshLogsView.p";
import { forgetConnSession, pasteIntoConn } from "../views/TerminalView.p";
import { SplitWorkspace } from "../layout/SplitWorkspace.c";
import { dropConn, leaf, leaves, paneDrag, dropTarget, removeConn, setRatio } from "../layout/splitLayout.u";
import type { ConnGroup, DropZone, NodePath } from "../layout/splitLayout.u";
import { SshPanel } from "../layout/SshPanel.c";
import type { SshPanelTarget } from "../layout/SshPanel.c";
import { SettingsModal } from "../settings/SettingsModal.c";
import { ScrollArea, cx } from "../components";

/** Right-hand panel width bounds, px. */
const PANEL_MIN_W = 260;
const PANEL_MAX_W = 720;

export default function App() {
  // No default browser context menu anywhere in the window.
  useBlockContextMenu();
  const [sidebarWidth, setSidebarWidth] = useState(240);
  /** View → Hide Sidebar (Ctrl+B); remembered across launches. */
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem("dsh:sidebar-hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarHidden((h) => {
      try {
        localStorage.setItem("dsh:sidebar-hidden", h ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !h;
    });
  }, []);
  const [theme, setThemeState] = useState<Theme>("dark");
  /** Every settings edit is persisted, so edits survive a relaunch. */
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    void db.setSetting("theme", t);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** False until the first DB read finishes. */
  const [persistent, setPersistent] = useState(false);
  const [view, setView] = useState<ViewKind>("units");

  const [sshServers, setSshServers] = useState<SshServer[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  /** Saved proxies — Units page only (not in the sidebar). */
  const [sshProxies, setSshProxies] = useState<SshProxy[]>([]);
  const [sshScripts, setSshScripts] = useState<SshScript[]>([]);
  const [sshConnectedIds, setSshConnectedIds] = useState<string[]>([]);
  const [sshBusyIds, setSshBusyIds] = useState<string[]>([]);
  const [sshNotice, setSshNotice] = useState<string | null>(null);
  /** True when the vault master key is safely persisted (OS keyring/file). */
  const [sshVaultBacked, setSshVaultBacked] = useState(true);
  /** Which Units collection the switcher shows. */
  const [unitsTab, setUnitsTab] = useState<UnitsTab>("servers");
  /**
   * Open connection pages — Termius-style tabs. One server can have many
   * (each terminal click opens a NEW PTY session; each SFTP page is its own
   * entry). The sidebar's Connections section lists them; closing a row
   * closes the page and kills its PTY session.
   */
  const [sshConns, setSshConns] = useState<SshConn[]>([]);
  /** Focused connection (the pane that takes keys and pasted scripts). */
  const [activeConn, setActiveConn] = useState<string | null>(null);
  /**
   * Every open connection sits in exactly one group: alone (a plain tab) or
   * with others in a split grid. A group keeps its arrangement while another
   * one is on screen — coming back shows it exactly as it was left.
   */
  const [groups, setGroups] = useState<ConnGroup[]>([]);
  /** The group on screen. */
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  /** Width of the docked right-hand panel (drag-resized). */
  const [sshPanelWidth, setSshPanelWidth] = useState(400);
  /** True while the panel's left edge is being dragged — disables the width
   *  animation so the panel tracks the cursor exactly. */
  const [sshPanelResizing, setSshPanelResizing] = useState(false);
  /**
   * The docked right-hand panel: create / edit / settings forms live here
   * instead of dialogs (Termius-style). Null = closed.
   */
  const [sshPanel, setSshPanel] = useState<SshPanelTarget | null>(null);

  // Adaptive re-clamp: shrinking the window (or growing the sidebar) must
  // never leave the panel wider than the space that remains — otherwise the
  // main column is squeezed off-screen. Caps the panel to window − sidebar −
  // 320px of usable main area.
  useEffect(() => {
    const onResize = () => {
      const maxW = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320));
      setSshPanelWidth((w) => (w > maxW ? maxW : w));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sidebarWidth]);

  /** Set once boot has restored the page, so the initial state isn't saved over it. */
  const bootedRef = useRef(false);

  // Remember the last page — the next launch reopens it.
  useEffect(() => {
    if (!bootedRef.current) return;
    localStorage.setItem("dsh:last-view:ssh", view);
  }, [view]);

  /* ---------- Units ---------- */

  /**
   * A list was dragged into a new order: show it at once, then persist.
   * Open connections are session-only, so their order is not stored.
   */
  const reorderSsh = useCallback((kind: "server" | "key" | "script" | "proxy", ids: string[]) => {
    const sortBy = <T extends { id: string }>(cur: T[]): T[] => {
      const byId = new Map(cur.map((x) => [x.id, x]));
      const moved = ids.map((id) => byId.get(id)).filter((x): x is T => !!x);
      return [...moved, ...cur.filter((x) => !ids.includes(x.id))];
    };
    if (kind === "server") setSshServers(sortBy);
    else if (kind === "key") setSshKeys(sortBy);
    else if (kind === "proxy") setSshProxies(sortBy);
    else setSshScripts(sortBy);
    void db.reorderSshUnits(kind, ids).catch(() => {
      void db.loadSshServers().then(setSshServers).catch(() => {});
      void db.loadSshKeys().then(setSshKeys).catch(() => {});
      void db.loadSshProxies().then(setSshProxies).catch(() => {});
      void db.loadSshScripts().then(setSshScripts).catch(() => {});
    });
  }, []);

  const reloadSshServers = useCallback(() => {
    void db.loadSshServers().then(setSshServers).catch(() => {});
    void db.loadSshKeys().then(setSshKeys).catch(() => {});
    void db.loadSshProxies().then(setSshProxies).catch(() => {});
    void db.loadSshScripts().then(setSshScripts).catch(() => {});
    void db.sshConnected().then(setSshConnectedIds).catch(() => {});
    void db.sshVaultBacked().then(setSshVaultBacked).catch(() => {});
  }, []);

  // Load units once, then track live status/log events pushed by Rust.
  useEffect(() => {
    reloadSshServers();
    let off: (() => void) | undefined;
    void db
      .onSshEvent({
        onStatus: (ids) => setSshConnectedIds(ids),
        onLogged: () => {},
        // A connect just detected the remote OS — patch the row in place so
        // the logo appears without a full reload.
        onOs: ([serverId, os]) => setSshServers((prev) => prev.map((s) => (s.id === serverId ? { ...s, os } : s))),
      })
      .then((fn) => {
        off = fn;
      });
    return () => off?.();
  }, [reloadSshServers]);

  // Mirrors of the connection state for the handlers below: state updaters
  // must stay pure (React StrictMode runs them twice), so reads go through refs.
  const sshConnsRef = useRef<SshConn[]>([]);
  sshConnsRef.current = sshConns;
  const activeConnRef = useRef<string | null>(null);
  activeConnRef.current = activeConn;
  const groupsRef = useRef<ConnGroup[]>([]);
  groupsRef.current = groups;
  const activeGroupRef = useRef<string | null>(null);
  activeGroupRef.current = activeGroup;

  const commitGroups = (next: ConnGroup[]) => {
    groupsRef.current = next;
    setGroups(next);
  };
  const groupOf = (connId: string) => groupsRef.current.find((g) => leaves(g.layout).includes(connId));
  const uid = (prefix: string) => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

  /** Shows a group as it was left; `focus` picks the pane (else the last focused one in it). */
  const showGroup = useCallback((groupId: string, focus?: string) => {
    const g = groupsRef.current.find((x) => x.id === groupId);
    if (!g) return;
    const shown = leaves(g.layout);
    const keep = focus ?? (shown.includes(activeConnRef.current ?? "") ? activeConnRef.current! : g.focus ?? shown[0]);
    setActiveGroup(groupId);
    setActiveConn(keep);
    setView("ssh-session");
  }, []);

  /** Pane focus inside the group on screen — remembered for coming back. */
  const focusConn = useCallback((connId: string) => {
    setActiveConn(connId);
    commitGroups(groupsRef.current.map((g) => (leaves(g.layout).includes(connId) ? { ...g, focus: connId } : g)));
  }, []);

  const newConn = (serverId: string, kind: "terminal" | "sftp"): string => {
    const id = uid("conn");
    const next = [...sshConnsRef.current, { id, serverId, kind }];
    sshConnsRef.current = next;
    setSshConns(next);
    return id;
  };

  /**
   * Open (or show) a connection. fresh=true always opens a NEW connection
   * (a second terminal on the same server gets its own PTY) as its own tab —
   * grids on other tabs stay as they are; otherwise an existing one of the
   * same server+kind is shown with its group.
   */
  const openSshConn = useCallback((serverId: string, kind: "terminal" | "sftp", fresh = false) => {
    const existing = !fresh && sshConnsRef.current.find((c) => c.serverId === serverId && c.kind === kind);
    if (existing) {
      const g = groupOf(existing.id);
      if (g) return showGroup(g.id, existing.id);
    }
    const id = existing ? existing.id : newConn(serverId, kind);
    const g: ConnGroup = { id: uid("grp"), layout: leaf(id) };
    commitGroups([...groupsRef.current, g]);
    showGroup(g.id, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGroup]);

  /** A new connection of the pane's server right of / below it, in the same grid. */
  const splitConn = useCallback((connId: string, dir: "row" | "col") => {
    const c = sshConnsRef.current.find((x) => x.id === connId);
    if (!c) return;
    const id = newConn(c.serverId, c.kind);
    const zone = dir === "row" ? "right" : "bottom";
    commitGroups(
      groupsRef.current.map((g) =>
        leaves(g.layout).includes(connId) ? { ...g, layout: dropConn(g.layout, id, connId, zone), focus: id } : g
      )
    );
    setActiveConn(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A connection dropped on a pane: an edge splits that pane, the middle
   * swaps the two. A connection from another group (a tab, or a pane of
   * another grid) moves into this grid.
   */
  const dropOnPane = useCallback((connId: string, target: string, zone: DropZone) => {
    const into = groupOf(target);
    if (!into || connId === target) return;
    const next = groupsRef.current
      .map((g) => {
        if (g.id === into.id) return { ...g, layout: dropConn(g.layout, connId, target, zone), focus: connId };
        if (!leaves(g.layout).includes(connId)) return g;
        const rest = removeConn(g.layout, connId);
        return rest ? { ...g, layout: rest, focus: undefined } : null;
      })
      .filter((g): g is ConnGroup => !!g);
    commitGroups(next);
    showGroup(into.id, connId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGroup]);

  /** A pane dragged out of its grid (dropped outside any pane): it becomes its own tab. */
  const detachConn = useCallback((connId: string) => {
    const from = groupOf(connId);
    if (!from || leaves(from.layout).length < 2) return;
    const rest = removeConn(from.layout, connId)!;
    const at = groupsRef.current.findIndex((g) => g.id === from.id);
    const next = [...groupsRef.current];
    next[at] = { ...from, layout: rest, focus: leaves(rest)[0] };
    next.splice(at + 1, 0, { id: uid("grp"), layout: leaf(connId) });
    commitGroups(next);
    setActiveConn(leaves(rest)[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resizeSplit = useCallback((path: NodePath, ratio: number) => {
    const id = activeGroupRef.current;
    commitGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, layout: setRatio(g.layout, path, ratio) } : g)));
  }, []);

  /** Drops connections from their groups; an emptied group goes, and when it
   *  was on screen the previous tab takes its place (none left: Units). */
  const dropConnsFromGroups = (ids: string[]) => {
    const before = groupsRef.current;
    const next = before
      .map((g) => {
        let l: ConnGroup["layout"] | null = g.layout;
        for (const id of ids) l = removeConn(l, id);
        return l === g.layout ? g : l ? { ...g, layout: l, focus: leaves(l)[0] } : null;
      })
      .filter((g): g is ConnGroup => !!g);
    commitGroups(next);
    const shown = activeGroupRef.current;
    if (!shown) return;
    const still = next.find((g) => g.id === shown);
    if (still) {
      if (ids.includes(activeConnRef.current ?? "")) setActiveConn(still.focus ?? leaves(still.layout)[0]);
      return;
    }
    const idx = before.findIndex((g) => g.id === shown);
    const neighbor = next[Math.max(0, Math.min(idx - 1, next.length - 1))];
    if (neighbor) {
      setActiveGroup(neighbor.id);
      setActiveConn(neighbor.focus ?? leaves(neighbor.layout)[0]);
    } else {
      setActiveGroup(null);
      setActiveConn(null);
      setView((v) => (v === "ssh-session" ? "units" : v));
    }
  };

  /** Close connections: kill their PTY sessions and drop their panes. */
  const closeConns = useCallback((ids: string[]) => {
    const dying = sshConnsRef.current.filter((x) => ids.includes(x.id));
    if (!dying.length) return;
    for (const c of dying) {
      if (c.sessionId) void db.sshShellClose(c.sessionId).catch(() => {});
      forgetConnSession(c.id);
    }
    const next = sshConnsRef.current.filter((x) => !ids.includes(x.id));
    sshConnsRef.current = next;
    setSshConns(next);
    dropConnsFromGroups(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closeSshConn = useCallback((connId: string) => closeConns([connId]), [closeConns]);

  /** Sidebar row × : the tab, or the whole grid. */
  const closeGroup = useCallback(
    (groupId: string) => {
      const g = groupsRef.current.find((x) => x.id === groupId);
      if (g) closeConns(leaves(g.layout));
    },
    [closeConns]
  );

  /** Sidebar Connections rows dragged into a new order. */
  const reorderGroups = useCallback((ids: string[]) => {
    const byId = new Map(groupsRef.current.map((g) => [g.id, g]));
    commitGroups(ids.map((id) => byId.get(id)).filter((g): g is ConnGroup => !!g));
  }, []);

  /** A tab row of the sidebar dragged out over a pane. */
  const dragConnRow = useCallback((connId: string, x: number, y: number) => {
    paneDrag.set({ conn: connId, x, y });
  }, []);
  const dropConnRow = useCallback(
    (connId: string, x: number, y: number) => {
      const t = dropTarget(x, y);
      paneDrag.set(null);
      if (t) dropOnPane(connId, t.conn, t.zone);
    },
    [dropOnPane]
  );

  // A server deleted anywhere (panel, another window) drops its connections.
  useEffect(() => {
    setSshConns((prev) => {
      if (prev.length === 0) return prev;
      const alive = prev.filter((c) => sshServers.some((s) => s.id === c.serverId));
      if (alive.length === prev.length) return prev;
      const gone = prev.filter((c) => !alive.includes(c));
      for (const c of gone) {
        if (c.sessionId) void db.sshShellClose(c.sessionId).catch(() => {});
        forgetConnSession(c.id);
      }
      sshConnsRef.current = alive;
      dropConnsFromGroups(gone.map((c) => c.id));
      return alive;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshServers]);

  const setSshBusy = (id: string, busy: boolean) =>
    setSshBusyIds((prev) => (busy ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const connectServer = useCallback((id: string) => {
    setSshBusy(id, true);
    setSshNotice(null);
    db.sshConnect(id)
      .then(() => db.sshConnected())
      .then(setSshConnectedIds)
      .catch((e) => setSshNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setSshBusy(id, false));
  }, []);

  /** "New …" from the sidebar or the File menu: the Units page + an empty form. */
  const addUnit = useCallback((tab: UnitsTab) => {
    setUnitsTab(tab);
    setView("units");
    setSshPanel({
      kind: tab === "servers" ? "server" : tab === "keys" ? "key" : tab === "proxies" ? "proxy" : "script",
    });
  }, []);

  /* ---------- Boot: settings from SQLite ---------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [persist, savedTheme, savedPanelW] = await Promise.all([
        db.isPersistent(),
        db.getSetting("theme"),
        db.getSetting("ssh_panel_width"),
      ]);
      if (cancelled) return;
      if (savedPanelW) {
        const w = Number(savedPanelW);
        if (Number.isFinite(w)) {
          // Clamp against the ACTUAL window: a width saved on a big monitor
          // must never push the main column off-screen on a smaller one.
          const maxW = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320));
          setSshPanelWidth(Math.min(Math.max(w, PANEL_MIN_W), maxW));
        }
      }
      if (savedTheme && THEMES.includes(savedTheme as Theme)) setThemeState(savedTheme as Theme);
      setPersistent(persist);
      // First launch: the units saved in Singularity come over once.
      if (persist) {
        const imported = await db.importFromSingularity().catch(() => 0);
        if (imported > 0 && !cancelled) {
          reloadSshServers();
          const [t, w] = await Promise.all([db.getSetting("theme"), db.getSetting("ssh_panel_width")]);
          if (t && THEMES.includes(t as Theme)) setThemeState(t as Theme);
          if (w && Number.isFinite(Number(w))) setSshPanelWidth(Math.min(Math.max(Number(w), PANEL_MIN_W), PANEL_MAX_W));
        }
      }
      // Terminal/files tabs don't survive a restart — those land on Units.
      if (localStorage.getItem("dsh:last-view:ssh") === "ssh-logs") setView("ssh-logs");
      bootedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.min(Math.max(startW + ev.clientX - startX, 220), 480));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /**
   * Drag-resize of the right-hand panel: handle on the LEFT edge, dragging
   * left grows it, the width reached at mouse-up is persisted.
   */
  const startSshPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sshPanelWidth;
    // Never wider than the window minus the left sidebar and a usable main column.
    const maxW = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320));
    let latest = startW;
    // While dragging, the open/close width animation is switched OFF so the
    // panel follows the cursor 1:1 instead of lagging behind it.
    setSshPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(Math.max(startW - (ev.clientX - startX), PANEL_MIN_W), maxW);
      setSshPanelWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSshPanelResizing(false);
      void db.setSetting("ssh_panel_width", String(latest));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        onNewServer={() => addUnit("servers")}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleSidebar={toggleSidebar}
        sidebarHidden={sidebarHidden}
      />
      {/* overflow-hidden: the row must never scroll — a focus jump into the
          right-hand panel used to shift the whole page sideways. */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--bg-sidebar)]">
        {!sidebarHidden && (
          <SshSidebar
            width={sidebarWidth}
            startResize={startResize}
            servers={sshServers}
            keys={sshKeys}
            scripts={sshScripts}
            conns={sshConns}
            groups={groups}
            activeGroup={view === "ssh-session" ? activeGroup : null}
            connected={sshConnectedIds}
            view={view}
            activePanel={sshPanel}
            onOpenConn={openSshConn}
            onSelectGroup={showGroup}
            onCloseGroup={closeGroup}
            onReorderGroups={reorderGroups}
            onOpenPanel={setSshPanel}
            onReorder={reorderSsh}
            onPasteScript={
              view === "ssh-session" && activeConn && sshConns.find((c) => c.id === activeConn)?.kind === "terminal"
                ? (script) => void pasteIntoConn(activeConn, script.content)
                : null
            }
            onDragConn={dragConnRow}
            onDropConn={dropConnRow}
            onShowView={setView}
            onAdd={addUnit}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}

        <div
          className={cx(
            "flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-app)]",
            // The page sits in the corner between the sidebar and the title
            // bar like a sheet: rounded top-left, a hairline along both edges.
            !sidebarHidden && "rounded-tl-2xl border-l border-t border-[var(--border-soft)]",
          )}
        >
          {view === "units" && (
            <ScrollArea className="flex-1" innerClassName="py-4">
              <div className="px-6">
                <UnitsView
                  servers={sshServers}
                  keys={sshKeys}
                  scripts={sshScripts}
                  proxies={sshProxies}
                  connected={sshConnectedIds}
                  busyIds={sshBusyIds}
                  notice={sshNotice}
                  vaultBacked={sshVaultBacked}
                  tab={unitsTab}
                  onTab={setUnitsTab}
                  onChanged={reloadSshServers}
                  onEditUnit={(t) => setSshPanel(t)}
                  onAddUnit={(kind) => setSshPanel({ kind })}
                  onConnect={connectServer}
                  onOpenTerminal={(id) => openSshConn(id, "terminal", true)}
                  onReorder={reorderSsh}
                />
              </div>
            </ScrollArea>
          )}

          {view === "ssh-logs" && (
            <ScrollArea className="flex-1" innerClassName="py-4">
              <div className="px-6">
                <SshLogsView />
              </div>
            </ScrollArea>
          )}

          {/* Open connections, split side by side / stacked (Termius split view). */}
          {view === "ssh-session" &&
            (() => {
              const g = groups.find((x) => x.id === activeGroup);
              if (!g) return null;
              return (
                <SplitWorkspace
                  layout={g.layout}
                  conns={sshConns}
                  servers={sshServers}
                  activeConn={activeConn}
                  onFocus={focusConn}
                  onDrop={dropOnPane}
                  onDetach={detachConn}
                  onRatio={resizeSplit}
                  onSplit={splitConn}
                  onClose={closeSshConn}
                  onSession={(connId, sid) =>
                    setSshConns((prev) => prev.map((c) => (c.id === connId ? { ...c, sessionId: sid ?? undefined } : c)))
                  }
                  onOpenConn={(serverId, kind) => openSshConn(serverId, kind, true)}
                />
              );
            })()}
        </div>

        {/* Create/edit/settings dock in a right-hand panel — Termius-style, no dialogs. */}
        <AnimatePresence>
          {sshPanel && (
            <SshPanel
              target={sshPanel}
              servers={sshServers}
              keys={sshKeys}
              scripts={sshScripts}
              proxies={sshProxies}
              width={sshPanelWidth}
              resizing={sshPanelResizing}
              onResizeStart={startSshPanelResize}
              onChanged={reloadSshServers}
              onClose={() => setSshPanel(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {settingsOpen && (
            <SettingsModal
              theme={theme}
              onTheme={setTheme}
              persistent={persistent}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
