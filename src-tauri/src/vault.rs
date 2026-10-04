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

fn load_master() -> [u8; 32] {
    // 1. Cached in memory.
    if let Ok(guard) = MASTER.lock() {
        if let Some(k) = guard.as_ref() {
            return *k;
        }
    }
    // 2. OS credential store.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        if let Some(key) = entry.get_password().ok().and_then(|b64| key_from_b64(&b64)) {
            cache_master(key);
            return key;
        }
        // First run: create and persist a fresh key.
        let key = Key::<Aes256Gcm>::generate();
        let bytes: [u8; 32] = key.into();
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        if entry.set_password(&b64).is_ok() {
            cache_master(bytes);
            return bytes;
        }
    }
    // 3. Fallback file (still out-of-band from the database).
    if let Some(dir) = fallback_path() {
        let path = dir.join("vault.key");
        if let Some(key) = std::fs::read_to_string(&path).ok().and_then(|b64| key_from_b64(&b64)) {
            cache_master(key);
            return key;
        }
        let key = Key::<Aes256Gcm>::generate();
        let bytes: [u8; 32] = key.into();
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let _ = std::fs::create_dir_all(&dir);
        if std::fs::write(&path, b64).is_ok() {
            cache_master(bytes);
            return bytes;
        }
    }
    // 4. Last resort: ephemeral key — secrets decrypt only this session.
    let key = Key::<Aes256Gcm>::generate();
    key.into()
}

fn cache_master(key: [u8; 32]) {
    if let Ok(mut guard) = MASTER.lock() {
        *guard = Some(key);
    }
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

