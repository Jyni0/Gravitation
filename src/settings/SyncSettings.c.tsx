/**
 * Settings → Sync: optional sync through the user's own gravitation-sync
 * server (see /sync-server). Off = the app is purely local.
 *
 * Connecting: the first device creates the account with an invite code from
 * the server; other devices join with the setup code shown here plus the
 * passphrase. Everything is end-to-end encrypted in Rust (sync.rs) — this
 * page never holds keys, only what the user types.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Eye, KeyRound, Lock, RefreshCw, RotateCcwKey, ShieldCheck } from "lucide-react";
import * as db from "../core/db.r";
import type { SyncStatus } from "../core/db.r";
import { Alert, Button, Field, Input, Segmented, SettingRow, SettingsCard, Sep, Spinner, TextArea } from "../components";

export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    void db.syncStatus().then(setStatus).catch(() => {});
    let off: (() => void) | undefined;
    void db.onSyncEvent({ onStatus: setStatus }).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);

  if (!status) return null;
  return status.enabled ? (
    <Connected status={status} />
  ) : (
    <Connect notice={status.notice} onDone={() => void db.syncStatus().then(setStatus)} />
  );
}

/* ---------- off: create an account or join one ---------- */

type Mode = "create" | "join";

function Connect({ notice, onDone }: { notice: string; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>("create");
  const [url, setUrl] = useState("");
  const [invite, setInvite] = useState("");
  const [code, setCode] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mismatch = mode === "create" && pass2.length > 0 && pass !== pass2;
  const ready =
    pass.length >= 10 &&
    (mode === "create" ? url.trim() && invite.trim() && pass === pass2 : code.trim().length > 0);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "create") await db.syncCreate(url, invite, pass);
      else await db.syncJoin(code, pass);
      setPass("");
      setPass2("");
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="warning">{notice}</Alert>}
      <SettingsCard>
        <SettingRow
          title="Sync is off"
          hint="Everything stays on this device. Connect your own gravitation-sync server to keep servers, keys, scripts and proxies the same on every device."
        />
        <Sep />
        <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-[var(--text-dim)]">
          <ShieldCheck size={15} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <span>
            End-to-end encrypted. Units are encrypted on this device with a key made from your passphrase and a random
            secret key; the server stores only ciphertext and never learns either of them.
          </span>
        </div>
      </SettingsCard>

      <SettingsCard>
        <Segmented<Mode>
          fill
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError("");
          }}
          options={[
            { value: "create", label: "First device — create account" },
            { value: "join", label: "Join with setup code" },
          ]}
        />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          {mode === "create" ? (
            <>
              <Field label="Server address" hint="Where gravitation-sync runs, e.g. https://sync.example.com">
                <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://sync.example.com" autoFocus />
              </Field>
              <Field label="Invite code" hint={<>Run <code className="font-mono">gravitation-sync invite</code> on the server. One code makes one account.</>}>
                <Input mono value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="INV-XXXXXX-XXXXXX-XXXXXX-XXXXXX" />
              </Field>
            </>
          ) : (
            <Field label="Setup code" hint="On a connected device: Settings → Sync → Show setup code.">
              <TextArea mono rows={3} value={code} onChange={(e) => setCode(e.target.value)} placeholder="GSYNC1.…" autoFocus />
            </Field>
          )}
          <Field
            label="Passphrase"
            hint={
              mode === "create"
                ? "At least 10 characters. It cannot be reset — without it no device can read the synced data."
                : "The passphrase chosen on the first device."
            }
          >
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          {mode === "create" && (
            <Field label="Repeat passphrase" hint={mismatch ? "The passphrases differ." : undefined}>
              <Input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
            </Field>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={!ready || busy} icon={busy ? <Spinner size={13} /> : undefined}>
              {mode === "create" ? "Create account and sync" : "Connect and sync"}
            </Button>
            {busy && <span className="text-[12px] text-[var(--text-dim)]">Deriving keys and syncing…</span>}
          </div>
        </form>
      </SettingsCard>
    </div>
  );
}

/* ---------- on: status, setup code, disconnect ---------- */

function Connected({ status }: { status: SyncStatus }) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"off" | "wipe" | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  // "2 min ago" stays current.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const syncing = status.state === "syncing";

  const reveal = async () => {
    try {
      setCode(await db.syncSetupCode());
    } catch (e) {
      setError(String(e));
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const disconnect = async (wipe: boolean) => {
    setBusy(true);
    setError("");
    try {
      await db.syncDisconnect(wipe);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {status.locked && <Unlock />}
      <SettingsCard>
        <SettingRow title="Server" hint={<span className="font-mono">{status.url}</span>}>
          <Button
            icon={syncing ? <Spinner size={13} /> : <RefreshCw size={13} />}
            disabled={syncing}
            onClick={() => void db.syncNow().catch(() => {})}
          >
            Sync now
          </Button>
        </SettingRow>
        <Sep />
        <SettingRow title="Status" hint={statusLine(status)}>
          <span
            className={
              "h-2 w-2 rounded-full " +
              (status.state === "error" ? "bg-[var(--diff-del)]" : syncing ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--diff-add)]")
            }
          />
        </SettingRow>
        {status.state === "error" && status.error && <Alert>{status.error}</Alert>}
      </SettingsCard>

      <SettingsCard>
        <SettingRow
          title="Add another device"
          hint="On the other device choose “Join with setup code”, paste this code and enter the passphrase. Keep the code private: it is half of the key."
        >
          {!code && (
            <Button icon={<Eye size={13} />} onClick={() => void reveal()}>
              Show setup code
            </Button>
          )}
        </SettingRow>
        {code && (
          <div className="flex items-start gap-2">
            <TextArea mono readOnly rows={3} value={code} className="flex-1 text-[11.5px]" onFocus={(e) => e.currentTarget.select()} />
            <div className="flex flex-col gap-2">
              <Button icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" onClick={() => setCode("")}>
                Hide
              </Button>
            </div>
          </div>
        )}
        <Sep />
        <div className="flex items-start gap-2.5 text-[12px] leading-relaxed text-[var(--text-dim)]">
          <KeyRound size={14} strokeWidth={1.7} className="mt-0.5 shrink-0" />
          <span>
            Synced: servers, credentials, scripts, proxies and the order of groups. Logs, terminal settings and which
            groups are collapsed stay on each device.
          </span>
        </div>
      </SettingsCard>

      <ResetKeys onCode={setCode} />

      <SettingsCard>
        <SettingRow title="Turn sync off" hint="This device stops syncing. Its units stay here, the server keeps its copy for the other devices.">
          {confirm === "off" ? (
            <span className="flex items-center gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void disconnect(false)}>
                Turn off
              </Button>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
            </span>
          ) : (
            <Button variant="danger-ghost" onClick={() => setConfirm("off")}>
              Turn off
            </Button>
          )}
        </SettingRow>
        <Sep />
        <SettingRow
          title="Delete the account on the server"
          hint="Removes every synced item from the server and turns sync off here. Units on your devices are not touched."
        >
          {confirm === "wipe" ? (
            <span className="flex items-center gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void disconnect(true)}>
                Delete
              </Button>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
            </span>
          ) : (
            <Button variant="danger-ghost" onClick={() => setConfirm("wipe")}>
              Delete account
            </Button>
          )}
        </SettingRow>
        {error && <Alert>{error}</Alert>}
      </SettingsCard>
    </div>
  );
}

/**
 * Locked device: servers open when the sync server confirms this device,
 * or offline with the passphrase.
 */
function Unlock() {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await db.syncUnlock(pass);
      setPass("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard className="border-amber-500/40">
      <SettingRow
        title={
          <span className="flex items-center gap-1.5">
            <Lock size={13} className="text-amber-500" /> Servers are locked
          </span>
        }
        hint="The sync server has not confirmed this device yet, so connecting, passwords and keys stay closed. It opens by itself as soon as the server answers. Offline? Unlock with your passphrase."
      />
      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pass && !busy) void submit();
        }}
      >
        <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase" autoComplete="current-password" />
        <Button type="submit" variant="primary" disabled={!pass || busy} icon={busy ? <Spinner size={13} /> : <Lock size={13} />}>
          Unlock
        </Button>
      </form>
      {error && <Alert>{error}</Alert>}
    </SettingsCard>
  );
}

/**
 * Passphrase reset — also the answer to a lost or stolen device: new keys,
 * every other device signed out and wiped of its synced units, the data
 * kept on the server (and here).
 */
function ResetKeys({ onCode }: { onCode: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const mismatch = pass2.length > 0 && pass !== pass2;
  const ready = current.length > 0 && pass.length >= 10 && pass === pass2;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      onCode(await db.syncResetKeys(current, pass));
      setDone(true);
      setOpen(false);
      setCurrent("");
      setPass("");
      setPass2("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard>
      <SettingRow
        title="Reset passphrase and sign out other devices"
        hint="For a lost or stolen device, or a leaked passphrase or setup code. New keys are made here; every other device is signed out and removes its synced units the next time it goes online. Everything stays on the server and on this device — rejoin your devices with the new setup code."
      >
        {!open && (
          <Button
            variant="danger-ghost"
            icon={<RotateCcwKey size={13} />}
            onClick={() => {
              setOpen(true);
              setDone(false);
            }}
          >
            Reset…
          </Button>
        )}
      </SettingRow>
      {done && <Alert tone="success">Done. Other devices are signed out; the new setup code is shown above.</Alert>}
      {open && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void submit();
          }}
        >
          <Field label="Current passphrase">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          </Field>
          <Field label="New passphrase" hint="At least 10 characters.">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Repeat new passphrase" hint={mismatch ? "The passphrases differ." : undefined}>
            <Input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
          </Field>
          {error && <Alert>{error}</Alert>}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="danger" disabled={!ready || busy} icon={busy ? <Spinner size={13} /> : undefined}>
              Reset and sign out other devices
            </Button>
            <Button onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </SettingsCard>
  );
}

function statusLine(s: SyncStatus): string {
  if (s.state === "syncing") return "Syncing…";
  if (s.state === "error") return s.last_ok ? `Last synced ${ago(s.last_ok)} — the last attempt failed` : "Not synced yet";
  if (!s.last_ok) return "Waiting for the first sync";
  return `Synced ${ago(s.last_ok)}` + (s.items ? ` · ${s.items} item${s.items === 1 ? "" : "s"}` : "");
}

function ago(sec: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(sec * 1000).toLocaleString();
}
