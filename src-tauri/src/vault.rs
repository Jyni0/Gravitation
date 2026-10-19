//! Secrets at rest — the vault.
//!
//! Every credential (server password, private key, key passphrase) is stored
//! in SQLite only as AES-256-GCM ciphertext, base64 with an `enc:v1:` marker.
//! The 32-byte master key never lives in the database: it is kept in the OS
//! credential store (Windows Credential Manager via the `keyring` crate);
//! if that is unavailable the fallback is a file in the app-data dir.
//!
//! Legacy plaintext values (rows written before the vault existed) decrypt
//! as themselves and are re-encrypted on the next save.

use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;

const MARKER: &str = "enc:v1:";
const KEYRING_SERVICE: &str = "gravitation.vault";
const KEYRING_USER: &str = "master-key";

static MASTER: Mutex<Option<[u8; 32]>> = Mutex::new(None);

fn fallback_path() -> Option<PathBuf> {
    app_data_dir("com.gravitation.app")
}

/// An app's data dir without a Tauri handle: mirror of db::db_path's location.
pub fn app_data_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").ok()?;
        Some(PathBuf::from(base).join(identifier))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".local/share").join(identifier))
    }
}

/// A 32-byte key from its base64 form.
fn key_from_b64(b64: &str) -> Option<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    bytes.try_into().ok()
}

/// Singularity's master key (the SSH units were saved there before the
/// split) — read only, never created: without it there is nothing to import.
pub fn singularity_key() -> Option<[u8; 32]> {
    if let Some(k) = keyring::Entry::new("singularity.vault", KEYRING_USER)
        .and_then(|e| e.get_password())
        .ok()
        .and_then(|b64| key_from_b64(&b64))
    {
        return Some(k);
    }
    let path = app_data_dir("com.singularity.app")?.join("vault.key");
    key_from_b64(&std::fs::read_to_string(path).ok()?)
}

/// The master key. Held under one lock from lookup to creation, so two
/// threads on first run can never each make (and store) a different key.
/// A NEW key is made only when none exists anywhere: an existing key is
/// never overwritten — that would leave every stored secret unreadable.
fn load_master() -> [u8; 32] {
    let mut guard = MASTER.lock().unwrap_or_else(|e| e.into_inner());
    // 1. Cached in memory.
    if let Some(k) = guard.as_ref() {
        return *k;
    }
    let (key, lasting) = find_or_create_master();
    // A stand-in key (store unreachable) is not remembered: the next call
    // looks for the real one again instead of using it all session.
    if lasting {
        *guard = Some(key);
    }
    key
}

/// The key, and whether it is the real (persisted) one.
fn find_or_create_master() -> ([u8; 32], bool) {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok();
    let file = fallback_path().map(|d| d.join("vault.key"));

    // 2. OS credential store — a busy store gets a few more tries.
    let mut read = entry.as_ref().map(|e| e.get_password());
    for _ in 0..3 {
        if !matches!(read, Some(Err(ref e)) if !matches!(e, keyring::Error::NoEntry)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        read = entry.as_ref().map(|e| e.get_password());
    }
    let keyring_missing = match read {
        Some(Ok(b64)) => match key_from_b64(&b64) {
            Some(k) => return (k, true),
            None => {
                eprintln!("[vault] the stored master key is malformed — not replacing it");
                false
            }
        },
        Some(Err(keyring::Error::NoEntry)) => true,
        Some(Err(e)) => {
            // Locked / unavailable right now: NOT "no key" — creating one
            // here would orphan every secret sealed with the real key.
            eprintln!("[vault] credential store unavailable: {e}");
            false
        }
        None => false,
    };

    // 3. Fallback file (still out-of-band from the database).
    if let Some(k) = file.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|b64| key_from_b64(&b64)) {
        // Keep a copy in the credential store when it has none yet.
        if keyring_missing {
            if let Some(e) = &entry {
                let _ = e.set_password(&base64::engine::general_purpose::STANDARD.encode(k));
            }
        }
        return (k, true);
    }

    // 4. Nothing anywhere: first run — create one and persist it.
    let bytes: [u8; 32] = Key::<Aes256Gcm>::generate().into();
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    if keyring_missing {
        if let Some(e) = &entry {
            if e.set_password(&b64).is_ok() {
                return (bytes, true);
            }
        }
    }
    if let Some(path) = &file {
        if !path.exists() {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if std::fs::write(path, &b64).is_ok() {
                return (bytes, true);
            }
        }
    }
    // 5. Last resort: a stand-in, not remembered (see load_master). Secrets
    //    sealed with it can't be opened later; stored ones simply fail to
    //    open meanwhile (clear error, and sync leaves them alone).
    eprintln!("[vault] master key unavailable — using a temporary key");
    (bytes, false)
}

/// True when the master key is safely persisted (keyring or file).
pub fn vault_backed() -> bool {
    if keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|e| e.get_password())
        .is_ok()
    {
        return true;
    }
    fallback_path()
        .map(|d| d.join("vault.key").exists())
        .unwrap_or(false)
}

/// Encrypts a secret: `enc:v1:<base64(nonce || ciphertext || tag)>`.
/// Empty input stays empty (nothing to protect).
pub fn encrypt(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    let master = load_master();
    let cipher = Aes256Gcm::new(&master.into());
    let nonce = Nonce::generate();
    match cipher.encrypt(&nonce, plain.as_bytes()) {
        Ok(ct) => {
            let mut buf = nonce.to_vec();
            buf.extend_from_slice(&ct);
            format!("{MARKER}{}", base64::engine::general_purpose::STANDARD.encode(buf))
        }
        Err(e) => {
            eprintln!("[vault] encrypt failed: {e}");
            plain.to_string()
        }
    }
}

/// Decrypts a vault value. Legacy plaintext passes through unchanged.
pub fn decrypt(stored: &str) -> String {
    if !stored.starts_with(MARKER) {
        return stored.to_string(); // legacy plaintext or empty
    }
    decrypt_with(&load_master(), stored).unwrap_or_default()
}

/// Decrypts a vault value; None when it does not open (unlike `decrypt`,
/// a failure is not mistaken for an empty secret).
pub fn try_decrypt(stored: &str) -> Option<String> {
    decrypt_with(&load_master(), stored)
}

/// Decrypts a secret that is about to be USED (connecting): one that is
/// stored but does not open is an error naming `what`, never an empty
/// value — that looked like "no password configured" and hid the cause.
pub fn open_secret(stored: &str, what: &str) -> Result<String, String> {
    try_decrypt(stored).ok_or_else(|| {
        format!("the saved {what} can't be decrypted on this device (its vault key changed) — enter it again in the settings")
    })
}

/// Decrypts a vault value with a given master key (None = it does not open).
pub fn decrypt_with(master: &[u8; 32], stored: &str) -> Option<String> {
    let Some(b64) = stored.strip_prefix(MARKER) else {
        return Some(stored.to_string());
    };
    let buf = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if buf.len() < 12 {
        return None;
    }
    let cipher = Aes256Gcm::new(&(*master).into());
    let (nonce, ct) = buf.split_at(12);
    let nonce = Nonce::try_from(nonce).ok()?;
    match cipher.decrypt(&nonce, ct) {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) => {
            eprintln!("[vault] decrypt failed: {e}");
            None
        }
    }
}

