import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  X,
  Server,
  KeyRound,
  FileCode2,
  Save,
  Trash2,
  ShieldCheck,
  RotateCcw,
  Info,
  Copy,
  Check,
  Eye,
  EyeOff,
  Waypoints,
  Lock,
  Terminal,
  Sparkles,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshKey, SshProxy, SshScript, SshServer } from "../core/types.i";
import { useOverlayThumb } from "../hooks/useOverlayThumb.h";
import { groupNames } from "../core/unitGroups.u";
import { ScrollArea, Combobox, Thumb, FIELD_LABEL, Input, Button, Alert, Segmented, Spinner, IconButton, cx, TEXTAREA } from "../components";

/**
 * SshPanel — the docked right-hand sidebar of SSH Client mode.
 *
 * Creating and editing a unit is not a dialog: a column slides in from the
 * right and stays while you work. A header names the unit; the form is a
 * stack of cards (Connection, Authentication…), each a titled block of
 * fields; the actions sit in a bar pinned to the bottom.
 */
export type SshPanelTarget =
  | { kind: "server"; id?: string } // id undefined = create
  | { kind: "key"; id?: string }
  | { kind: "script"; id?: string }
  | { kind: "proxy"; id?: string };

const AREA = cx(TEXTAREA, "resize-none font-mono text-[11px] leading-[1.5]");

/**
 * Textarea with the app's OWN scrollbar: the native bar is hidden globally
 * (styles.css) and the overlay thumb is drawn on top — the same look as
 * every other scrollable surface.
 */
function AreaField({
  className = AREA,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const thumb = useOverlayThumb(ref);
  return (
    <div className="relative">
      <textarea ref={ref} className={className} {...rest} />
      <Thumb thumb={thumb} />
    </div>
  );
}

const KIND_META = {
  server: { icon: Server, noun: "server", blurb: "A host you open terminals and files on." },
  key: { icon: KeyRound, noun: "credential", blurb: "A private key servers can sign in with." },
  script: { icon: FileCode2, noun: "script", blurb: "A command pasted into the open terminal." },
  proxy: { icon: Waypoints, noun: "proxy", blurb: "An HTTP or SOCKS5 hop servers connect through." },
} as const;

export function SshPanel({
  target,
  servers,
  keys,
  scripts,
  proxies,
  width,
  resizing,
  onResizeStart,
  onChanged,
  onClose,
}: {
  target: SshPanelTarget;
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  proxies: SshProxy[];
  /** Current panel width in px — dragged by the handle on its left edge. */
  width: number;
  /** True while dragging the edge: the width animation is switched off so the
   *  panel tracks the cursor 1:1 (open/close still animates). */
  resizing?: boolean;
  /** Starts a drag-resize (same mechanics as the chat inspection panel). */
  onResizeStart: (e: React.MouseEvent) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Escape closes the panel (dialogs are gone; the panel owns the shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const server = target.kind === "server" && target.id ? servers.find((s) => s.id === target.id) : undefined;
  const sshKey = target.kind === "key" && target.id ? keys.find((k) => k.id === target.id) : undefined;
  const script = target.kind === "script" && target.id ? scripts.find((s) => s.id === target.id) : undefined;
  const proxy = target.kind === "proxy" && target.id ? proxies.find((p) => p.id === target.id) : undefined;

  // Editing a row that vanished (deleted elsewhere) falls back to closing.
  useEffect(() => {
    if (target.kind === "server" && target.id && !server) onClose();
    if (target.kind === "key" && target.id && !sshKey) onClose();
    if (target.kind === "script" && target.id && !script) onClose();
    if (target.kind === "proxy" && target.id && !proxy) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, sshKey, script, proxy]);

  const unit = server ?? sshKey ?? script ?? proxy;
  const meta = KIND_META[target.kind];
  const TitleIcon = meta.icon;

  // key=… forces a fresh form state when the panel switches rows.
  const formKey = target.kind + ":" + (target.id ?? "new");

  return (
    <motion.aside
      key="ssh-panel"
      className="selectable relative flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-sidebar)]"
      /* The panel GROWS its width from 0 (and collapses back on close), so
         the main column compresses/expands gradually instead of jumping. */
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={
        resizing
          ? { width: { duration: 0 }, opacity: { duration: 0.15 } }
          : { width: { duration: 0.24, ease: [0.32, 0.72, 0, 1] }, opacity: { duration: 0.15 } }
      }
    >
      <div className="panel-resizer" onMouseDown={onResizeStart} />

      {/* Header: what is being edited, in words and an icon */}
      <div className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]">
          <TitleIcon size={18} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-[var(--text-main)]">
            {unit ? unit.name : "New " + meta.noun}
          </div>
          <div className="truncate text-[11.5px] text-[var(--text-dim)]">
            {unit ? "Edit " + meta.noun : meta.blurb}
          </div>
        </div>
        <IconButton label="Close panel" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      {target.kind === "server" && (
        <ServerForm key={formKey} server={server} keys={keys} proxies={proxies} groups={groupNames(servers)} onChanged={onChanged} onClose={onClose} />
      )}
      {target.kind === "key" && (
        <KeyForm key={formKey} value={sshKey} groups={groupNames(keys)} onChanged={onChanged} onClose={onClose} />
      )}
      {target.kind === "script" && (
        <ScriptForm key={formKey} value={script} groups={groupNames(scripts)} onChanged={onChanged} onClose={onClose} />
      )}
      {target.kind === "proxy" && (
        <ProxyForm key={formKey} value={proxy} groups={groupNames(proxies)} onChanged={onChanged} onClose={onClose} />
      )}
    </motion.aside>
  );
}

/* ---------- Shared form bits ---------- */

/** The scrolling form body over the pinned action bar. */
function FormShell({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <>
      <ScrollArea className="min-h-0 flex-1" innerClassName="flex flex-col gap-3 px-4 pb-4 pt-1">
        {children}
      </ScrollArea>
      {footer}
    </>
  );
}

/** A titled block of fields. */
function Card({
  icon: Icon,
  title,
  aside,
  children,
}: {
  icon: typeof Server;
  title: string;
  /** Right side of the title row (a hint or a small action). */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-[var(--border-soft)] bg-[var(--bg-surface)] p-4">
      <div className="flex min-h-5 items-center gap-2">
        <Icon size={14} strokeWidth={1.7} className="shrink-0 text-[var(--text-dim)]" />
        <span className="text-[12.5px] font-medium text-[var(--text-main)]">{title}</span>
        {aside && <span className="ml-auto flex min-w-0 items-center text-[11px] text-[var(--text-dim)]">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** Label over a control, optional hint under it. */
function F({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1.5 text-[11px] leading-snug text-[var(--text-dim)]">{hint}</span>}
    </div>
  );
}

/** A quiet explanation inside a card (empty lists, what happens next). */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-[var(--bg-input)] px-3 py-2.5 text-[11.5px] leading-[1.5] text-[var(--text-muted)]">
      <Info size={13} className="mt-px shrink-0 text-[var(--text-dim)]" />
      <span>{children}</span>
    </div>
  );
}

/** Password input with show/hide and (when one is stored) a Clear button. */
function SecretInput({
  value,
  onChange,
  placeholder,
  shown,
  onToggleShown,
  showLabel,
  onClear,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  shown: boolean;
  onToggleShown?: () => void;
  showLabel?: string;
  /** Present when a stored secret can be removed. */
  onClear?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <Input
          className={onToggleShown ? "pr-10" : undefined}
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
        {onToggleShown && (
          <IconButton
            label={showLabel ?? (shown ? "Hide" : "Show")}
            size="xs"
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
            onClick={onToggleShown}
          >
            {shown ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        )}
      </div>
      {onClear && (
        <Button variant="secondary" icon={<RotateCcw size={12} />} onClick={onClear} title="Remove the stored value">
          Clear
        </Button>
      )}
    </div>
  );
}

function FormButtons({
  onSave,
  saveLabel,
  busy,
  error,
  onDelete,
  onClose,
}: {
  onSave: () => void;
  saveLabel: string;
  busy?: boolean;
  error?: string | null;
  onDelete?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--border)] px-4 py-3">
      {error && <Alert className="mb-3">{error}</Alert>}
      <div className="flex items-center gap-2">
        {onDelete && (
          <Button variant="danger-ghost" icon={<Trash2 size={13} />} onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" icon={busy ? <Spinner size={13} /> : <Save size={13} />} onClick={onSave} disabled={busy}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** Group of the unit: picked from the groups in use, or a new one typed in the search. */
function GroupField({ value, onChange, groups }: { value: string; onChange: (v: string) => void; groups: string[] }) {
  const names = value && !groups.includes(value) ? [...groups, value].sort((a, b) => a.localeCompare(b)) : groups;
  return (
    <F label="Group">
      <Combobox
        value={value}
        onChange={onChange}
        placeholder="Search or type a new group…"
        emptyText="Type a name to create a group"
        createLabel={(q) => `New group "${q}"`}
        options={[{ value: "", label: "No group" }, ...names.map((g) => ({ value: g, label: g }))]}
      />
    </F>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ---------- Server form ---------- */

function ServerForm({
  server,
  keys,
  proxies,
  groups,
  onChanged,
  onClose,
}: {
  server?: SshServer;
  keys: SshKey[];
  proxies: SshProxy[];
  groups: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "root");
  // Termius-style dual auth: BOTH a password and a saved credential key may
  // be set at once — the connector tries the key first, then the password.
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(server?.key_id ?? "");
  const [proxyId, setProxyId] = useState(server?.proxy_id ?? "");
  const [group, setGroup] = useState(server?.group ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasStoredPassword = !!server?.has_password;
  /** Password shown as plain text (typed, or the stored one fetched on demand). */
  const [showPassword, setShowPassword] = useState(false);
  /** The stored password was pulled into the field — saving re-stores it as is. */
  const [revealed, setRevealed] = useState(false);

  // A revealed password hides itself again after 30 s.
  useEffect(() => {
    if (!showPassword) return;
    const id = setTimeout(() => setShowPassword(false), 30_000);
    return () => clearTimeout(id);
  }, [showPassword]);

  const toggleShow = async () => {
    if (showPassword) return setShowPassword(false);
    // Blank field on a server with a stored password: fetch it (audit-logged).
    if (server && hasStoredPassword && !password && !revealed) {
      try {
        setPassword(await db.sshRevealPassword(server.id));
        setRevealed(true);
      } catch (e) {
        return setError(errText(e));
      }
    }
    setShowPassword(true);
  };

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
      onChanged();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const forgetHostKey = () => {
    if (!server) return;
    if (!confirm("Forget the pinned host key? The next connect trusts whatever key the server presents — only do this after reinstalling the server.")) return;
    // "-" is the wire signal to clear the pinned fingerprint.
    void run(() => db.saveSshServer({ ...server, password: "", host_key: "-" }).then(() => {}));
  };

  const save = () => {
    setError(null);
    if (!name.trim()) return setError("Give the server a name.");
    if (!host.trim()) return setError("Host is required.");
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return setError("Port must be a number from 1 to 65535.");
    }
    if (!server && !password && !keyId) {
      return setError("Set a password and/or pick a saved key credential.");
    }
    void run(() =>
      db
        .saveSshServer({
          id: server?.id ?? "",
          name: name.trim(),
          host: host.trim(),
          port: portNum,
          username: username.trim() || "root",
          // "cred" when a key is linked (tried first on connect), else password.
          auth: keyId ? "cred" : "password",
          // Blank password keeps the stored one when editing; "-" removes it.
          password,
          private_key: "",
          key_id: keyId,
          host_key: server?.host_key ?? "",
          has_password: hasStoredPassword,
          os: server?.os ?? "",
          proxy_id: proxyId,
          group: group.trim(),
        })
        .then(() => {}),
    );
  };

  const del = () => {
    if (!server || !confirm("Delete this server? Its audit rows stay in Logs.")) return;
    void run(() => db.deleteSshServer(server.id));
  };

  // "-" is the wire signal to REMOVE the stored password (key-only host).
  const clearPassword = () => server && void run(() => db.saveSshServer({ ...server, password: "-" }).then(() => {}));

  const address = `${username.trim() || "root"}@${host.trim() || "host"}${port && port !== "22" ? ":" + port : ""}`;

  return (
    <FormShell
      footer={
        <FormButtons
          onSave={save}
          saveLabel={server ? "Save" : "Create"}
          busy={busy}
          error={error}
          onDelete={server ? del : undefined}
          onClose={onClose}
        />
      }
    >
      <Card icon={Server} title="Connection" aside={<span className="truncate font-mono">{address}</span>}>
        <F label="Label">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-web-1" autoFocus />
        </F>
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <F label="Host">
            <Input mono value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5 or example.com" />
          </F>
          <F label="Port">
            <Input mono value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          </F>
        </div>
        <F label="Username">
          <Input mono value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </F>
        <GroupField value={group} onChange={setGroup} groups={groups} />
      </Card>

      <Card icon={Lock} title="Authentication" aside="key first, then password">
        <F label="Password" hint={server && hasStoredPassword ? "Leave blank to keep the stored one." : undefined}>
          <SecretInput
            value={password}
            onChange={setPassword}
            placeholder={hasStoredPassword ? "•••••••• stored" : "optional"}
            shown={showPassword}
            onToggleShown={password || hasStoredPassword ? () => void toggleShow() : undefined}
            showLabel={showPassword ? "Hide password" : "Show password (hides again after 30 s; logged)"}
            onClear={hasStoredPassword ? clearPassword : undefined}
          />
        </F>
        <F label="Key credential">
          {keys.length === 0 ? (
            <Note>No credentials yet — add or generate one under Credentials, then pick it here.</Note>
          ) : (
            <Combobox
              value={keyId}
              onChange={setKeyId}
              placeholder="Search credentials…"
              emptyText="No credential matches"
              options={[
                { value: "", label: "No key — password only" },
                ...keys.map((k) => ({
                  value: k.id,
                  label: k.name,
                  hint: k.fingerprint ? k.fingerprint.slice(0, 20) : undefined,
                  mark: k.comment?.startsWith("Generated By ") ? "✦" : undefined,
                })),
              ]}
            />
          )}
        </F>
      </Card>

      <Card icon={Waypoints} title="Connect through">
        {proxies.length === 0 ? (
          <Note>No proxies yet — the server is reached directly. Add one on the Units page (Proxies).</Note>
        ) : (
          <Combobox
            value={proxyId}
            onChange={setProxyId}
            placeholder="Search proxies…"
            emptyText="No proxy matches"
            options={[
              { value: "", label: "Direct connection" },
              ...proxies.map((p) => ({
                value: p.id,
                label: p.name,
                hint: `${p.kind === "socks5" ? "SOCKS5" : "HTTP"} ${p.host}:${p.port}`,
              })),
            ]}
          />
        )}
      </Card>

      {server && (
        <Card icon={ShieldCheck} title="Host key">
          {server.host_key ? (
            <div className="flex items-center gap-2">
              <span
                className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-[var(--bg-input)] px-3 font-mono text-[11px] text-[var(--text-muted)]"
                title={server.host_key}
              >
                <ShieldCheck size={12} className="shrink-0 text-[var(--diff-add,#4ec9b0)]" />
                <span className="truncate">{server.host_key}</span>
              </span>
              <Button
                variant="secondary"
                icon={<RotateCcw size={12} />}
                onClick={forgetHostKey}
                title="Only after the server was reinstalled — a changed key can mean an attack"
              >
                Forget
              </Button>
            </div>
          ) : (
            <Note>Not pinned yet — the first connect pins the server's key.</Note>
          )}
        </Card>
      )}
    </FormShell>
  );
}

/* ---------- Key form ---------- */

/** Algorithms the generator offers — labels mirror ssh-keygen -t values. */
const KEY_ALGORITHMS: Array<{ id: string; label: string }> = [
  { id: "ed25519", label: "Ed25519 — modern default" },
  { id: "ecdsa-p256", label: "ECDSA P-256" },
  { id: "ecdsa-p384", label: "ECDSA P-384" },
  { id: "ecdsa-p521", label: "ECDSA P-521" },
  { id: "rsa", label: "RSA 4096 — max compatibility" },
];

/** Copy-to-clipboard button with a short "Copied" state. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the text is selectable in the box anyway */
    }
  };
  return (
    <Button variant="secondary" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={() => void copy()}>
      {copied ? "Copied" : label}
    </Button>
  );
}

function KeyForm({
  value,
  groups,
  onChanged,
  onClose,
}: {
  value?: SshKey;
  groups: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [group, setGroup] = useState(value?.group ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Create mode: paste an existing body OR generate a fresh keypair. */
  const [mode, setMode] = useState<"paste" | "generate">("generate");
  const [algorithm, setAlgorithm] = useState("ed25519");
  /** Set right after generation: shows the public key to copy to servers. */
  const [generated, setGenerated] = useState<SshKey | null>(null);
  /**
   * Secrets are DECRYPTED ONLY WHEN THIS FORM OPENS: editing an existing
   * credential fetches the full row (private key + passphrase visible);
   * listings and every other screen never see plaintext.
   */
  const [publicKey, setPublicKey] = useState(value?.public_key ?? "");
  const [fingerprint, setFingerprint] = useState(value?.fingerprint ?? "");
  const [comment, setComment] = useState(value?.comment ?? "");
  const [loadingSecrets, setLoadingSecrets] = useState(!!value);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await db.getSshKey(value.id);
        if (cancelled) return;
        setPrivateKey(full.private_key);
        setPassphrase(full.passphrase);
        setPublicKey(full.public_key ?? "");
        setFingerprint(full.fingerprint ?? "");
        setComment(full.comment ?? "");
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoadingSecrets(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value]);

  // Import mode: derive the public half live from the pasted body (debounced).
  useEffect(() => {
    if (value || mode !== "paste") return;
    if (!privateKey.trim()) {
      setPublicKey("");
      setFingerprint("");
      return;
    }
    const t = setTimeout(() => {
      void db
        .deriveSshPublicKey(privateKey, passphrase)
        .then((d) => {
          setPublicKey(d.publicKey);
          setFingerprint(d.fingerprint);
        })
        .catch(() => {
          setPublicKey("");
          setFingerprint("");
        });
    }, 400);
    return () => clearTimeout(t);
  }, [privateKey, passphrase, mode, value]);

  const gen = async () => {
    setError(null);
    setBusy(true);
    try {
      const row = await db.generateSshKey(name.trim(), algorithm, passphrase);
      // Blank secrets keep the generated body; only the group is written.
      if (group.trim()) await db.saveSshKey({ ...row, group: group.trim() });
      // Fetch the FULL row (secrets decrypted) so the generated screen can
      // show the private key too — the only moment it is ever displayed.
      const full = await db.getSshKey(row.id).catch(() => row);
      setGenerated(full);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the credential a name.");
    if (!privateKey.trim()) return setError("The private key body is empty.");
    setBusy(true);
    try {
      // The form holds the DECRYPTED body (loaded on open), so every save
      // ships the full key; Rust re-validates, re-encrypts and re-derives
      // the public half + fingerprint when the body/passphrase changed.
      await db.saveSshKey({
        id: value?.id ?? "",
        name: name.trim(),
        private_key: privateKey,
        passphrase,
        has_key: true,
        fingerprint,
        comment,
        public_key: publicKey,
        group: group.trim(),
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this credential? Servers using it fall back to password auth.")) return;
    setBusy(true);
    try {
      if (value) await db.deleteSshKey(value.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // Right after generation: the public half to copy (the row is saved).
  if (generated) {
    return (
      <FormShell
        footer={
          <div className="flex shrink-0 justify-end border-t border-[var(--border)] px-4 py-3">
            <Button variant="primary" icon={<Check size={13} />} onClick={onClose}>
              Done
            </Button>
          </div>
        }
      >
        <Card
          icon={Sparkles}
          title={generated.name}
          aside={<span className="text-[var(--accent)]">{generated.comment || "Generated By Gravitation"}</span>}
        >
          <F label="Fingerprint">
            <div className="break-all rounded-xl bg-[var(--bg-input)] px-3 py-2 font-mono text-[11px] text-[var(--text-muted)]">
              {generated.fingerprint}
            </div>
          </F>
          <F label="Public key" hint="Put it into ~/.ssh/authorized_keys on the server.">
            <AreaField className={AREA + " h-24"} readOnly value={generated.public_key} onFocus={(e) => e.currentTarget.select()} />
            <div className="mt-2">
              <CopyButton text={generated.public_key ?? ""} label="Copy public key" />
            </div>
          </F>
          {generated.private_key && (
            <F label="Private key" hint="Shown only here, this once.">
              <AreaField className={AREA + " h-28"} readOnly value={generated.private_key} onFocus={(e) => e.currentTarget.select()} />
            </F>
          )}
        </Card>
      </FormShell>
    );
  }

  const showBody = !!value || mode === "paste";

  return (
    <FormShell
      footer={
        <FormButtons
          onSave={mode === "generate" && !value ? () => void gen() : () => void save()}
          saveLabel={!value && mode === "generate" ? "Generate" : value ? "Save" : "Import"}
          busy={busy}
          error={error}
          onDelete={value ? () => void del() : undefined}
          onClose={onClose}
        />
      }
    >
      {!value && (
        <Segmented
          className="min-h-9"
          fill
          options={[
            { value: "generate", label: "Generate new" },
            { value: "paste", label: "Import existing" },
          ]}
          value={mode}
          onChange={setMode}
        />
      )}

      <Card icon={KeyRound} title="Credential">
        <F label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy key" autoFocus />
        </F>
        <GroupField value={group} onChange={setGroup} groups={groups} />
      </Card>

      {!showBody && (
        <Card icon={Sparkles} title="New keypair">
          <F label="Algorithm">
            <Combobox
              searchable={false}
              value={algorithm}
              onChange={setAlgorithm}
              options={KEY_ALGORITHMS.map((a) => ({ value: a.id, label: a.label }))}
            />
          </F>
          <F label="Passphrase" hint="Optional — encrypts the generated key.">
            <SecretInput value={passphrase} onChange={setPassphrase} placeholder="none" shown={showPass} onToggleShown={() => setShowPass((v) => !v)} />
          </F>
          <Note>The keypair is made on this machine and stored encrypted; its comment reads “Generated By Gravitation”.</Note>
        </Card>
      )}

      {showBody && (
        <Card icon={Lock} title="Private key" aside={loadingSecrets ? "decrypting…" : undefined}>
          {loadingSecrets ? (
            <div className="flex h-32 items-center justify-center gap-2 rounded-xl bg-[var(--bg-input)] text-[11.5px] text-[var(--text-dim)]">
              <Spinner size={13} /> Decrypting…
            </div>
          ) : (
            <AreaField
              className={AREA + " h-36"}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
          )}
          <F label={value ? "Passphrase" : "Passphrase — if the key is encrypted"}>
            <SecretInput
              value={passphrase}
              onChange={setPassphrase}
              placeholder={loadingSecrets ? "••••••••" : "none"}
              shown={showPass}
              onToggleShown={() => setShowPass((v) => !v)}
              disabled={loadingSecrets}
            />
          </F>
        </Card>
      )}

      {/* Public key — derived, read-only: live while pasting, from the
          decrypted row when editing. */}
      {showBody && (
        <Card
          icon={ShieldCheck}
          title="Public key"
          aside={fingerprint ? <span className="truncate font-mono text-[10.5px]">{fingerprint}</span> : undefined}
        >
          {publicKey ? (
            <>
              <AreaField className={AREA + " h-16"} readOnly value={publicKey} onFocus={(e) => e.currentTarget.select()} />
              <div>
                <CopyButton text={publicKey} label="Copy public key" />
              </div>
            </>
          ) : (
            <Note>
              {privateKey.trim()
                ? "Cannot read this private key yet — check the body and the passphrase."
                : "Appears here once a private key is pasted."}
            </Note>
          )}
        </Card>
      )}
    </FormShell>
  );
}

/* ---------- Script form ---------- */

function ScriptForm({
  value,
  groups,
  onChanged,
  onClose,
}: {
  value?: SshScript;
  groups: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [description, setDescription] = useState(value?.description ?? "");
  const [group, setGroup] = useState(value?.group ?? "");
  const [content, setContent] = useState(value?.content ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
      onChanged();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    setError(null);
    if (!name.trim()) return setError("Give the script a name.");
    if (!content.trim()) return setError("The command body is empty.");
    void run(() =>
      db.saveSshScript({
        id: value?.id ?? "",
        name: name.trim(),
        description: description.trim(),
        content,
        group: group.trim(),
      }),
    );
  };

  const del = () => {
    if (!value || !confirm("Delete this script?")) return;
    void run(() => db.deleteSshScript(value.id));
  };

  const lines = content ? content.split("\n").length : 0;

  return (
    <FormShell
      footer={
        <FormButtons
          onSave={save}
          saveLabel={value ? "Save" : "Create"}
          busy={busy}
          error={error}
          onDelete={value ? del : undefined}
          onClose={onClose}
        />
      }
    >
      <Card icon={FileCode2} title="Script">
        <F label="Label">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Disk usage" autoFocus />
        </F>
        <F label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does — optional" />
        </F>
        <GroupField value={group} onChange={setGroup} groups={groups} />
      </Card>

      <Card icon={Terminal} title="Command" aside={lines ? `${lines} line${lines > 1 ? "s" : ""}` : undefined}>
        <AreaField
          className={AREA + " h-56 text-[12px]"}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"df -h"}
          spellCheck={false}
        />
        <Note>Click the script in the sidebar while a terminal is open — it is pasted there.</Note>
      </Card>
    </FormShell>
  );
}

/* ---------- Proxy form ---------- */

const DEFAULT_PROXY_PORT = { http: 8080, socks5: 1080 } as const;

function ProxyForm({
  value,
  groups,
  onChanged,
  onClose,
}: {
  value?: SshProxy;
  groups: string[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [kind, setKind] = useState<SshProxy["kind"]>(value?.kind ?? "socks5");
  const [group, setGroup] = useState(value?.group ?? "");
  const [host, setHost] = useState(value?.host ?? "");
  const [port, setPort] = useState(String(value?.port ?? DEFAULT_PROXY_PORT.socks5));
  const [username, setUsername] = useState(value?.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = !!value?.has_password && !clearPassword;

  const pickKind = (k: SshProxy["kind"]) => {
    // Swap the port along with the type while it is still the other default.
    if (port === String(DEFAULT_PROXY_PORT[kind])) setPort(String(DEFAULT_PROXY_PORT[k]));
    setKind(k);
  };

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
      onChanged();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    setError(null);
    if (!name.trim()) return setError("Give the proxy a name.");
    if (!host.trim()) return setError("Host is required.");
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return setError("Port must be a number from 1 to 65535.");
    }
    void run(() =>
      db.saveSshProxy({
        id: value?.id ?? "",
        name: name.trim(),
        kind,
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        // "" keeps the stored password, "-" removes it.
        password: password || (clearPassword ? "-" : ""),
        has_password: stored,
        group: group.trim(),
      }),
    );
  };

  const del = () => {
    if (!value || !confirm("Delete this proxy? Servers using it will connect directly.")) return;
    void run(() => db.deleteSshProxy(value.id));
  };

  return (
    <FormShell
      footer={
        <FormButtons
          onSave={save}
          saveLabel={value ? "Save" : "Create"}
          busy={busy}
          error={error}
          onDelete={value ? del : undefined}
          onClose={onClose}
        />
      }
    >
      <Card
        icon={Waypoints}
        title="Proxy"
        aside={<span className="truncate font-mono">{`${kind === "socks5" ? "socks5" : "http"}://${host.trim() || "host"}:${port}`}</span>}
      >
        <F label="Label">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="office socks" autoFocus />
        </F>
        <F label="Type">
          <Segmented
            fill
            options={[
              { value: "socks5", label: "SOCKS5" },
              { value: "http", label: "HTTP" },
            ]}
            value={kind}
            onChange={pickKind}
          />
        </F>
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <F label="Host">
            <Input mono value={host} onChange={(e) => setHost(e.target.value)} placeholder="proxy.example.com" />
          </F>
          <F label="Port">
            <Input mono value={port} onChange={(e) => setPort(e.target.value)} />
          </F>
        </div>
        <GroupField value={group} onChange={setGroup} groups={groups} />
      </Card>

      <Card icon={Lock} title="Authentication" aside="optional">
        <F label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="none" autoComplete="off" />
        </F>
        <F label="Password" hint={stored ? "Leave blank to keep the stored one." : undefined}>
          <SecretInput
            value={password}
            onChange={setPassword}
            placeholder={stored ? "•••••••• stored" : "none"}
            shown={showPassword}
            onToggleShown={password ? () => setShowPassword((v) => !v) : undefined}
            onClear={
              stored
                ? () => {
                    setClearPassword(true);
                    setPassword("");
                  }
                : undefined
            }
          />
        </F>
      </Card>
    </FormShell>
  );
}
