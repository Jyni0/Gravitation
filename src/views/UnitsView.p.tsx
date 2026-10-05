import { motion, AnimatePresence } from "motion/react";
import {
  Server,
  KeyRound,
  FileCode2,
  Plus,
  Pencil,
  Trash2,
  X,
  ShieldAlert,
  Waypoints,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshKey, SshProxy, SshScript, SshServer, UnitsTab } from "../core/types.i";
import { OsLogo, Alert, Spinner, Button } from "../components";
import { UnitGroups } from "../layout/UnitGroups.c";

/**
 * Units — the SSH Client mode's home page: one grid, three collections.
 *
 * A segmented switcher (Servers / Credentials / Scripts) swaps the cards;
 * all three share one visual language: colored avatar + name + address +
 * actions. A server row opens the terminal page; edit/create and settings
 * live in the docked right-hand panel (SshPanel) — no dialogs.
 */
export function UnitsView({
  servers,
  keys,
  scripts,
  proxies,
  connected,
  busyIds,
  notice,
  vaultBacked,
  tab,
  onTab,
  onChanged,
  onEditUnit,
  onAddUnit,
  onConnect,
  onOpenTerminal,
  onReorder,
}: {
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  proxies: SshProxy[];
  connected: string[];
  busyIds: string[];
  notice?: string | null;
  /** True when the vault master key is safely persisted. */
  vaultBacked: boolean;
  tab: UnitsTab;
  onTab: (t: UnitsTab) => void;
  /** Reload the collections after a delete (saves happen inside SshPanel). */
  onChanged: () => void;
  /** Open the right-hand panel to edit a unit. */
  onEditUnit: (target: { kind: UnitKind; id: string }) => void;
  /** Open the right-hand panel to create a unit of the given kind. */
  onAddUnit: (kind: UnitKind) => void;
  onConnect: (id: string) => void;
  onOpenTerminal: (serverId: string) => void;
  /** A list was dragged into a new order (ids top to bottom). */
  onReorder: (kind: UnitKind, ids: string[]) => void;
}) {
  const TABS: { id: UnitsTab; label: string; icon: typeof Server; count: number }[] = [
    { id: "servers", label: "Servers", icon: Server, count: servers.length },
    { id: "keys", label: "Credentials", icon: KeyRound, count: keys.length },
    { id: "scripts", label: "Scripts", icon: FileCode2, count: scripts.length },
    { id: "proxies", label: "Proxies", icon: Waypoints, count: proxies.length },
  ];
  const kind = TAB_KIND[tab];
  const COUNT: Record<UnitsTab, number> = {
    servers: servers.length,
    keys: keys.length,
    scripts: scripts.length,
    proxies: proxies.length,
  };

  return (
    <motion.div
      className="mx-auto flex w-full max-w-[980px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {/* No navbar: the switcher IS the header; Add sits on its right. */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-fit gap-0.5 rounded-xl bg-[var(--bg-input)] p-[3px]">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              className={
                "relative flex h-full items-center gap-1.5 rounded-[9px] px-3 text-[12.5px] transition-colors " +
                (tab === t.id ? "text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]")
              }
              onClick={() => onTab(t.id)}
            >
              {tab === t.id && (
                <motion.span
                  layoutId="units-tab-pill"
                  className="absolute inset-0 rounded-[9px] bg-[var(--bg-elevated)] shadow-sm"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <Icon size={13} strokeWidth={1.8} className="relative z-10" />
              <span className="relative z-10">{t.label}</span>
              <span className="relative z-10 text-[10px] text-[var(--text-dim)]">{t.count}</span>
            </button>
          );
        })}
        </div>
        <Button icon={<Plus size={13} strokeWidth={2} />} onClick={() => onAddUnit(kind)}>
          {ADD_LABEL[kind]}
        </Button>
      </div>

      {notice && (
        <Alert className="mt-3" icon={<X size={13} />}>
          <span title={notice}>{notice}</span>
        </Alert>
      )}
      {tab === "keys" && !vaultBacked && (
        <Alert className="mt-3" icon={<ShieldAlert size={13} />}>
          The vault master key could not be persisted — stored secrets will
          only decrypt during this session. Fix OS keyring access to keep them.
        </Alert>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          className="mt-4"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.12 }}
        >
          {COUNT[tab] === 0 && <Empty kind={kind} />}

          {tab === "servers" && COUNT.servers > 0 && (
            <ServerGrid
              onChanged={onChanged}
              servers={servers}
              connected={connected}
              busyIds={busyIds}
              onConnect={onConnect}
              onOpenTerminal={onOpenTerminal}
              onReorder={(ids) => onReorder("server", ids)}
              onEdit={(s) => onEditUnit({ kind: "server", id: s.id })}
              onDelete={async (s) => {
                await db.deleteSshServer(s.id);
                onChanged();
              }}
            />
          )}

          {tab === "keys" && COUNT.keys > 0 && (
            <KeyGrid
              onChanged={onChanged}
              keys={keys}
              onReorder={(ids) => onReorder("key", ids)}
              onEdit={(k) => onEditUnit({ kind: "key", id: k.id })}
              onDelete={async (k) => {
                await db.deleteSshKey(k.id);
                onChanged();
              }}
            />
          )}

          {tab === "proxies" && COUNT.proxies > 0 && (
            <ProxyGrid
              onChanged={onChanged}
              proxies={proxies}
              servers={servers}
              onReorder={(ids) => onReorder("proxy", ids)}
              onEdit={(p) => onEditUnit({ kind: "proxy", id: p.id })}
              onDelete={async (p) => {
                await db.deleteSshProxy(p.id);
                onChanged();
              }}
            />
          )}

          {tab === "scripts" && COUNT.scripts > 0 && (
            <ScriptGrid
              onChanged={onChanged}
              scripts={scripts}
              onReorder={(ids) => onReorder("script", ids)}
              onEdit={(s) => onEditUnit({ kind: "script", id: s.id })}
              onDelete={async (s) => {
                await db.deleteSshScript(s.id);
                onChanged();
              }}
            />
          )}
        </motion.div>
      </AnimatePresence>

    </motion.div>
  );
}

type UnitKind = "server" | "key" | "script" | "proxy";

const TAB_KIND: Record<UnitsTab, UnitKind> = {
  servers: "server",
  keys: "key",
  scripts: "script",
  proxies: "proxy",
};

const ADD_LABEL: Record<UnitKind, string> = {
  server: "Add server",
  key: "Add credential",
  script: "Add script",
  proxy: "Add proxy",
};

/* ---------- Termius-style host rows ---------- */
/**
 * Visual language of Termius: a vertical list of rows instead of card
 * grids. Every unit gets a deterministic colored circular avatar (initial
 * letter, hue from the name hash), the name on top, the address/subtitle
 * under it in mono, and status + actions on the right edge. Servers,
 * credentials and scripts all share this row anatomy.
 */

const AVATAR_COLORS = [
  "#e06c75",
  "#e5c07b",
  "#98c379",
  "#56b6c2",
  "#61afef",
  "#c678dd",
  "#d19a66",
  "#be5046",
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ label, color, icon }: { label: string; color: string; icon?: typeof Server }) {
  const Icon = icon;
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {Icon ? <Icon size={16} strokeWidth={1.8} /> : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

const LIST_ROW = "group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--hover-bg)]";

const EMPTY: Record<UnitKind, { icon: typeof Server; title: string; text: string }> = {
  server: {
    icon: Server,
    title: "No servers yet",
    text: "Add a host to open terminals on it and browse its files over SFTP.",
  },
  key: {
    icon: KeyRound,
    title: "No credentials yet",
    text: "Generate a keypair right here or import a private key — servers sign in with it.",
  },
  script: {
    icon: FileCode2,
    title: "No scripts yet",
    text: "Save the commands you run often and paste them into any terminal in one click.",
  },
  proxy: {
    icon: Waypoints,
    title: "No proxies yet",
    text: "Add an HTTP or SOCKS5 proxy, then pick it in a server's settings to connect through it.",
  },
};

/** Bar widths of the ghost rows (name, subtitle) — uneven, like real names. */
const GHOST_ROWS: [number, number][] = [
  [38, 56],
  [28, 44],
  [46, 62],
  [32, 50],
];

/**
 * Empty collection: the list it will become, drawn as ghost rows that fade
 * into the page, with what the list is for on top. Adding is the button in
 * the header — nothing to click here.
 */
function Empty({ kind }: { kind: UnitKind }) {
  const { icon: Icon, title, text } = EMPTY[kind];
  return (
    <div className="flex flex-col items-center pt-8">
      <div className="text-[14px] font-medium text-[var(--text-main)]">{title}</div>
      <div className="mt-1 max-w-[380px] text-center text-[12.5px] leading-relaxed text-[var(--text-dim)]">
        {text} Use <span className="text-[var(--text-muted)]">{ADD_LABEL[kind]}</span> above.
      </div>
      <div
        aria-hidden
        className="mt-6 flex w-full max-w-[560px] select-none flex-col gap-2"
        style={{ maskImage: "linear-gradient(to bottom, black 10%, transparent 95%)" }}
      >
        {GHOST_ROWS.map(([name, sub], i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] px-3.5 py-2.5"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-input)] text-[var(--text-dim)]">
              <Icon size={15} strokeWidth={1.6} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="h-2.5 rounded-full bg-[var(--bg-input)]" style={{ width: name + "%" }} />
              <span className="h-2 rounded-full bg-[var(--bg-input)] opacity-70" style={{ width: sub + "%" }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Servers, in the user's own order: grab a row and drag it up or down.
 * Clicking a row connects (or opens the live terminal); edit and delete
 * appear on hover.
 */
function ServerGrid({
  onChanged,
  servers,
  connected,
  busyIds,
  onConnect,
  onOpenTerminal,
  onReorder,
  onEdit,
  onDelete,
}: {
  onChanged: () => void;
  servers: SshServer[];
  connected: string[];
  busyIds: string[];
  onConnect: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onEdit: (s: SshServer) => void;
  onDelete: (s: SshServer) => void;
}) {
  return (
    <UnitGroups kind="server" items={servers} variant="page" onReorder={onReorder} onChanged={onChanged}>
      {(s) => {
        const live = connected.includes(s.id);
        const busy = busyIds.includes(s.id);
        return (
            <div
              className={LIST_ROW + " cursor-pointer active:cursor-grabbing"}
              onClick={() => (live ? onOpenTerminal(s.id) : onConnect(s.id))}
              title={live ? "Open terminal — drag to reorder" : "Connect — drag to reorder"}
            >
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
                {/* OS logo when Rust detected the distro; initial avatar otherwise */}
                {s.os ? (
                  <OsLogo os={s.os} seed={s.id} name={s.name} size={36} />
                ) : (
                  <Avatar label={s.name} color={avatarColor(s.id)} icon={Server} />
                )}
                {busy && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
                    <Spinner size={16} className="text-white" />
                  </span>
                )}
                {/* Live dot on the avatar, Termius-style */}
                <span
                  className={
                    "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--bg-surface)] " +
                    (live ? "bg-[var(--diff-add,#4ec9b0)]" : "bg-[var(--text-dim)]")
                  }
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-[var(--text-main)]">{s.name}</span>
                <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                  {s.username}@{s.host}{s.port !== 22 ? ":" + s.port : ""}
                </span>
              </span>
              <span
                className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  title="Edit"
                  onClick={() => onEdit(s)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                  title="Delete"
                  onClick={() => onDelete(s)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
        );
      }}
    </UnitGroups>
  );
}

/* ---------- Credentials list ---------- */

function KeyGrid({
  onChanged,
  keys,
  onReorder,
  onEdit,
  onDelete,
}: {
  onChanged: () => void;
  keys: SshKey[];
  onReorder: (ids: string[]) => void;
  onEdit: (k: SshKey) => void;
  onDelete: (k: SshKey) => void;
}) {
  return (
    <UnitGroups kind="key" items={keys} variant="page" onReorder={onReorder} onChanged={onChanged}>
      {(k) => (
          <div className={LIST_ROW + " cursor-pointer"} onClick={() => onEdit(k)} title="Edit credential — drag to reorder">
            <Avatar label={k.name} color={avatarColor(k.id)} icon={KeyRound} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium text-[var(--text-main)]">{k.name}</span>
              </span>
              <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                {k.fingerprint || (k.has_key ? "fingerprint pending" : "no key body")}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  title="Edit"
                  onClick={() => onEdit(k)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                  title="Delete"
                  onClick={() => onDelete(k)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </span>
          </div>
      )}
    </UnitGroups>
  );
}

/* ---------- Scripts list ---------- */

/**
 * Saved scripts. They are not run from here: open a terminal on a server and
 * click the script in the sidebar — it is pasted into that terminal.
 */
function ScriptGrid({
  onChanged,
  scripts,
  onReorder,
  onEdit,
  onDelete,
}: {
  onChanged: () => void;
  scripts: SshScript[];
  onReorder: (ids: string[]) => void;
  onEdit: (s: SshScript) => void;
  onDelete: (s: SshScript) => void;
}) {
  return (
    <UnitGroups kind="script" items={scripts} variant="page" onReorder={onReorder} onChanged={onChanged}>
      {(s) => (
          <div className={LIST_ROW + " cursor-pointer"} onClick={() => onEdit(s)} title="Edit script — drag to reorder">
            <Avatar label={s.name} color={avatarColor(s.id)} icon={FileCode2} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-[var(--text-main)]">{s.name}</span>
              <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                {s.content.split("\n")[0]}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  title="Edit"
                  onClick={() => onEdit(s)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                  title="Delete"
                  onClick={() => onDelete(s)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </span>
          </div>
      )}
    </UnitGroups>
  );
}

/* ---------- Proxies list ---------- */

/** Saved proxies (HTTP / SOCKS5). A server picks one in its settings. */
function ProxyGrid({
  onChanged,
  proxies,
  servers,
  onReorder,
  onEdit,
  onDelete,
}: {
  onChanged: () => void;
  proxies: SshProxy[];
  servers: SshServer[];
  onReorder: (ids: string[]) => void;
  onEdit: (p: SshProxy) => void;
  onDelete: (p: SshProxy) => void;
}) {
  return (
    <UnitGroups kind="proxy" items={proxies} variant="page" onReorder={onReorder} onChanged={onChanged}>
      {(p) => {
        const users = servers.filter((s) => s.proxy_id === p.id).length;
        return (
          <div className={LIST_ROW + " cursor-pointer"} onClick={() => onEdit(p)} title="Edit proxy — drag to reorder">
            <Avatar label={p.name} color={avatarColor(p.id)} icon={Waypoints} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium text-[var(--text-main)]">{p.name}</span>
                <span className="shrink-0 rounded-md border border-[var(--border)] px-1 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--text-dim)]">
                  {p.kind === "socks5" ? "SOCKS5" : "HTTP"}
                </span>
              </span>
              <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                {p.username ? p.username + "@" : ""}
                {p.host}:{p.port}
                {users > 0 ? ` · ${users} server${users > 1 ? "s" : ""}` : ""}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  title="Edit"
                  onClick={() => onEdit(p)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                  title="Delete"
                  onClick={() => onDelete(p)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </span>
          </div>
        );
      }}
    </UnitGroups>
  );
}
