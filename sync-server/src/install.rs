//! `sudo ./gravitation-sync install` — sets the server up on Debian/Ubuntu
//! in one go: copies itself to /usr/local/bin, creates the service user,
//! writes the systemd unit and starts it. Run it again with a newer binary
//! to update. `uninstall` removes the service but keeps the data.

use std::path::Path;
use std::process::Command;

const BIN: &str = "/usr/local/bin/gravitation-sync";
const UNIT: &str = "/etc/systemd/system/gravitation-sync.service";
const ENV: &str = "/etc/gravitation-sync.env";
const USER: &str = "gravitation-sync";
const DATA: &str = "/var/lib/gravitation-sync";
const UNIT_TEXT: &str = include_str!("../deploy/gravitation-sync.service");

fn sh(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd).args(args).output().map_err(|e| format!("cannot run {cmd}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{cmd} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn is_root() -> bool {
    sh("id", &["-u"]).map(|u| u == "0").unwrap_or(false)
}

pub fn service_user_exists() -> bool {
    Command::new("id").arg(USER).output().map(|o| o.status.success()).unwrap_or(false)
}

/// Runs this binary again as the service user (so the database keeps its
/// owner when an admin command is started with sudo).
pub fn rerun_as_service_user(args: &[String]) -> Result<(), String> {
    let status = Command::new("runuser")
        .args(["-u", USER, "--", BIN])
        .args(args)
        .status()
        .map_err(|e| format!("cannot run runuser: {e}"))?;
    std::process::exit(status.code().unwrap_or(1));
}

fn tailscale_ip() -> Option<String> {
    sh("tailscale", &["ip", "-4"]).ok()?.lines().next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn install(listen: Option<String>) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("install works on Linux (Debian/Ubuntu with systemd)".into());
    }
    if !is_root() {
        return Err("run it with sudo: sudo ./gravitation-sync install".into());
    }
    let fresh = !Path::new(ENV).exists();

    // 1. Address: given, kept from the last install, or the Tailscale IP.
    let listen = match listen {
        Some(l) => Some(l),
        None if !fresh => None,
        None => match tailscale_ip() {
            Some(ip) => Some(format!("{ip}:8443")),
            None => {
                return Err(
                    "Tailscale is not running here. Start it (sudo tailscale up) or give the address: sudo ./gravitation-sync install --listen 0.0.0.0:8443"
                        .into(),
                )
            }
        },
    };

    // 2. The binary itself (temp + rename: works while the old one runs).
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    if me != Path::new(BIN) {
        let tmp = format!("{BIN}.new");
        std::fs::copy(&me, &tmp).map_err(|e| format!("cannot copy to {BIN}: {e}"))?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, BIN).map_err(|e| format!("cannot install {BIN}: {e}"))?;
    }

    // 3. Unprivileged service user.
    if !service_user_exists() {
        sh("useradd", &["--system", "--home-dir", DATA, "--shell", "/usr/sbin/nologin", USER])?;
    }

    // 4. Settings + unit.
    if let Some(l) = &listen {
        std::fs::write(ENV, format!("# gravitation-sync settings (see README)\nGSYNC_LISTEN={l}\n"))
            .map_err(|e| format!("cannot write {ENV}: {e}"))?;
    }
    std::fs::write(UNIT, UNIT_TEXT).map_err(|e| format!("cannot write {UNIT}: {e}"))?;

    // 5. Start (or restart after an update).
    sh("systemctl", &["daemon-reload"])?;
    sh("systemctl", &["enable", "gravitation-sync"])?;
    sh("systemctl", &["restart", "gravitation-sync"])?;
    std::thread::sleep(std::time::Duration::from_secs(2));
    if sh("systemctl", &["is-active", "gravitation-sync"]).as_deref() != Ok("active") {
        return Err("the service did not start — see: journalctl -u gravitation-sync -n 30".into());
    }

    let addr = std::fs::read_to_string(ENV)
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("GSYNC_LISTEN=").map(str::to_string)))
        .unwrap_or_default();
    let url = format!("http://{}", addr.replace("0.0.0.0", "<server-ip>"));
    if fresh {
        let invite = sh("runuser", &["-u", USER, "--", BIN, "--data", DATA, "invite"])?;
        println!("✓ gravitation-sync is running on {url}");
        println!();
        println!("  In Gravitation: Settings → Sync → First device — create account");
        println!("    Server address: {url}");
        println!("    Invite code:    {invite}   (one use, 24 h)");
        println!();
        println!("  More invites: sudo gravitation-sync invite");
        println!("  Logs:         journalctl -u gravitation-sync -f");
    } else {
        println!("✓ updated and restarted ({url})");
    }
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    if !is_root() {
        return Err("run it with sudo".into());
    }
    let _ = sh("systemctl", &["disable", "--now", "gravitation-sync"]);
    let _ = std::fs::remove_file(UNIT);
    let _ = sh("systemctl", &["daemon-reload"]);
    let _ = std::fs::remove_file(BIN);
    let _ = std::fs::remove_file(ENV);
    println!("removed the service; the data is still in {DATA} (delete it yourself if you want)");
    Ok(())
}
