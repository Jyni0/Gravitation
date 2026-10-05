/**
 * Gravitation — persistence layer (frontend side).
 *
 * Everything the workspace needs to survive a restart lives in SQLite through
 * `tauri-plugin-sql`. Outside Tauri (plain `vite dev` in a browser) the same API
 * transparently falls back to an in-memory store, so the UI always boots.
 */
import type { SftpEntry, SshKey, SshProxy, SshLog, SshScript, SshServer } from "./types.i";

/** Shape returned by the in-memory fallback, mirroring the SQL rows. */
interface MemoryStore {
  settings: Record<string, string>;
  sshServers: SshServer[];
  sshKeys: SshKey[];
  sshScripts: SshScript[];
  sshProxies: SshProxy[];
  sshLogs: SshLog[];
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ---------- In-memory fallback (browser dev) ---------- */

const memory: MemoryStore = {
  settings: {},
  sshServers: [],
  sshKeys: [],
  sshScripts: [],
  sshProxies: [],
  sshLogs: [],
};

const memId = () => `mem-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- Connection ---------- */

type SqlDb = {
  select: <T>(query: string, bindValues?: unknown[]) => Promise<T>;
  execute: (query: string, bindValues?: unknown[]) => Promise<unknown>;
};

let dbPromise: Promise<SqlDb | null> | null = null;

async function getDb(): Promise<SqlDb | null> {
  if (!inTauri) return null;
  if (!dbPromise) {
    dbPromise = (async () => {
      const mod = await import("@tauri-apps/plugin-sql");
      return (await mod.default.load("sqlite:gravitation.db")) as unknown as SqlDb;
    })().catch((e) => {
      console.error("[db] cannot open database, falling back to memory:", e);
      return null;
    });
  }
  return dbPromise;
}

/** True when the real database is in use (as opposed to the memory fallback). */
export async function isPersistent(): Promise<boolean> {
  return (await getDb()) !== null;
}

/* ---------- Settings ---------- */

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return memory.settings[key] ?? null;
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.settings[key] = value;
    return;
  }
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

/* ---------- SSH Client mode ----------
   Servers / keys / scripts are managed through Rust commands (ssh.rs):
   secrets are AES-256-GCM encrypted at rest (vault.rs, master key in the
   OS credential store) and listings come back with secrets blanked — the
   webview never sees stored credentials after a save. Only the audit log
   (no secrets) is read directly through the SQL plugin. */

/* Rust serde payloads are camelCase; map to/from the TS snake_case shape. */
interface RustServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: string;
  password?: string;
  privateKey?: string;
  keyId?: string;
  hostKey?: string;
  hasPassword?: boolean;
  os?: string;
  proxyId?: string;
  group?: string;
}

function toServer(r: RustServer): SshServer {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port || 22,
    username: r.username || "root",
    auth: r.auth === "key" || r.auth === "cred" ? r.auth : "password",
    password: r.password ?? "",
    private_key: r.privateKey ?? "",
    key_id: r.keyId ?? "",
    host_key: r.hostKey ?? "",
    has_password: !!r.hasPassword,
    os: r.os ?? "",
    proxy_id: r.proxyId ?? "",
    group: r.group ?? "",
  };
}

function toRustServer(s: SshServer): RustServer {
  return {
    id: s.id ?? "",
    name: s.name,
    host: s.host,
    port: s.port || 22,
    username: s.username || "root",
    auth: s.auth,
    password: s.password ?? "",
    privateKey: s.private_key ?? "",
    keyId: s.key_id ?? "",
    hostKey: s.host_key ?? "",
    proxyId: s.proxy_id ?? "",
    group: s.group ?? "",
  };
}

interface RustKey {
  id: string;
  name: string;
  privateKey?: string;
  passphrase?: string;
  hasKey?: boolean;
  fingerprint?: string;
  comment?: string;
  publicKey?: string;
  group?: string;
}

function toKey(r: RustKey): SshKey {
  return {
    id: r.id,
    name: r.name,
    private_key: r.privateKey ?? "",
    passphrase: r.passphrase ?? "",
    has_key: !!r.hasKey,
    fingerprint: r.fingerprint ?? "",
    comment: r.comment ?? "",
    public_key: r.publicKey ?? "",
    group: r.group ?? "",
  };
}

function toRustKey(k: SshKey): RustKey {
  return {
    id: k.id ?? "",
    name: k.name,
    privateKey: k.private_key ?? "",
    passphrase: k.passphrase ?? "",
    hasKey: k.has_key,
    fingerprint: k.fingerprint ?? "",
    comment: k.comment ?? "",
    publicKey: k.public_key ?? "",
    group: k.group ?? "",
  };
}

async function sshInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!inTauri) throw new Error("SSH needs the desktop shell (npm run tauri:dev)");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/* ---------- Units ---------- */

/** All saved SSH units, newest first (secrets blanked). */
export async function loadSshServers(): Promise<SshServer[]> {
  if (!inTauri) return [...memory.sshServers];
  const rows = await sshInvoke<RustServer[]>("ssh_list_servers");
  return rows.map(toServer);
}

/** Inserts or updates a unit. Blank password/key keeps the stored secret. */
export async function saveSshServer(server: SshServer): Promise<string> {
  if (!inTauri) {
    const id = server.id || memId() + "-srv";
    memory.sshServers = [{ ...server, id }, ...memory.sshServers.filter((s) => s.id !== id)];
    return id;
  }
  return sshInvoke<string>("ssh_save_server", { server: toRustServer(server) });
}

/** Decrypts a server's stored password (the edit form's "show"); every reveal is audit-logged. */
export async function sshRevealPassword(serverId: string): Promise<string> {
  if (!inTauri) return memory.sshServers.find((s) => s.id === serverId)?.password ?? "";
  return sshInvoke<string>("ssh_reveal_password", { serverId });
}

/** Persists the dragged order of a units list (ids top to bottom). */
export async function reorderSshUnits(kind: "server" | "key" | "script" | "proxy", ids: string[]): Promise<void> {
  if (!inTauri) {
    const sortBy = <T extends { id: string }>(list: T[]): T[] => {
      const byId = new Map(list.map((x) => [x.id, x]));
      return ids.map((id) => byId.get(id)).filter((x): x is T => !!x);
    };
    if (kind === "server") memory.sshServers = sortBy(memory.sshServers);
    else if (kind === "key") memory.sshKeys = sortBy(memory.sshKeys);
    else if (kind === "proxy") memory.sshProxies = sortBy(memory.sshProxies);
    else memory.sshScripts = sortBy(memory.sshScripts);
    return;
  }
  await sshInvoke("ssh_reorder_units", { kind, ids });
}

/** Deletes a group of one unit kind; its units stay, without a group. */
export async function ungroupSshUnits(kind: "server" | "key" | "script" | "proxy", group: string): Promise<void> {
  if (!inTauri) {
    const strip = <T extends { group?: string }>(list: T[]): T[] =>
      list.map((x) => (x.group === group ? { ...x, group: "" } : x));
    if (kind === "server") memory.sshServers = strip(memory.sshServers);
    else if (kind === "key") memory.sshKeys = strip(memory.sshKeys);
    else if (kind === "proxy") memory.sshProxies = strip(memory.sshProxies);
    else memory.sshScripts = strip(memory.sshScripts);
    return;
  }
  await sshInvoke("ssh_ungroup_units", { kind, group });
}

/** Deletes a unit (disconnects it first; its logs stay). */
export async function deleteSshServer(id: string): Promise<void> {
  if (!inTauri) {
    memory.sshServers = memory.sshServers.filter((s) => s.id !== id);
    return;
  }
  await sshInvoke("ssh_delete_server", { serverId: id });
}

/* ---------- Key credentials ---------- */

export async function loadSshKeys(): Promise<SshKey[]> {
  if (!inTauri) return [...memory.sshKeys];
  const rows = await sshInvoke<RustKey[]>("ssh_list_keys");
  return rows.map(toKey);
}

export async function saveSshKey(key: SshKey): Promise<string> {
  if (!inTauri) {
    const id = key.id || memId() + "-key";
    memory.sshKeys = [{ ...key, id }, ...memory.sshKeys.filter((k) => k.id !== id)];
    return id;
  }
  return sshInvoke<string>("ssh_save_key", { key: toRustKey(key) });
}

/**
 * FULL view of one credential — private key and passphrase decrypted.
 * Called ONLY when the credential's edit form opens; listings stay blank.
 */
export async function getSshKey(id: string): Promise<SshKey> {
  if (!inTauri) {
    return memory.sshKeys.find((k) => k.id === id) ?? {
      id,
      name: "",
      private_key: "",
      passphrase: "",
      has_key: false,
      fingerprint: "",
      comment: "",
      public_key: "",
    };
  }
  const r = await sshInvoke<RustKey>("ssh_get_key", { keyId: id });
  return toKey(r);
}

/**
 * Derives (publicKey, fingerprint) from a pasted private key body without
 * saving anything — the import form previews the public half live.
 */
export async function deriveSshPublicKey(
  privateKey: string,
  passphrase: string
): Promise<{ publicKey: string; fingerprint: string }> {
  if (!inTauri) return { publicKey: "", fingerprint: "" };
  const [publicKey, fingerprint] = await sshInvoke<[string, string]>("ssh_derive_public", {
    privateKey,
    passphrase,
  });
  return { publicKey, fingerprint };
}

export async function deleteSshKey(id: string): Promise<void> {
  if (!inTauri) {
    memory.sshKeys = memory.sshKeys.filter((k) => k.id !== id);
    return;
  }
  await sshInvoke("ssh_delete_key", { keyId: id });
}

/**
 * Generates a new keypair credential in Rust and stores it vault-encrypted.
 * The returned row carries only public data (fingerprint, public key,
 * comment "Generated By Gravitation"). Outside Tauri there is no crypto, so
 * a placeholder row is produced to keep the UI flow testable.
 */
export async function generateSshKey(
  name: string,
  algorithm: string,
  passphrase: string
): Promise<SshKey> {
  if (!inTauri) {
    const id = memId() + "-key";
    const row: SshKey = {
      id,
      name: name || algorithm.toUpperCase(),
      private_key: "",
      passphrase: "",
      has_key: true,
      fingerprint: "SHA256:placeholder",
      comment: "Generated By Gravitation",
      public_key: "",
    };
    memory.sshKeys = [row, ...memory.sshKeys];
    return row;
  }
  const r = await sshInvoke<RustKey>("ssh_generate_key", { name, algorithm, passphrase });
  return toKey(r);
}

/* ---------- Proxies ---------- */

interface RustProxy {
  id: string;
  name: string;
  kind: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  hasPassword?: boolean;
  group?: string;
}

/** Saved proxies, in the user's order (passwords never included). */
export async function loadSshProxies(): Promise<SshProxy[]> {
  if (!inTauri) return [...memory.sshProxies];
  const rows = await sshInvoke<RustProxy[]>("ssh_list_proxies");
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind === "socks5" ? "socks5" : "http",
    host: r.host,
    port: r.port,
    username: r.username ?? "",
    password: "",
    has_password: !!r.hasPassword,
    group: r.group ?? "",
  }));
}

/** Inserts or updates a proxy. Blank password keeps the stored one; "-" clears it. */
export async function saveSshProxy(proxy: SshProxy): Promise<string> {
  if (!inTauri) {
    const id = proxy.id || memId() + "-prx";
    const row = { ...proxy, id, has_password: proxy.password ? proxy.password !== "-" : proxy.has_password, password: "" };
    memory.sshProxies = [row, ...memory.sshProxies.filter((p) => p.id !== id)];
    return id;
  }
  return sshInvoke<string>("ssh_save_proxy", {
    proxy: {
      id: proxy.id,
      name: proxy.name,
      kind: proxy.kind,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      group: proxy.group ?? "",
    },
  });
}

/** Deletes a proxy; servers that used it connect directly again. */
export async function deleteSshProxy(id: string): Promise<void> {
  if (!inTauri) {
    memory.sshProxies = memory.sshProxies.filter((p) => p.id !== id);
    memory.sshServers = memory.sshServers.map((s) => (s.proxy_id === id ? { ...s, proxy_id: "" } : s));
    return;
  }
  await sshInvoke("ssh_delete_proxy", { proxyId: id });
}

/* ---------- Scripts ---------- */

export async function loadSshScripts(): Promise<SshScript[]> {
  if (!inTauri) return [...memory.sshScripts];
  return sshInvoke<SshScript[]>("ssh_list_scripts");
}

export async function saveSshScript(script: SshScript): Promise<string> {
  if (!inTauri) {
    const id = script.id || memId() + "-scr";
    memory.sshScripts = [{ ...script, id }, ...memory.sshScripts.filter((s) => s.id !== id)];
    return id;
  }
  return sshInvoke<string>("ssh_save_script", { script });
}

export async function deleteSshScript(id: string): Promise<void> {
  if (!inTauri) {
    memory.sshScripts = memory.sshScripts.filter((s) => s.id !== id);
    return;
  }
  await sshInvoke("ssh_delete_script", { scriptId: id });
}

/** Runs a saved script on a server; returns combined output. */

/* ---------- Audit log (no secrets — read via SQL plugin) ---------- */

interface SshLogRow {
  id: string;
  actor: string;
  server_id: string;
  server_name: string;
  host: string;
  action: string;
  ok: number;
  detail: string;
  created_at: number;
}

/** The audit trail, newest first, capped for the Logs page. */
export async function loadSshLogs(limit = 300): Promise<SshLog[]> {
  const db = await getDb();
  if (!db) return [...memory.sshLogs];
  const rows = await db.select<SshLogRow[]>(
    "SELECT id, actor, server_id, server_name, host, action, ok, detail, created_at FROM ssh_logs ORDER BY created_at DESC, id DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({ ...r, ok: !!r.ok }));
}

/** Window event fired after the audit log was cleared (Logs page reloads). */
export const SSH_LOGS_CLEARED = "ssh-logs-cleared";

/** Deletes the whole SSH audit trail (Settings → Logs, SSH Client mode). */
export async function clearSshLogs(): Promise<void> {
  const db = await getDb();
  if (!db) memory.sshLogs = [];
  else await db.execute("DELETE FROM ssh_logs");
  window.dispatchEvent(new Event(SSH_LOGS_CLEARED));
}

/** Number of rows in the audit trail. */
export async function countSshLogs(): Promise<number> {
  const db = await getDb();
  if (!db) return memory.sshLogs.length;
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM ssh_logs");
  return rows[0]?.n ?? 0;
}

/* ---------- Live connections (Rust owns the pool) ---------- */

/** Connects to a saved unit (idempotent — a live session is reused). */
export async function sshConnect(serverId: string): Promise<void> {
  await sshInvoke("ssh_connect", { serverId });
}

/** Server ids with a live connection right now. */
export async function sshConnected(): Promise<string[]> {
  if (!inTauri) return [];
  return sshInvoke<string[]>("ssh_connected");
}

/* ---------- Interactive terminal (PTY) ---------- */

/**
 * Opens an interactive PTY shell sized cols×rows. Measure the terminal box
 * FIRST — that size is negotiated with the remote sshd, so a small value
 * here means a small remote console (wrong line wrapping).
 * Returns the session id; output arrives on `ssh://shell-data`.
 */
export async function sshShellOpen(
  serverId: string,
  cols: number,
  rows: number,
  term?: string,
): Promise<string> {
  return sshInvoke<string>("ssh_shell_open", { serverId, cols, rows, term: term ?? null });
}

/** Feeds typed bytes to the PTY. Accepts a string or raw bytes. */
export async function sshShellInput(sessionId: string, data: string | Uint8Array): Promise<void> {
  const b64 =
    typeof data === "string"
      ? base64FromBytes(new TextEncoder().encode(data))
      : base64FromBytes(data);
  await sshInvoke("ssh_shell_input", { sessionId, data: b64 });
}

/** Tells the remote PTY the terminal box changed size. */
export async function sshShellResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await sshInvoke("ssh_shell_resize", { sessionId, cols, rows });
}

/** Base64 of recent output (ring buffer) — restores a reopened terminal. */
export async function sshShellSnapshot(sessionId: string): Promise<Uint8Array> {
  const b64 = await sshInvoke<string>("ssh_shell_snapshot", { sessionId });
  return bytesFromBase64(b64);
}

/** Closes a shell session (idempotent). */
export async function sshShellClose(sessionId: string): Promise<void> {
  await sshInvoke("ssh_shell_close", { sessionId });
}

/* ---------- base64 helpers (binary-safe IPC) ---------- */

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function bytesFromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Decodes a base64 event payload to bytes (shell output is binary-safe). */
export function decodeB64(b64: string): Uint8Array {
  return bytesFromBase64(b64);
}

/* ---------- SFTP file transfer ---------- */

/** Lists a remote directory (dirs first, then name). Empty path = cwd. */
export async function sftpList(serverId: string, path: string): Promise<SftpEntry[]> {
  return sshInvoke<SftpEntry[]>("ssh_sftp_list", { serverId, path });
}

/** Resolves the remote home directory (where the session starts). */
export async function sftpHome(serverId: string): Promise<string> {
  return sshInvoke<string>("ssh_sftp_home", { serverId });
}

/** Downloads a remote file to a local path; returns bytes written. */
export async function sftpDownload(
  serverId: string,
  remote: string,
  local: string,
): Promise<number> {
  return sshInvoke<number>("ssh_sftp_download", { serverId, remote, local });
}

/** Uploads a local file to a remote path; returns bytes written. */
export async function sftpUpload(
  serverId: string,
  local: string,
  remote: string,
): Promise<number> {
  return sshInvoke<number>("ssh_sftp_upload", { serverId, local, remote });
}

/** Reads a small text file for the preview pane (capped at 2 MB). */
export async function sftpReadText(serverId: string, remote: string): Promise<string> {
  return sshInvoke<string>("ssh_sftp_read_text", { serverId, remote });
}

/** Saves text edited in the SFTP editor back to the server. */
export async function sftpWriteText(serverId: string, remote: string, content: string): Promise<void> {
  await sshInvoke("ssh_sftp_write_text", { serverId, remote, content });
}

/** Chunk size of drag-and-drop uploads (bytes go over IPC as a raw body). */
const UPLOAD_CHUNK = 4 * 1024 * 1024;

/**
 * Uploads an in-memory file (e.g. dropped onto the SFTP page — the webview
 * sees its bytes, not a local path) in chunks; progress arrives as
 * ssh://transfer events like any other upload.
 */
export async function sftpUploadBlob(serverId: string, remote: string, blob: Blob): Promise<void> {
  if (!inTauri) throw new Error("SSH needs the desktop shell (npm run tauri:dev)");
  const { invoke } = await import("@tauri-apps/api/core");
  const total = blob.size;
  let offset = 0;
  do {
    const part = new Uint8Array(await blob.slice(offset, offset + UPLOAD_CHUNK).arrayBuffer());
    await invoke("ssh_sftp_write_chunk", part, {
      headers: {
        "x-server-id": serverId,
        "x-remote": encodeURIComponent(remote),
        "x-offset": String(offset),
        "x-total": String(total),
      },
    });
    offset += part.length;
  } while (offset < total);
}

export async function sftpRename(serverId: string, oldPath: string, newPath: string): Promise<void> {
  await sshInvoke("ssh_sftp_rename", { serverId, old: oldPath, new: newPath });
}

export async function sftpRemove(serverId: string, path: string, isDir: boolean): Promise<void> {
  await sshInvoke("ssh_sftp_remove", { serverId, path, isDir });
}

export async function sftpMkdir(serverId: string, path: string): Promise<void> {
  await sshInvoke("ssh_sftp_mkdir", { serverId, path });
}

/** True when the vault master key is persisted (OS keyring or app-data file). */
export async function sshVaultBacked(): Promise<boolean> {
  if (!inTauri) return false;
  return sshInvoke<boolean>("ssh_vault_status");
}

/** Transfer progress: {serverId, file, done, total, finished}. */
export interface SshTransferProgress {
  serverId: string;
  file: string;
  done: number;
  total: number;
  finished: boolean;
}

/**
 * Subscribes to live SSH events. Returns a disposer.
 *
 * * onStatus   — connected-server ids changed (`ssh://status`);
 * * onLogged   — a new audit row was written (`ssh://logged`);
 * * onShellData— PTY output, base64 (`ssh://shell-data`);
 * * onShellExit— a shell ended (`ssh://shell-exit`);
 * * onTransfer — SFTP progress (`ssh://transfer`);
 * * onOs       — a server's OS was detected (`ssh://os`), [serverId, token].
 */
export async function onSshEvent(handlers: {
  onStatus?: (connectedIds: string[]) => void;
  onLogged?: () => void;
  onShellData?: (payload: { sessionId: string; data: string }) => void;
  onShellExit?: (payload: { sessionId: string; code: number | null }) => void;
  onTransfer?: (progress: SshTransferProgress) => void;
  onOs?: (payload: [string, string]) => void;
}): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offs = await Promise.all([
    listen<string[]>("ssh://status", (e) => handlers.onStatus?.(e.payload)),
    listen("ssh://logged", () => handlers.onLogged?.()),
    listen<{ sessionId: string; data: string }>("ssh://shell-data", (e) =>
      handlers.onShellData?.(e.payload),
    ),
    listen<{ sessionId: string; code: number | null }>("ssh://shell-exit", (e) =>
      handlers.onShellExit?.(e.payload),
    ),
    listen<SshTransferProgress>("ssh://transfer", (e) => handlers.onTransfer?.(e.payload)),
    listen<[string, string]>("ssh://os", (e) => handlers.onOs?.(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}


/* ---------- First launch: units saved in Singularity ---------- */

/** Copies the SSH units saved in Singularity (once); returns how many servers came over. */
export async function importFromSingularity(): Promise<number> {
  if (!inTauri) return 0;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("ssh_import_singularity");
}

/* ---------- Sync (optional, self-hosted, end-to-end encrypted) ---------- */

/** Live sync state of this device (`sync://status`). */
export interface SyncStatus {
  enabled: boolean;
  url: string;
  state: "off" | "idle" | "syncing" | "error";
  /** Unix seconds of the last good sync, 0 = never. */
  last_ok: number;
  error: string;
  items: number;
  /** Why sync is off, when it was turned off for this device (keys reset elsewhere). */
  notice: string;
  /** Sync is on but the server has not confirmed this device yet: servers, passwords and keys stay closed. */
  locked: boolean;
}

const SYNC_OFF: SyncStatus = { enabled: false, url: "", state: "off", last_ok: 0, error: "", items: 0, notice: "", locked: false };

export async function syncStatus(): Promise<SyncStatus> {
  if (!inTauri) return SYNC_OFF;
  return sshInvoke<SyncStatus>("sync_status");
}

/** First device: creates the account (server URL + invite from `gravitation-sync invite`). */
export async function syncCreate(url: string, invite: string, passphrase: string): Promise<void> {
  return sshInvoke("sync_create", { url, invite, passphrase });
}

/** Another device: setup code from a connected device + the passphrase. */
export async function syncJoin(code: string, passphrase: string): Promise<void> {
  return sshInvoke("sync_join", { code, passphrase });
}

/** Opens a locked device offline with the passphrase (until the app restarts). */
export async function syncUnlock(passphrase: string): Promise<void> {
  return sshInvoke("sync_unlock", { passphrase });
}

export async function syncNow(): Promise<void> {
  return sshInvoke("sync_now");
}

/** Something synced changed outside Rust's own commands — sync soon. */
export async function syncNudge(): Promise<void> {
  if (!inTauri) return;
  return sshInvoke("sync_nudge");
}

/**
 * New passphrase + new secret key. The server keeps everything (re-encrypted);
 * every other device is signed out and removes its synced units. Returns the new setup code.
 */
export async function syncResetKeys(current: string, passphrase: string): Promise<string> {
  return sshInvoke<string>("sync_reset_keys", { current, passphrase });
}

export async function syncSetupCode(): Promise<string> {
  return sshInvoke<string>("sync_setup_code");
}

/** Turns sync off here (local units stay); `wipeServer` also deletes the account on the server. */
export async function syncDisconnect(wipeServer: boolean): Promise<void> {
  return sshInvoke("sync_disconnect", { wipeServer });
}

/** onStatus — sync state changed; onApplied — units arrived from another device. */
export async function onSyncEvent(handlers: {
  onStatus?: (s: SyncStatus) => void;
  onApplied?: () => void;
}): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offs = await Promise.all([
    listen<SyncStatus>("sync://status", (e) => handlers.onStatus?.(e.payload)),
    listen("sync://applied", () => handlers.onApplied?.()),
  ]);
  return () => offs.forEach((off) => off());
}
