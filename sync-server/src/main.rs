//! gravitation-sync — the sync server of Gravitation.
//!
//! Zero-knowledge by design: clients encrypt every unit (AES-256-GCM, keys
//! derived from the user's passphrase + secret key) before it leaves the
//! device, and authenticate with an Ed25519 signature derived from the same
//! secrets. The server stores opaque blobs and public keys — a stolen
//! database or a compromised host reveals nothing but sizes and timestamps.
//!
//! Commands:
//!   serve           run the HTTP(S) API
//!   invite          print a one-time code that lets a device create an account
//!   accounts        list accounts
//!   delete-account  remove an account and all its data
//!   revoke          sign every device of an account out
//!   install         set up / update the systemd service (Linux, sudo)
//!   uninstall       remove the service (data stays)

mod api;
#[cfg(unix)]
mod install;
mod limit;
mod store;

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "gravitation-sync", version, about = "Gravitation sync server (end-to-end encrypted)")]
struct Cli {
    /// Directory of the database (created if missing).
    #[arg(long, global = true, env = "GSYNC_DATA", default_value = "/var/lib/gravitation-sync")]
    data: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the API server.
    Serve {
        /// Address to listen on.
        #[arg(long, env = "GSYNC_LISTEN", default_value = "0.0.0.0:8443")]
        listen: SocketAddr,
        /// TLS certificate chain (PEM). Without it the server speaks plain
        /// HTTP — only behind a TLS reverse proxy (Caddy, nginx) or on localhost.
        #[arg(long, env = "GSYNC_TLS_CERT", requires = "tls_key")]
        tls_cert: Option<PathBuf>,
        /// TLS private key (PEM).
        #[arg(long, env = "GSYNC_TLS_KEY", requires = "tls_cert")]
        tls_key: Option<PathBuf>,
        /// Take the client IP from X-Forwarded-For (set only behind your own
        /// reverse proxy — otherwise clients can spoof it past the rate limits).
        #[arg(long, env = "GSYNC_TRUST_PROXY")]
        trust_proxy: bool,
    },
    /// Create a one-time invite code (a new account needs one).
    Invite {
        /// Hours until the code expires.
        #[arg(long, default_value_t = 24)]
        hours: u64,
    },
    /// List accounts.
    Accounts,
    /// Delete an account and everything stored for it.
    DeleteAccount {
        /// Account id (or a unique prefix of it).
        id: String,
    },
    /// Sign every device of an account out (they log in again on their own
    /// if they still know the secrets).
    Revoke {
        /// Account id (or a unique prefix of it).
        id: String,
    },
    /// Install or update the service: `sudo ./gravitation-sync install`.
    /// Listens on the Tailscale IP by default.
    Install {
        /// Address to listen on instead of <tailscale-ip>:8443.
        #[arg(long)]
        listen: Option<String>,
    },
    /// Remove the service (the data in /var/lib/gravitation-sync stays).
    Uninstall,
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match &cli.cmd {
        #[cfg(unix)]
        Cmd::Install { listen } => return install::install(listen.clone()),
        #[cfg(unix)]
        Cmd::Uninstall => return install::uninstall(),
        #[cfg(not(unix))]
        Cmd::Install { .. } | Cmd::Uninstall => return Err("install works on Linux".into()),
        Cmd::Serve { .. } => {}
        // `sudo gravitation-sync invite` just works: admin commands run as
        // the service user, so the database keeps its owner.
        #[cfg(unix)]
        _ if install::is_root() && install::service_user_exists() => {
            let args: Vec<String> = std::env::args().skip(1).collect();
            return install::rerun_as_service_user(&args);
        }
        _ => {}
    }
    let store = store::Store::open(&cli.data)?;
    match cli.cmd {
        Cmd::Serve { listen, tls_cert, tls_key, trust_proxy } => {
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            rt.block_on(api::serve(store, listen, tls_cert.zip(tls_key), trust_proxy))
        }
        Cmd::Invite { hours } => {
            let code = store.create_invite(hours.clamp(1, 24 * 30))?;
            println!("{code}");
            eprintln!("One-time invite, valid {hours} h. Enter it in Gravitation → Settings → Sync → Create account.");
            Ok(())
        }
        Cmd::Accounts => {
            let rows = store.accounts()?;
            if rows.is_empty() {
                println!("no accounts");
            }
            for a in rows {
                println!(
                    "{}  items={}  devices={}  created={}  last_seen={}",
                    a.id,
                    a.items,
                    a.sessions,
                    store::fmt_time(a.created_at),
                    a.last_seen.map(store::fmt_time).unwrap_or_else(|| "never".into())
                );
            }
            Ok(())
        }
        Cmd::Install { .. } | Cmd::Uninstall => unreachable!(),
        Cmd::DeleteAccount { id } => {
            let id = store.resolve_account(&id)?;
            store.delete_account(&id)?;
            println!("deleted {id}");
            Ok(())
        }
        Cmd::Revoke { id } => {
            let id = store.resolve_account(&id)?;
            let n = store.revoke_sessions(&id)?;
            println!("revoked {n} session(s) of {id}");
            Ok(())
        }
    }
}

/// Fresh random bytes from the OS.
pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    b
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
