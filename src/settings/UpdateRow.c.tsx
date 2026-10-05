import { ExternalLink, RefreshCw } from "lucide-react";
import { APP_VERSION } from "../core/types.i";
import { checkForUpdate, openRelease, useUpdates } from "../core/updates.u";
import { Alert, Button, SettingRow, Spinner } from "../components";

/** Settings → About: is there a newer release on GitHub? Links to it — no auto-install. */
export function UpdateRow() {
  const u = useUpdates();

  const hint =
    u.phase === "checking"
      ? "Checking GitHub releases…"
      : u.phase === "available"
        ? `Version ${u.version} is out — you have ${APP_VERSION}. Download it from the release page.`
        : u.phase === "none"
          ? `You have the latest version (${APP_VERSION}).`
          : "Checks the GitHub releases for a newer version.";

  return (
    <>
      <SettingRow title="Updates" hint={hint}>
        {u.phase === "available" ? (
          <Button variant="primary" icon={<ExternalLink size={13} />} onClick={() => void openRelease()}>
            Open release {u.version}
          </Button>
        ) : (
          <Button
            icon={u.phase === "checking" ? <Spinner size={13} /> : <RefreshCw size={13} />}
            disabled={u.phase === "checking"}
            onClick={() => void checkForUpdate()}
          >
            Check for updates
          </Button>
        )}
      </SettingRow>
      {u.phase === "available" && u.notes && (
        <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--bg-input)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {u.notes}
        </div>
      )}
      {u.phase === "error" && <Alert>Could not check for updates: {u.error}</Alert>}
    </>
  );
}
