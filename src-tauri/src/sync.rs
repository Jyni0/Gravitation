//! Sync — optional, end-to-end encrypted sync of the units through a
//! self-hosted `gravitation-sync` server (see /sync-server).
//!
//! Off by default: the app is fully local until the user connects a server
//! in Settings → Sync.
//!
//! Secrets and keys
//! - The account is two secrets: a passphrase the user knows and a random
//!   128-bit secret key generated on the first device (travels to other
//!   devices inside the setup code). Argon2id(passphrase) + secret key →
//!   HKDF → master key; from it: an Ed25519 login key, an AES-256-GCM data
//!   key, and HMAC keys for item ids and change hashes.
//! - The server gets only the Ed25519 PUBLIC key and ciphertext. A stolen
//!   server database cannot be brute-forced: the secret key is not on it.
//! - Locally the setup secrets sit in the settings table vault-encrypted,
//!   like every other credential.
//!
//! Items
//! - One server item per unit (server / key / script / proxy) and one for
//!   the group order. Its id is HMAC(kind:id), so the server does not even
//!   see what kind of thing it holds. Payload: {k, i, v, d, r} encrypted with
//!   the item id as associated data (blobs cannot be swapped between ids).
//! - `v` is a per-item version: an older payload replayed by the server is
//!   ignored (no rollback). Deletions are encrypted tombstones, so nobody
//!   but a device of the account can delete anything.
//! - `sync_items` remembers per item what was last synced (HMAC hash of the
//!   content, version, server revision): a differing local hash = changed
//!   here, a missing row = deleted here. A unit changed on both sides keeps
//!   this device's version.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use aes_gcm::aead::{Aead, Generate, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use sqlx::Row;
use tauri::{AppHandle, Emitter};

use crate::ssh::sql;
use crate::vault;

const LOGIN_CONTEXT: &[u8] = b"gravitation-sync/login/v1\0";
const CODE_PREFIX: &str = "GSYNC1.";
const PUSH_BATCH: usize = 200;
const POLL: Duration = Duration::from_secs(60);
const MIN_PASSPHRASE: usize = 10;
/// Signed by the OLD key over the challenge and the NEW public key.
const ROTATE_CONTEXT: &[u8] = b"gravitation-sync/rotate/v1\0";
/// Login answer for a device whose keys were reset elsewhere.
const REVOKED: &str = "__revoked__";

/* ---------- what is synced ---------- */

struct Spec {
    kind: &'static str,
    table: &'static str,
    text: &'static [&'static str],
    int: &'static [&'static str],
    /// Vault-encrypted at rest: synced as plaintext INSIDE the encrypted payload.
    secret: &'static [&'static str],
}

const SPECS: &[Spec] = &[
    Spec {
        kind: "server",
        table: "ssh_servers",
        text: &["name", "host", "username", "auth", "key_id", "host_key", "os", "proxy_id", "group_name"],
        int: &["port", "sort_order", "created_at"],
        secret: &["password"],
    },
    Spec {
        kind: "key",
        table: "ssh_keys",
        text: &["name", "comment", "public_key", "fingerprint", "group_name"],
        int: &["sort_order", "created_at"],
        secret: &["private_key", "passphrase"],
    },
    Spec {
        kind: "script",
        table: "ssh_scripts",
        text: &["name", "description", "content", "group_name"],
        int: &["sort_order", "created_at"],
        secret: &[],
    },
    Spec {
        kind: "proxy",
        table: "ssh_proxies",
        text: &["name", "kind", "host", "username", "group_name"],
        int: &["port", "sort_order", "created_at"],
        secret: &["password"],
    },
];

/// Settings synced as items (kind "setting"): only the group ORDER of
/// ssh_unit_groups — which groups are collapsed stays per device.
const GROUPS_SETTING: &str = "ssh_unit_groups";

fn spec(kind: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.kind == kind)
}

/* ---------- keys ---------- */

struct Keys {
    sign: SigningKey,
    enc: [u8; 32],
    id: [u8; 32],
    mac: [u8; 32],
}

/// Passphrase + secret key + account → master key. Argon2id makes every
/// passphrase guess cost ~64 MiB and a fraction of a second.
fn derive_master(passphrase: &str, account: &str, secret: &[u8; 16]) -> Result<[u8; 32], String> {
    let params = argon2::Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| e.to_string())?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut pw = [0u8; 32];
    let salt = format!("gravitation-sync/v1/{account}");
    argon
        .hash_password_into(passphrase.as_bytes(), salt.as_bytes(), &mut pw)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    let mut ikm = pw.to_vec();
    ikm.extend_from_slice(secret);
    let hk = hkdf::Hkdf::<Sha256>::new(Some(account.as_bytes()), &ikm);
    let mut master = [0u8; 32];
    hk.expand(b"gravitation-sync v1 master", &mut master).map_err(|e| e.to_string())?;
    Ok(master)
}

fn keys_from(master: &[u8; 32]) -> Keys {
    let hk = hkdf::Hkdf::<Sha256>::from_prk(master).unwrap_or_else(|_| hkdf::Hkdf::<Sha256>::new(None, master));
    let sub = |label: &[u8]| {
        let mut out = [0u8; 32];
        let _ = hk.expand(label, &mut out);
        out
    };
    Keys {
        sign: SigningKey::from_bytes(&sub(b"login")),
        enc: sub(b"encrypt"),
        id: sub(b"item-id"),
        mac: sub(b"change-hash"),
    }
}

fn hmac_hex(key: &[u8; 32], data: &[u8]) -> String {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("hmac takes any key length");
    m.update(data);
    hex(&m.finalize().into_bytes())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    b
}

fn item_id(keys: &Keys, kind: &str, id: &str) -> String {
    hmac_hex(&keys.id, format!("{kind}\0{id}").as_bytes())
}

fn content_hash(keys: &Keys, kind: &str, id: &str, row: &Map<String, Value>) -> String {
    let body = serde_json::to_string(row).unwrap_or_default();
    hmac_hex(&keys.mac, format!("{kind}\0{id}\0{body}").as_bytes())
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    k: String,
    i: String,
    v: i64,
    #[serde(default)]
    d: bool,
    #[serde(default)]
    r: Map<String, Value>,
}

fn seal(keys: &Keys, item: &str, env: &Envelope) -> Result<String, String> {
    let cipher = Aes256Gcm::new(&keys.enc.into());
    let nonce = Nonce::generate();
    let plain = serde_json::to_vec(env).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(&nonce, Payload { msg: &plain, aad: item.as_bytes() })
        .map_err(|_| "encryption failed".to_string())?;
    let mut buf = nonce.to_vec();
    buf.extend_from_slice(&ct);
    Ok(B64.encode(buf))
}

fn open(keys: &Keys, item: &str, blob: &str) -> Option<Envelope> {
    let buf = B64.decode(blob).ok()?;
    if buf.len() < 28 {
        return None;
    }
    let (nonce, ct) = buf.split_at(12);
    let cipher = Aes256Gcm::new(&keys.enc.into());
    let plain = cipher.decrypt(&Nonce::try_from(nonce).ok()?, Payload { msg: ct, aad: item.as_bytes() }).ok()?;
    let env: Envelope = serde_json::from_slice(&plain).ok()?;
    // The payload must belong to the id it was stored under.
    (item_id(keys, &env.k, &env.i) == item).then_some(env)
}

/* ---------- setup code & stored config ---------- */

/// Crockford base32, grouped: how the secret key is shown and typed.
fn secret_to_text(b: &[u8; 16]) -> String {
    const A: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let (mut acc, mut bits, mut s) = (0u32, 0u32, String::new());
    for &x in b {
        acc = (acc << 8) | x as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            s.push(A[((acc >> bits) & 31) as usize] as char);
        }
    }
    s.push(A[((acc << (5 - bits)) & 31) as usize] as char);
    s.as_bytes().chunks(6).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

fn secret_from_text(t: &str) -> Option<[u8; 16]> {
    const A: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let (mut acc, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for c in t.chars().filter(|c| c.is_ascii_alphanumeric()) {
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            x => x,
        };
        acc = (acc << 5) | A.find(c)? as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out.try_into().ok()
}

#[derive(Serialize, Deserialize, Clone)]
struct Config {
    url: String,
    account: String,
}

#[derive(Serialize, Deserialize)]
struct Secrets {
    secret_key: String,
    master: String,
}

#[derive(Serialize, Deserialize)]
struct SetupCode {
    u: String,
    a: String,
    k: String,
}

async fn get_setting(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("value").ok())
}

async fn set_setting(pool: &sqlx::SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| format!("db error: {e}"))
}

async fn del_setting(pool: &sqlx::SqlitePool, key: &str) {
    let _ = sqlx::query("DELETE FROM settings WHERE key = $1").bind(key).execute(pool).await;
}

async fn load_config(pool: &sqlx::SqlitePool) -> Option<(Config, Keys)> {
    let cfg: Config = serde_json::from_str(&get_setting(pool, "sync_config").await?).ok()?;
    let sec: Secrets = serde_json::from_str(&vault::try_decrypt(&get_setting(pool, "sync_secret").await?)?).ok()?;
    let master: [u8; 32] = B64.decode(sec.master).ok()?.try_into().ok()?;
    Some((cfg, keys_from(&master)))
}

/// Normalizes and vets a server URL. Plain http is accepted only for
/// localhost and private networks — elsewhere a session token could be
/// sniffed (the data itself stays encrypted either way).
fn normalize_url(raw: &str) -> Result<String, String> {
    let mut u = raw.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return Err("Enter the address of your sync server.".into());
    }
    if !u.contains("://") {
        u = format!("https://{u}");
    }
    let (scheme, rest) = u.split_once("://").unwrap_or(("", ""));
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if host.starts_with('[') {
        host.split(']').next().unwrap_or("").trim_start_matches('[')
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    if host.is_empty() {
        return Err("This does not look like a server address.".into());
    }
    match scheme {
        "https" => Ok(u),
        "http" if is_private_host(host) => Ok(u),
        "http" => Err("Use https:// — plain http is allowed only on localhost and private networks.".into()),
        _ => Err("The address must start with https://".into()),
    }
}

fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".lan") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let o = ip.octets();
            ip.is_loopback() || ip.is_private() || (o[0] == 100 && (64..128).contains(&o[1])) // CGNAT / Tailscale
        }
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

/* ---------- status ---------- */

#[derive(Serialize, Clone, Default)]
pub struct Status {
    pub enabled: bool,
    pub url: String,
    /// "off" | "idle" | "syncing" | "error"
    pub state: String,
    /// Unix seconds of the last successful sync (0 = never).
    pub last_ok: i64,
    pub error: String,
    pub items: usize,
    /// Shown while sync is off: why it was turned off (a key reset elsewhere).
    pub notice: String,
    /// Sync is on but this device is not confirmed yet: servers, passwords
    /// and keys stay closed (see `ensure_access`).
    pub locked: bool,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);
/// When the server last confirmed this device (any authenticated answer).
static CONFIRMED: Mutex<Option<std::time::Instant>> = Mutex::new(None);
/// Opened offline with the passphrase (until the app restarts).
static UNLOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// How long one confirmation keeps the units open (the loop renews it every minute).
const LEASE: Duration = Duration::from_secs(5 * 60);
static TOKEN: Mutex<Option<String>> = Mutex::new(None);
static RUN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn notify() -> &'static tokio::sync::Notify {
    static N: OnceLock<tokio::sync::Notify> = OnceLock::new();
    N.get_or_init(tokio::sync::Notify::new)
}

/// A unit changed locally: sync soon (debounced in the loop).
pub fn nudge() {
    notify().notify_one();
}

fn confirm() {
    *CONFIRMED.lock().unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());
}

fn open_now() -> bool {
    UNLOCKED.load(std::sync::atomic::Ordering::Relaxed)
        || CONFIRMED
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some_and(|t| t.elapsed() < LEASE)
}

/// The gate in front of every unit secret (ssh.rs: connect, reveal, key
/// bodies). With sync off it is always open. With sync on, the server must
/// have confirmed this device within the last few minutes — otherwise one
/// sync is tried right now. A device whose keys were reset elsewhere is
/// wiped by that sync instead of being let in; an offline device opens only
/// with the passphrase (Settings → Sync).
pub async fn ensure_access(app: &AppHandle) -> Result<(), String> {
    if open_now() {
        return Ok(());
    }
    let pool = sql(app).await.ok_or("database unavailable")?;
    if get_setting(&pool, "sync_config").await.is_none() {
        return Ok(()); // sync off: purely local
    }
    // Boxed: sync_once can disconnect servers, which reaches load_server → here.
    let attempt = tokio::time::timeout(Duration::from_secs(20), Box::pin(sync_once(app))).await;
    if open_now() {
        return Ok(());
    }
    if get_setting(&pool, "sync_config").await.is_none() {
        return Err(off_notice()); // just revoked and wiped
    }
    let why = match attempt {
        Ok(Err(e)) => format!(" ({e})"),
        Err(_) => " (no answer)".into(),
        Ok(Ok(())) => String::new(),
    };
    Err(format!(
        "Locked: the sync server has not confirmed this device yet{why}. Servers open once it answers — or unlock offline with your passphrase in Settings → Sync."
    ))
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    let snapshot = {
        let mut g = STATUS.lock().unwrap_or_else(|p| p.into_inner());
        let s = g.get_or_insert_with(Status::default);
        f(s);
        s.locked = s.enabled && !open_now();
        s.clone()
    };
    let _ = app.emit("sync://status", snapshot);
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* ---------- HTTP ---------- */

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("Gravitation/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

/// Error text of a failed response: the server's {error} or the status.
async fn fail(res: reqwest::Response) -> String {
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    body.get("error")
        .and_then(Value::as_str)
        .map(|e| e.to_string())
        .unwrap_or_else(|| format!("server answered {status}"))
}

fn net(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The sync server did not answer in time.".into()
    } else if e.is_connect() {
        "Cannot reach the sync server.".into()
    } else {
        format!("Network error: {e}")
    }
}

async fn check_server(url: &str) -> Result<(), String> {
    let res = http().get(format!("{url}/v1/health")).send().await.map_err(net)?;
    let v: Value = res.json().await.map_err(|_| "This address is not a Gravitation sync server.".to_string())?;
    if v.get("service").and_then(Value::as_str) != Some("gravitation-sync") {
        return Err("This address is not a Gravitation sync server.".into());
    }
    if v.get("api").and_then(Value::as_i64) != Some(1) {
        return Err("The sync server speaks a different protocol version — update it or the app.".into());
    }
    Ok(())
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "device".into())
}

/// A one-time challenge from the server: (as sent, raw bytes).
async fn challenge(cfg: &Config) -> Result<(String, Vec<u8>), String> {
    let res = http()
        .post(format!("{}/v1/auth/challenge", cfg.url))
        .json(&json!({ "account": cfg.account }))
        .send()
        .await
        .map_err(net)?;
    if !res.status().is_success() {
        return Err(fail(res).await);
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    let challenge = v.get("challenge").and_then(Value::as_str).ok_or("bad challenge")?.to_string();
    let raw = B64.decode(&challenge).map_err(|_| "bad challenge")?;
    Ok((challenge, raw))
}

async fn login(cfg: &Config, keys: &Keys) -> Result<String, String> {
    let (challenge, raw) = challenge(cfg).await?;
    let mut msg = LOGIN_CONTEXT.to_vec();
    msg.extend_from_slice(cfg.account.as_bytes());
    msg.push(0);
    msg.extend_from_slice(&raw);
    let sig = keys.sign.sign(&msg).to_bytes();
    let res = http()
        .post(format!("{}/v1/auth/login", cfg.url))
        .json(&json!({ "account": cfg.account, "challenge": challenge, "signature": B64.encode(sig), "device": device_name() }))
        .send()
        .await
        .map_err(net)?;
    if res.status() == reqwest::StatusCode::FORBIDDEN {
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if v.get("code").and_then(Value::as_str) == Some("revoked") {
            return Err(REVOKED.into());
        }
        return Err("the server refused the login".into());
    }
    if !res.status().is_success() {
        return Err(fail(res).await);
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    let token = v.get("token").and_then(Value::as_str).ok_or("bad login answer")?.to_string();
    *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.clone());
    confirm();
    Ok(token)
}

async fn token(cfg: &Config, keys: &Keys) -> Result<String, String> {
    let cached = TOKEN.lock().unwrap_or_else(|p| p.into_inner()).clone();
    match cached {
        Some(t) => Ok(t),
        None => login(cfg, keys).await,
    }
}

/// An authenticated request; a 401 logs in again once.
async fn call(cfg: &Config, keys: &Keys, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<reqwest::Response, String> {
    for attempt in 0..2 {
        let t = token(cfg, keys).await?;
        let mut req = http().request(method.clone(), format!("{}{path}", cfg.url)).bearer_auth(&t);
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(net)?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = None;
            continue;
        }
        if res.status() != reqwest::StatusCode::FORBIDDEN {
            confirm();
        }
        return Ok(res);
    }
    Err("not signed in".into())
}

/* ---------- local side ---------- */

struct Local {
    kind: String,
    id: String,
    row: Map<String, Value>,
    hash: String,
}

#[derive(Clone, Default)]
struct State {
    kind: String,
    unit: String,
    /// "" = needs (re)push if present locally, "-" = deleted.
    hash: String,
    v: i64,
    rev: i64,
}

/// Servers saved before credentials existed kept their private key on the
/// server row; ssh.rs moves it into a credential on the next connect. Do it
/// now for all of them, so the key travels with the server (the legacy
/// column itself is not synced).
async fn migrate_inline_keys(pool: &sqlx::SqlitePool) {
    let Ok(rows) = sqlx::query("SELECT id, name, private_key FROM ssh_servers WHERE key_id = '' AND private_key != ''")
        .fetch_all(pool)
        .await
    else {
        return;
    };
    for r in rows {
        let id: String = r.try_get("id").unwrap_or_default();
        let name: String = r.try_get("name").unwrap_or_default();
        let Some(body) = vault::try_decrypt(&r.try_get::<String, _>("private_key").unwrap_or_default()) else { continue };
        if body.trim().is_empty() {
            continue;
        }
        let key_id = crate::ssh::unique_id("key");
        let ok = sqlx::query("INSERT INTO ssh_keys (id, name, private_key, passphrase, comment) VALUES ($1,$2,$3,'',$4)")
            .bind(&key_id)
            .bind(format!("{name} key"))
            .bind(vault::encrypt(body.trim()))
            .bind("Imported from server unit")
            .execute(pool)
            .await
            .is_ok();
        if ok {
            let _ = sqlx::query("UPDATE ssh_servers SET key_id = $1, private_key = '', auth = 'cred' WHERE id = $2")
                .bind(&key_id)
                .bind(&id)
                .execute(pool)
                .await;
        }
    }
}

/// Every synced thing as it is on this device, by item id. Units whose
/// secrets cannot be decrypted here are listed in the second set and left
/// alone (neither pushed nor treated as deleted).
async fn read_local(pool: &sqlx::SqlitePool, keys: &Keys) -> Result<(HashMap<String, Local>, HashSet<String>), String> {
    let mut out = HashMap::new();
    let mut unreadable = HashSet::new();
    for s in SPECS {
        let cols: Vec<&str> = s.text.iter().chain(s.int).chain(s.secret).copied().collect();
        let q = format!("SELECT id, {} FROM {}", cols.join(", "), s.table);
        let rows = sqlx::query(&q).fetch_all(pool).await.map_err(|e| format!("db error: {e}"))?;
        'rows: for r in rows {
            let id: String = r.try_get("id").unwrap_or_default();
            let mut row = Map::new();
            for c in s.text {
                row.insert((*c).into(), Value::String(r.try_get::<String, _>(*c).unwrap_or_default()));
            }
            for c in s.int {
                row.insert((*c).into(), Value::from(r.try_get::<i64, _>(*c).unwrap_or_default()));
            }
            let item = item_id(keys, s.kind, &id);
            for c in s.secret {
                let stored: String = r.try_get(*c).unwrap_or_default();
                match vault::try_decrypt(&stored) {
                    Some(p) => {
                        row.insert((*c).into(), Value::String(p));
                    }
                    None => {
                        unreadable.insert(item);
                        continue 'rows;
                    }
                }
            }
            let hash = content_hash(keys, s.kind, &id, &row);
            out.insert(item, Local { kind: s.kind.into(), id, row, hash });
        }
    }
    if let Some(order) = get_setting(pool, GROUPS_SETTING)
        .await
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("order").cloned())
        .filter(|o| o.as_object().is_some_and(|m| !m.is_empty()))
    {
        let mut row = Map::new();
        row.insert("order".into(), order);
        let hash = content_hash(keys, "setting", GROUPS_SETTING, &row);
        out.insert(item_id(keys, "setting", GROUPS_SETTING), Local { kind: "setting".into(), id: GROUPS_SETTING.into(), row, hash });
    }
    Ok((out, unreadable))
}

async fn read_state(pool: &sqlx::SqlitePool) -> Result<HashMap<String, State>, String> {
    let rows = sqlx::query("SELECT item, kind, unit_id, hash, v, rev FROM sync_items")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("db error: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                r.try_get("item").unwrap_or_default(),
                State {
                    kind: r.try_get("kind").unwrap_or_default(),
                    unit: r.try_get("unit_id").unwrap_or_default(),
                    hash: r.try_get("hash").unwrap_or_default(),
                    v: r.try_get("v").unwrap_or_default(),
                    rev: r.try_get("rev").unwrap_or_default(),
                },
            )
        })
        .collect())
}

async fn write_state(pool: &sqlx::SqlitePool, item: &str, s: &State) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO sync_items (item, kind, unit_id, hash, v, rev) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(item) DO UPDATE SET kind=$2, unit_id=$3, hash=$4, v=$5, rev=$6",
    )
    .bind(item)
    .bind(&s.kind)
    .bind(&s.unit)
    .bind(&s.hash)
    .bind(s.v)
    .bind(s.rev)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|e| format!("db error: {e}"))
}

/// Writes a unit (or the group order) received from another device.
async fn apply(pool: &sqlx::SqlitePool, env: &Envelope) -> Result<(), String> {
    if env.k == "setting" {
        if env.i != GROUPS_SETTING {
            return Ok(()); // a newer app's setting: not ours to write
        }
        let mut cur: Value = get_setting(pool, GROUPS_SETTING)
            .await
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({ "collapsed": [] }));
        if env.d {
            cur["order"] = json!({});
        } else {
            cur["order"] = env.r.get("order").cloned().unwrap_or_else(|| json!({}));
        }
        return set_setting(pool, GROUPS_SETTING, &cur.to_string()).await;
    }
    let Some(s) = spec(&env.k) else { return Ok(()) };
    if env.d {
        sqlx::query(&format!("DELETE FROM {} WHERE id = $1", s.table))
            .bind(&env.i)
            .execute(pool)
            .await
            .map_err(|e| format!("db error: {e}"))?;
        return Ok(());
    }
    let cols: Vec<&str> = s.text.iter().chain(s.int).chain(s.secret).copied().collect();
    let marks: Vec<String> = (2..=cols.len() + 1).map(|i| format!("${i}")).collect();
    let sets: Vec<String> = cols.iter().map(|c| format!("{c}=excluded.{c}")).collect();
    let q = format!(
        "INSERT INTO {} (id, {}) VALUES ($1, {}) ON CONFLICT(id) DO UPDATE SET {}",
        s.table,
        cols.join(", "),
        marks.join(", "),
        sets.join(", ")
    );
    let mut query = sqlx::query(&q).bind(&env.i);
    for c in s.text {
        query = query.bind(env.r.get(*c).and_then(Value::as_str).unwrap_or_default().to_string());
    }
    for c in s.int {
        let fallback = match *c {
            "port" => if s.kind == "server" { 22 } else { 1080 },
            "created_at" => now(),
            _ => 0,
        };
        query = query.bind(env.r.get(*c).and_then(Value::as_i64).unwrap_or(fallback));
    }
    for c in s.secret {
        query = query.bind(vault::encrypt(env.r.get(*c).and_then(Value::as_str).unwrap_or_default()));
    }
    query.execute(pool).await.map_err(|e| format!("db error: {e}"))?;
    Ok(())
}

/* ---------- one sync pass ---------- */

enum PassError {
    /// Another device pushed between our pull and push: pull again.
    Conflict,
    Fail(String),
}

impl From<String> for PassError {
    fn from(e: String) -> Self {
        PassError::Fail(e)
    }
}

async fn pass(pool: &sqlx::SqlitePool, cfg: &Config, keys: &Keys, on_applied: &(dyn Fn() + Sync)) -> Result<usize, PassError> {
    migrate_inline_keys(pool).await;
    let mut state = read_state(pool).await?;
    let (local, unreadable) = read_local(pool, keys).await?;
    let mut cursor: i64 = get_setting(pool, "sync_cursor").await.and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut applied: HashSet<String> = HashSet::new();

    // 1. Pull everything newer than the cursor.
    loop {
        let res = call(cfg, keys, reqwest::Method::GET, &format!("/v1/items?since={cursor}&limit=500"), None).await?;
        if !res.status().is_success() {
            return Err(PassError::Fail(fail(res).await));
        }
        let page: Value = res.json().await.map_err(|e| e.to_string())?;
        let items = page.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        for it in &items {
            let id = it.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let rev = it.get("rev").and_then(Value::as_i64).unwrap_or(0);
            let blob = it.get("blob").and_then(Value::as_str).unwrap_or_default();
            cursor = cursor.max(rev);
            let st = state.get(&id).cloned();
            let Some(env) = open(keys, &id, blob) else {
                // Not ours / corrupted: never applied. If we have the unit,
                // our copy overwrites it on the push below.
                let mut s = st.unwrap_or_default();
                s.rev = rev;
                s.hash = if s.hash == "-" { s.hash } else { String::new() };
                if !s.kind.is_empty() {
                    write_state(pool, &id, &s).await?;
                    state.insert(id, s);
                }
                continue;
            };
            let mut next = State { kind: env.k.clone(), unit: env.i.clone(), hash: String::new(), v: env.v, rev };
            if let Some(s) = &st {
                if env.v <= s.v {
                    // Our own push coming back, or a replayed old version.
                    let mut s = s.clone();
                    s.rev = s.rev.max(rev);
                    write_state(pool, &id, &s).await?;
                    state.insert(id, s);
                    continue;
                }
            }
            let mine = local.get(&id);
            let remote_hash = if env.d { "-".to_string() } else { content_hash(keys, &env.k, &env.i, &env.r) };
            if mine.is_some_and(|l| l.hash == remote_hash) {
                next.hash = remote_hash;
            } else {
                let changed_here = match (mine, &st) {
                    (Some(l), Some(s)) => l.hash != s.hash,
                    (None, Some(s)) => !s.hash.is_empty() && s.hash != "-",
                    // New here (first sync of this device): a unit is ours
                    // (ids never collide), but the group order is the
                    // account's — a joining device adopts it.
                    (Some(_), None) => env.k != "setting",
                    (None, None) => false,
                };
                if changed_here {
                    // Ours wins: keep the old hash so the push sends it (as v+1).
                    next.hash = st.as_ref().map(|s| s.hash.clone()).unwrap_or_default();
                } else if !unreadable.contains(&id) {
                    apply(pool, &env).await?;
                    applied.insert(id.clone());
                    next.hash = remote_hash;
                }
            }
            write_state(pool, &id, &next).await?;
            state.insert(id, next);
        }
        set_setting(pool, "sync_cursor", &cursor.to_string()).await?;
        if !page.get("more").and_then(Value::as_bool).unwrap_or(false) || items.is_empty() {
            break;
        }
    }

    // What we just wrote is what we now have: hash it as stored here.
    let (local, unreadable) = if applied.is_empty() { (local, unreadable) } else { read_local(pool, keys).await? };
    for id in &applied {
        if let (Some(l), Some(s)) = (local.get(id), state.get_mut(id)) {
            s.hash = l.hash.clone();
            write_state(pool, id, s).await?;
        }
    }
    if !applied.is_empty() {
        on_applied();
    }

    // 2. Push what changed here.
    let mut out: Vec<(String, State, Value)> = Vec::new();
    for (id, l) in &local {
        let s = state.get(id).cloned().unwrap_or_default();
        if s.hash == l.hash && !s.kind.is_empty() {
            continue;
        }
        let env = Envelope { k: l.kind.clone(), i: l.id.clone(), v: s.v + 1, d: false, r: l.row.clone() };
        let blob = seal(keys, id, &env)?;
        let next = State { kind: l.kind.clone(), unit: l.id.clone(), hash: l.hash.clone(), v: env.v, rev: s.rev };
        out.push((id.clone(), next, json!({ "id": id, "base_rev": s.rev, "blob": blob })));
    }
    for (id, s) in &state {
        if local.contains_key(id) || unreadable.contains(id) || s.hash.is_empty() || s.hash == "-" {
            continue;
        }
        let env = Envelope { k: s.kind.clone(), i: s.unit.clone(), v: s.v + 1, d: true, r: Map::new() };
        let blob = seal(keys, id, &env)?;
        let next = State { hash: "-".into(), v: env.v, ..s.clone() };
        out.push((id.clone(), next, json!({ "id": id, "base_rev": s.rev, "blob": blob })));
    }
    let pushed = out.len();
    for chunk in out.chunks(PUSH_BATCH) {
        let body = json!({ "items": chunk.iter().map(|(_, _, j)| j.clone()).collect::<Vec<_>>() });
        let res = call(cfg, keys, reqwest::Method::POST, "/v1/items", Some(&body)).await?;
        if res.status() == reqwest::StatusCode::CONFLICT {
            return Err(PassError::Conflict);
        }
        if !res.status().is_success() {
            return Err(PassError::Fail(fail(res).await));
        }
        let v: Value = res.json().await.map_err(|e| e.to_string())?;
        let revs: HashMap<String, i64> = v
            .get("items")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| Some((x.get("id")?.as_str()?.to_string(), x.get("rev")?.as_i64()?)))
                    .collect()
            })
            .unwrap_or_default();
        for (id, next, _) in chunk {
            let mut next = next.clone();
            next.rev = revs.get(id).copied().unwrap_or(next.rev);
            write_state(pool, id, &next).await?;
        }
    }
    Ok(applied.len() + pushed)
}

/// Runs a full sync (pull + push), retrying when another device raced us.
pub async fn sync_once(app: &AppHandle) -> Result<(), String> {
    let _guard = RUN.lock().await;
    let pool = sql(app).await.ok_or("database unavailable")?;
    let Some((cfg, keys)) = load_config(&pool).await else {
        let off = off_status(&pool).await;
        set_status(app, |s| *s = off);
        return Ok(());
    };
    set_status(app, |s| {
        s.enabled = true;
        s.url = cfg.url.clone();
        s.state = "syncing".into();
    });
    let mut result = Err("sync did not settle (too many concurrent changes) — will retry".to_string());
    for _ in 0..4 {
        match pass(&pool, &cfg, &keys, &|| {
            let _ = app.emit("sync://applied", ());
        })
        .await
        {
            Ok(_) => {
                result = Ok(());
                break;
            }
            Err(PassError::Conflict) => continue,
            Err(PassError::Fail(e)) => {
                result = Err(e);
                break;
            }
        }
    }
    if matches!(&result, Err(e) if e == REVOKED) {
        // The keys were reset on another device: this one is cut off and
        // removes the synced units it holds (they stay on the server).
        *CONFIRMED.lock().unwrap_or_else(|p| p.into_inner()) = None;
        UNLOCKED.store(false, std::sync::atomic::Ordering::Relaxed);
        // Close live sessions first (they log the server row), then wipe.
        for id in crate::ssh::connected_ids() {
            let _ = crate::ssh::disconnect(app, "user", &id).await;
        }
        wipe_local(&pool).await;
        let _ = app.emit("sync://applied", ());
        let off = off_status(&pool).await;
        set_status(app, |s| *s = off);
        return Err(off_notice());
    }
    let count = read_state(&pool).await.map(|m| m.values().filter(|s| s.hash != "-").count()).unwrap_or(0);
    match &result {
        Ok(()) => {
            let t = now();
            let _ = set_setting(&pool, "sync_last_ok", &t.to_string()).await;
            set_status(app, |s| {
                s.state = "idle".into();
                s.last_ok = t;
                s.error.clear();
                s.items = count;
            });
        }
        Err(e) => set_status(app, |s| {
            s.state = "error".into();
            s.error = e.clone();
            s.items = count;
        }),
    }
    result
}

/// Background loop: syncs shortly after a local change and every minute.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Wait for the frontend to open (and migrate) the database first.
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            let _ = sync_once(&app).await;
            tokio::select! {
                _ = notify().notified() => {
                    // Debounce: a burst of edits becomes one sync.
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                }
                _ = tokio::time::sleep(POLL) => {}
            }
        }
    });
}

fn off_notice() -> String {
    "Sync was turned off: the passphrase was reset on another device, so this device was signed out and its synced units were removed. They are safe on the server — join again with the new setup code.".into()
}

async fn off_status(pool: &sqlx::SqlitePool) -> Status {
    Status { state: "off".into(), notice: get_setting(pool, "sync_notice").await.unwrap_or_default(), ..Status::default() }
}

/// Removes every synced unit and the sync setup from this device.
async fn wipe_local(pool: &sqlx::SqlitePool) {
    for s in SPECS {
        let _ = sqlx::query(&format!("DELETE FROM {}", s.table)).execute(pool).await;
    }
    if let Some(mut v) = get_setting(pool, GROUPS_SETTING).await.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) {
        if let Some(m) = v.as_object_mut() {
            m.remove("order");
            let _ = set_setting(pool, GROUPS_SETTING, &v.to_string()).await;
        }
    }
    clear_local_state(pool).await;
    del_setting(pool, "sync_config").await;
    del_setting(pool, "sync_secret").await;
    let _ = set_setting(pool, "sync_notice", &off_notice()).await;
}

async fn clear_local_state(pool: &sqlx::SqlitePool) {
    let _ = sqlx::query("DELETE FROM sync_items").execute(pool).await;
    del_setting(pool, "sync_cursor").await;
    del_setting(pool, "sync_last_ok").await;
    *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

async fn store_config(pool: &sqlx::SqlitePool, cfg: &Config, secret: &[u8; 16], master: &[u8; 32]) -> Result<(), String> {
    clear_local_state(pool).await;
    del_setting(pool, "sync_notice").await;
    let sec = Secrets { secret_key: secret_to_text(secret), master: B64.encode(master) };
    set_setting(pool, "sync_secret", &vault::encrypt(&serde_json::to_string(&sec).map_err(|e| e.to_string())?)).await?;
    set_setting(pool, "sync_config", &serde_json::to_string(cfg).map_err(|e| e.to_string())?).await
}

async fn derive_blocking(passphrase: String, account: String, secret: [u8; 16]) -> Result<[u8; 32], String> {
    tokio::task::spawn_blocking(move || derive_master(&passphrase, &account, &secret))
        .await
        .map_err(|e| e.to_string())?
}

/* ---------- commands ---------- */

#[tauri::command]
pub async fn sync_status(app: AppHandle) -> Status {
    if let Some(mut s) = STATUS.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        s.locked = s.enabled && !open_now();
        return s;
    }
    let Some(pool) = sql(&app).await else { return Status { state: "off".into(), ..Status::default() } };
    match load_config(&pool).await {
        Some((cfg, _)) => Status {
            enabled: true,
            url: cfg.url,
            state: "idle".into(),
            last_ok: get_setting(&pool, "sync_last_ok").await.and_then(|v| v.parse().ok()).unwrap_or(0),
            locked: !open_now(),
            ..Status::default()
        },
        None => off_status(&pool).await,
    }
}

/// First device: creates the account on the server with an invite code.
#[tauri::command]
pub async fn sync_create(app: AppHandle, url: String, invite: String, passphrase: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Use a passphrase of at least {MIN_PASSPHRASE} characters."));
    }
    if invite.trim().is_empty() {
        return Err("Enter the invite code printed by `gravitation-sync invite` on the server.".into());
    }
    check_server(&url).await?;
    let pool = sql(&app).await.ok_or("database unavailable")?;
    let account = hex(&random::<16>());
    let secret = random::<16>();
    let master = derive_blocking(passphrase, account.clone(), secret).await?;
    let keys = keys_from(&master);
    let res = http()
        .post(format!("{url}/v1/register"))
        .json(&json!({ "invite": invite.trim(), "account": account, "public_key": B64.encode(keys.sign.verifying_key().to_bytes()) }))
        .send()
        .await
        .map_err(net)?;
    if !res.status().is_success() {
        return Err(fail(res).await);
    }
    let cfg = Config { url, account };
    store_config(&pool, &cfg, &secret, &master).await?;
    sync_once(&app).await
}

/// Another device: joins with the setup code + the passphrase.
#[tauri::command]
pub async fn sync_join(app: AppHandle, code: String, passphrase: String) -> Result<(), String> {
    let bad = || "This setup code is not valid — copy it again from a connected device.".to_string();
    let raw = code.trim().strip_prefix(CODE_PREFIX).ok_or_else(bad)?;
    let parsed: SetupCode = serde_json::from_slice(&B64URL.decode(raw).map_err(|_| bad())?).map_err(|_| bad())?;
    let secret = secret_from_text(&parsed.k).ok_or_else(bad)?;
    if parsed.a.len() != 32 || !parsed.a.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad());
    }
    let url = normalize_url(&parsed.u)?;
    check_server(&url).await?;
    let pool = sql(&app).await.ok_or("database unavailable")?;
    let master = derive_blocking(passphrase, parsed.a.clone(), secret).await?;
    let keys = keys_from(&master);
    let cfg = Config { url, account: parsed.a };
    // Proves passphrase + code before anything is stored.
    login(&cfg, &keys).await.map_err(|e| {
        if e == REVOKED {
            "This setup code is outdated — the passphrase was reset. Copy the new code from a connected device.".to_string()
        } else if e.contains("wrong passphrase") {
            "Wrong passphrase (or the account was deleted on the server).".to_string()
        } else {
            e
        }
    })?;
    let token = TOKEN.lock().unwrap_or_else(|p| p.into_inner()).clone();
    store_config(&pool, &cfg, &secret, &master).await?;
    *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = token;
    sync_once(&app).await
}

/// Re-encrypts everything under new keys and uploads it in one step; the
/// server retires the old key and ends every session. (Separate from the
/// command so the e2e test can drive it without an AppHandle.)
async fn reset_keys_inner(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    old: &Keys,
    new_secret: &[u8; 16],
    new_master: &[u8; 32],
) -> Result<(), String> {
    let new = keys_from(new_master);
    let (local, _) = read_local(pool, &new).await?;
    let mut items = Vec::with_capacity(local.len());
    for (id, l) in &local {
        let env = Envelope { k: l.kind.clone(), i: l.id.clone(), v: 1, d: false, r: l.row.clone() };
        items.push(json!({ "id": id, "blob": seal(&new, id, &env)? }));
    }
    let new_pk = new.sign.verifying_key().to_bytes();
    let (challenge, raw) = challenge(cfg).await?;
    let mut msg = ROTATE_CONTEXT.to_vec();
    msg.extend_from_slice(cfg.account.as_bytes());
    msg.push(0);
    msg.extend_from_slice(&raw);
    msg.extend_from_slice(&new_pk);
    let body = json!({
        "challenge": challenge,
        "signature": B64.encode(old.sign.sign(&msg).to_bytes()),
        "public_key": B64.encode(new_pk),
        "items": items,
    });
    let res = call(cfg, old, reqwest::Method::POST, "/v1/account/rotate", Some(&body)).await?;
    if !res.status().is_success() {
        return Err(fail(res).await);
    }
    store_config(pool, cfg, new_secret, new_master).await
}

/// Passphrase reset / "I lost a device": new passphrase and new secret key.
/// Everything stays on the server (re-encrypted) and on this device; every
/// other device is signed out and wipes its synced units when it next
/// connects. Returns the new setup code.
#[tauri::command]
pub async fn sync_reset_keys(app: AppHandle, current: String, passphrase: String) -> Result<String, String> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Use a passphrase of at least {MIN_PASSPHRASE} characters."));
    }
    // Pull first: units only the server has must be re-encrypted too.
    sync_once(&app).await.map_err(|e| format!("Sync first, then reset — it failed: {e}"))?;
    {
        let _guard = RUN.lock().await;
        let pool = sql(&app).await.ok_or("database unavailable")?;
        let cfg: Config = serde_json::from_str(&get_setting(&pool, "sync_config").await.ok_or("Sync is off.")?)
            .map_err(|e| e.to_string())?;
        let sec: Secrets = serde_json::from_str(
            &vault::try_decrypt(&get_setting(&pool, "sync_secret").await.ok_or("Sync is off.")?)
                .ok_or("Cannot unlock the sync secrets.")?,
        )
        .map_err(|e| e.to_string())?;
        let old_secret = secret_from_text(&sec.secret_key).ok_or("Stored secret key is damaged.")?;
        let old_master: [u8; 32] = B64
            .decode(&sec.master)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or("Stored master key is damaged.")?;
        // Whoever sits at an unlocked computer must not be able to lock you out.
        if derive_blocking(current, cfg.account.clone(), old_secret).await? != old_master {
            return Err("The current passphrase is wrong.".into());
        }
        let new_secret = random::<16>();
        let new_master = derive_blocking(passphrase, cfg.account.clone(), new_secret).await?;
        reset_keys_inner(&pool, &cfg, &keys_from(&old_master), &new_secret, &new_master).await?;
    }
    sync_once(&app).await?;
    sync_setup_code(app).await
}

/// Offline unlock: the passphrase proves the owner is here (a thief with
/// the laptop does not have it). Lasts until the app restarts.
#[tauri::command]
pub async fn sync_unlock(app: AppHandle, passphrase: String) -> Result<(), String> {
    let pool = sql(&app).await.ok_or("database unavailable")?;
    let cfg: Config = serde_json::from_str(&get_setting(&pool, "sync_config").await.ok_or("Sync is off.")?)
        .map_err(|e| e.to_string())?;
    let sec: Secrets = serde_json::from_str(
        &vault::try_decrypt(&get_setting(&pool, "sync_secret").await.ok_or("Sync is off.")?)
            .ok_or("Cannot unlock the sync secrets.")?,
    )
    .map_err(|e| e.to_string())?;
    let secret = secret_from_text(&sec.secret_key).ok_or("Stored secret key is damaged.")?;
    let master: [u8; 32] = B64.decode(&sec.master).ok().and_then(|b| b.try_into().ok()).ok_or("Stored master key is damaged.")?;
    if derive_blocking(passphrase, cfg.account, secret).await? != master {
        return Err("Wrong passphrase.".into());
    }
    UNLOCKED.store(true, std::sync::atomic::Ordering::Relaxed);
    set_status(&app, |_| {});
    Ok(())
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<(), String> {
    sync_once(&app).await
}

#[tauri::command]
pub fn sync_nudge() {
    nudge();
}

/// The setup code for adding another device (URL + account + secret key).
/// Together with the passphrase it opens everything — shown on request only.
#[tauri::command]
pub async fn sync_setup_code(app: AppHandle) -> Result<String, String> {
    ensure_access(&app).await?;
    let pool = sql(&app).await.ok_or("database unavailable")?;
    let cfg: Config = serde_json::from_str(&get_setting(&pool, "sync_config").await.ok_or("Sync is off.")?)
        .map_err(|e| e.to_string())?;
    let sec: Secrets = serde_json::from_str(
        &vault::try_decrypt(&get_setting(&pool, "sync_secret").await.ok_or("Sync is off.")?).ok_or("Cannot unlock the sync secrets.")?,
    )
    .map_err(|e| e.to_string())?;
    let code = SetupCode { u: cfg.url, a: cfg.account, k: sec.secret_key };
    Ok(format!("{CODE_PREFIX}{}", B64URL.encode(serde_json::to_vec(&code).map_err(|e| e.to_string())?)))
}

/// Turns sync off on this device. Local units stay. With `wipe_server`
/// the account and every item on the server are deleted too.
#[tauri::command]
pub async fn sync_disconnect(app: AppHandle, wipe_server: bool) -> Result<(), String> {
    // Otherwise turning sync off would be a way around the lock.
    ensure_access(&app).await?;
    let _guard = RUN.lock().await;
    let pool = sql(&app).await.ok_or("database unavailable")?;
    if let Some((cfg, keys)) = load_config(&pool).await {
        if wipe_server {
            let res = call(&cfg, &keys, reqwest::Method::DELETE, "/v1/account", None).await?;
            if !res.status().is_success() {
                return Err(fail(res).await);
            }
        } else if let Ok(res) = call(&cfg, &keys, reqwest::Method::POST, "/v1/auth/logout", None).await {
            let _ = res.status();
        }
    }
    clear_local_state(&pool).await;
    del_setting(&pool, "sync_config").await;
    del_setting(&pool, "sync_secret").await;
    set_status(&app, |s| *s = Status { state: "off".into(), ..Status::default() });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_key_text_round_trip() {
        let k = random::<16>();
        let t = secret_to_text(&k);
        assert_eq!(secret_from_text(&t), Some(k));
        assert_eq!(secret_from_text(&t.to_lowercase().replace('-', " ")), Some(k));
    }

    #[test]
    fn seal_open_and_tamper() {
        let keys = keys_from(&[7u8; 32]);
        let id = item_id(&keys, "server", "srv-1");
        let env = Envelope { k: "server".into(), i: "srv-1".into(), v: 3, d: false, r: Map::new() };
        let blob = seal(&keys, &id, &env).unwrap();
        assert_eq!(open(&keys, &id, &blob).map(|e| e.v), Some(3));
        // Same blob under another id: rejected (AAD), and with other keys too.
        let other = item_id(&keys, "server", "srv-2");
        assert!(open(&keys, &other, &blob).is_none());
        assert!(open(&keys_from(&[8u8; 32]), &id, &blob).is_none());
    }

    #[test]
    fn urls() {
        assert_eq!(normalize_url("sync.example.com/").unwrap(), "https://sync.example.com");
        assert!(normalize_url("http://sync.example.com").is_err());
        assert!(normalize_url("http://192.168.1.5:8443").is_ok());
        assert!(normalize_url("http://localhost:8443").is_ok());
        assert!(normalize_url("ftp://x").is_err());
    }
}

/// Devices against a running server (each test makes its own invite):
///   gravitation-sync --data <tmp> serve --listen 127.0.0.1:18443
///   GSYNC_URL=http://127.0.0.1:18443 GSYNC_BIN=<path to gravitation-sync> GSYNC_DATA=<tmp> \
///     cargo test --lib sync::e2e::<name> -- --ignored --exact
/// One test per server start: together they exceed the auth rate limit.
#[cfg(test)]
mod e2e {
    use super::*;

    async fn device() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for m in crate::db::migrations() {
            sqlx::raw_sql(m.sql).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn count(pool: &sqlx::SqlitePool, q: &str) -> i64 {
        sqlx::query_scalar(q).fetch_one(pool).await.unwrap()
    }

    /// One-time invite from the server's own CLI.
    fn invite() -> String {
        let out = std::process::Command::new(std::env::var("GSYNC_BIN").expect("GSYNC_BIN"))
            .args(["--data", &std::env::var("GSYNC_DATA").expect("GSYNC_DATA"), "invite"])
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// A fresh account: (config, master, secret key).
    async fn account(passphrase: &str) -> (Config, [u8; 32], [u8; 16]) {
        let url = std::env::var("GSYNC_URL").expect("GSYNC_URL");
        let account = hex(&random::<16>());
        let secret = random::<16>();
        let master = derive_master(passphrase, &account, &secret).unwrap();
        let keys = keys_from(&master);
        let res = http()
            .post(format!("{url}/v1/register"))
            .json(&json!({ "invite": invite(), "account": account, "public_key": B64.encode(keys.sign.verifying_key().to_bytes()) }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "register: {}", fail(res).await);
        (Config { url, account }, master, secret)
    }

    /// Each device has its own session (the token cache is per process).
    fn switch_device() {
        *TOKEN.lock().unwrap() = None;
    }

    async fn run(pool: &sqlx::SqlitePool, cfg: &Config, keys: &Keys) {
        switch_device();
        for _ in 0..4 {
            match pass(pool, cfg, keys, &|| {}).await {
                Ok(_) => return,
                Err(PassError::Conflict) => continue,
                Err(PassError::Fail(e)) => panic!("sync failed: {e}"),
            }
        }
        panic!("did not settle");
    }

    #[tokio::test]
    #[ignore]
    async fn two_devices() {
        let url = std::env::var("GSYNC_URL").expect("GSYNC_URL");
        let invite = invite();
        check_server(&url).await.unwrap();
        let account = hex(&random::<16>());
        let secret = random::<16>();
        let master = derive_master("correct horse battery", &account, &secret).unwrap();
        let keys = keys_from(&master);
        let res = http()
            .post(format!("{url}/v1/register"))
            .json(&json!({ "invite": invite, "account": account, "public_key": B64.encode(keys.sign.verifying_key().to_bytes()) }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "register: {}", fail(res).await);
        let cfg = Config { url: url.clone(), account: account.clone() };

        // Wrong passphrase cannot log in.
        let bad = keys_from(&derive_master("wrong passphrase!", &account, &secret).unwrap());
        assert!(login(&cfg, &bad).await.is_err());

        let a = device().await;
        let b = device().await;
        sqlx::query("INSERT INTO ssh_servers (id, name, host, password) VALUES ('srv-1', 'web', '10.0.0.1', $1)")
            .bind(vault::encrypt("hunter2"))
            .execute(&a)
            .await
            .unwrap();
        sqlx::query("INSERT INTO ssh_scripts (id, name, content) VALUES ('scr-1', 'uptime', 'uptime')").execute(&b).await.unwrap();

        run(&a, &cfg, &keys).await;
        run(&b, &cfg, &keys).await;
        run(&a, &cfg, &keys).await;
        assert_eq!(count(&b, "SELECT COUNT(*) FROM ssh_servers").await, 1);
        assert_eq!(count(&a, "SELECT COUNT(*) FROM ssh_scripts").await, 1);
        let pw: String = sqlx::query_scalar("SELECT password FROM ssh_servers").fetch_one(&b).await.unwrap();
        assert_eq!(vault::try_decrypt(&pw).as_deref(), Some("hunter2"));

        // Edit on B, delete on A.
        sqlx::query("UPDATE ssh_servers SET name = 'web-prod'").execute(&b).await.unwrap();
        sqlx::query("DELETE FROM ssh_scripts").execute(&a).await.unwrap();
        run(&b, &cfg, &keys).await;
        run(&a, &cfg, &keys).await;
        run(&b, &cfg, &keys).await;
        let name: String = sqlx::query_scalar("SELECT name FROM ssh_servers").fetch_one(&a).await.unwrap();
        assert_eq!(name, "web-prod");
        assert_eq!(count(&b, "SELECT COUNT(*) FROM ssh_scripts").await, 0);

        // Idempotent: nothing left to push.
        assert_eq!(pass(&a, &cfg, &keys, &|| {}).await.ok(), Some(0));
        assert_eq!(pass(&b, &cfg, &keys, &|| {}).await.ok(), Some(0));

        // The server holds only ciphertext.
        let t = token(&cfg, &keys).await.unwrap();
        let page: Value = http().get(format!("{url}/v1/items?since=0")).bearer_auth(t).send().await.unwrap().json().await.unwrap();
        let dump = page.to_string();
        assert!(!dump.contains("hunter2") && !dump.contains("web-prod") && !dump.contains("10.0.0.1"));

        let res = call(&cfg, &keys, reqwest::Method::DELETE, "/v1/account", None).await.unwrap();
        assert!(res.status().is_success());
    }

    /// Units saved BEFORE sync was set up: on the first device they are
    /// uploaded, a joining device keeps its own and gets the others, and the
    /// joining device adopts the account's group order.
    #[tokio::test]
    #[ignore]
    async fn existing_units_are_merged() {
        let (cfg, master, _) = account("correct horse battery").await;
        let keys = keys_from(&master);
        let a = device().await;
        let b = device().await;

        // A: a server, a key, a script, a proxy, a legacy server with an
        // inline key, and a group order.
        sqlx::query("INSERT INTO ssh_servers (id, name, host, password, group_name) VALUES ('srv-a', 'web', '10.0.0.1', $1, 'Prod')")
            .bind(vault::encrypt("pw-a"))
            .execute(&a).await.unwrap();
        sqlx::query("INSERT INTO ssh_servers (id, name, host, private_key) VALUES ('srv-old', 'legacy', '10.0.0.9', $1)")
            .bind(vault::encrypt("-----BEGIN OPENSSH PRIVATE KEY-----\nlegacy\n-----END OPENSSH PRIVATE KEY-----"))
            .execute(&a).await.unwrap();
        sqlx::query("INSERT INTO ssh_keys (id, name, private_key, passphrase) VALUES ('key-a', 'deploy', $1, $2)")
            .bind(vault::encrypt("KEYBODY"))
            .bind(vault::encrypt("kp"))
            .execute(&a).await.unwrap();
        sqlx::query("INSERT INTO ssh_scripts (id, name, content) VALUES ('scr-a', 'uptime', 'uptime')").execute(&a).await.unwrap();
        sqlx::query("INSERT INTO ssh_proxies (id, name, host, port, password) VALUES ('prx-a', 'socks', '1.2.3.4', 1080, $1)")
            .bind(vault::encrypt("pp"))
            .execute(&a).await.unwrap();
        set_setting(&a, GROUPS_SETTING, r#"{"collapsed":["page:server:Prod"],"order":{"server":["g:Prod","u:srv-old"]}}"#).await.unwrap();

        // B: its own server and its own order, also from before sync.
        sqlx::query("INSERT INTO ssh_servers (id, name, host) VALUES ('srv-b', 'db', '10.0.0.2')").execute(&b).await.unwrap();
        set_setting(&b, GROUPS_SETTING, r#"{"collapsed":["sidebar:server:X"],"order":{"server":["u:srv-b"]}}"#).await.unwrap();

        run(&a, &cfg, &keys).await; // create account
        run(&b, &cfg, &keys).await; // join
        run(&a, &cfg, &keys).await;

        for (dev, name) in [(&a, "A"), (&b, "B")] {
            assert_eq!(count(dev, "SELECT COUNT(*) FROM ssh_servers").await, 3, "servers on {name}");
            assert_eq!(count(dev, "SELECT COUNT(*) FROM ssh_keys").await, 2, "keys on {name} (incl. migrated legacy)");
            assert_eq!(count(dev, "SELECT COUNT(*) FROM ssh_scripts").await, 1, "scripts on {name}");
            assert_eq!(count(dev, "SELECT COUNT(*) FROM ssh_proxies").await, 1, "proxies on {name}");
            // The legacy server points at its migrated credential everywhere.
            let kid: String = sqlx::query_scalar("SELECT key_id FROM ssh_servers WHERE id = 'srv-old'").fetch_one(dev).await.unwrap();
            let body: String = sqlx::query_scalar("SELECT private_key FROM ssh_keys WHERE id = $1").bind(&kid).fetch_one(dev).await.unwrap();
            assert!(vault::try_decrypt(&body).unwrap().contains("legacy"), "legacy key on {name}");
            let pw: String = sqlx::query_scalar("SELECT password FROM ssh_servers WHERE id = 'srv-a'").fetch_one(dev).await.unwrap();
            assert_eq!(vault::try_decrypt(&pw).as_deref(), Some("pw-a"));
            let g: String = sqlx::query_scalar("SELECT group_name FROM ssh_servers WHERE id = 'srv-a'").fetch_one(dev).await.unwrap();
            assert_eq!(g, "Prod");
        }
        // B took the account's order but kept its own collapsed groups.
        let gb: Value = serde_json::from_str(&get_setting(&b, GROUPS_SETTING).await.unwrap()).unwrap();
        assert_eq!(gb["order"]["server"], json!(["g:Prod", "u:srv-old"]));
        assert_eq!(gb["collapsed"], json!(["sidebar:server:X"]));
        let ga: Value = serde_json::from_str(&get_setting(&a, GROUPS_SETTING).await.unwrap()).unwrap();
        assert_eq!(ga["collapsed"], json!(["page:server:Prod"]));

        switch_device();
        let res = call(&cfg, &keys, reqwest::Method::DELETE, "/v1/account", None).await.unwrap();
        assert!(res.status().is_success());
    }

    /// Passphrase reset: everything stays on the server and on the resetting
    /// device; the other device is cut off and wipes its synced units; a new
    /// device joins with the new keys and gets everything.
    #[tokio::test]
    #[ignore]
    async fn reset_keys_cuts_off_other_devices() {
        let (cfg, master, _) = account("old passphrase 1").await;
        let old = keys_from(&master);
        let a = device().await;
        let b = device().await;
        sqlx::query("INSERT INTO ssh_servers (id, name, host, password) VALUES ('srv-1', 'web', '10.0.0.1', $1)")
            .bind(vault::encrypt("hunter2"))
            .execute(&a).await.unwrap();
        sqlx::query("INSERT INTO ssh_scripts (id, name, content) VALUES ('scr-1', 'uptime', 'uptime')").execute(&b).await.unwrap();
        run(&a, &cfg, &old).await;
        run(&b, &cfg, &old).await;
        run(&a, &cfg, &old).await;
        assert_eq!(count(&b, "SELECT COUNT(*) FROM ssh_servers").await, 1);

        // A resets.
        switch_device();
        let new_secret = random::<16>();
        let new_master = derive_master("new passphrase 2", &cfg.account, &new_secret).unwrap();
        let new = keys_from(&new_master);
        reset_keys_inner(&a, &cfg, &old, &new_secret, &new_master).await.unwrap();
        run(&a, &cfg, &new).await;
        assert_eq!(pass(&a, &cfg, &new, &|| {}).await.ok(), Some(0), "nothing left to push after reset");
        assert_eq!(count(&a, "SELECT COUNT(*) FROM ssh_servers").await, 1);
        assert_eq!(count(&a, "SELECT COUNT(*) FROM ssh_scripts").await, 1);

        // B (old keys) is refused as revoked — not as "wrong passphrase".
        switch_device();
        match pass(&b, &cfg, &old, &|| {}).await {
            Err(PassError::Fail(e)) => assert_eq!(e, REVOKED),
            _ => panic!("old device must be revoked"),
        }
        wipe_local(&b).await;
        assert_eq!(count(&b, "SELECT COUNT(*) FROM ssh_servers").await, 0);
        assert_eq!(count(&b, "SELECT COUNT(*) FROM ssh_scripts").await, 0);
        assert!(get_setting(&b, "sync_config").await.is_none());
        assert!(get_setting(&b, "sync_notice").await.is_some());

        // A random outsider signature does not get "revoked".
        switch_device();
        let stranger = keys_from(&[9u8; 32]);
        assert_ne!(login(&cfg, &stranger).await.err().as_deref(), Some(REVOKED));

        // A new device with the new keys gets everything back.
        let c = device().await;
        run(&c, &cfg, &new).await;
        assert_eq!(count(&c, "SELECT COUNT(*) FROM ssh_servers").await, 1);
        assert_eq!(count(&c, "SELECT COUNT(*) FROM ssh_scripts").await, 1);
        let pw: String = sqlx::query_scalar("SELECT password FROM ssh_servers").fetch_one(&c).await.unwrap();
        assert_eq!(vault::try_decrypt(&pw).as_deref(), Some("hunter2"));

        // A stolen session token alone cannot reset keys (needs a signature).
        switch_device();
        let t = token(&cfg, &new).await.unwrap();
        let res = http()
            .post(format!("{}/v1/account/rotate", cfg.url))
            .bearer_auth(&t)
            .json(&json!({ "challenge": B64.encode([0u8; 32]), "signature": B64.encode([0u8; 64]), "public_key": B64.encode(keys_from(&[5u8; 32]).sign.verifying_key().to_bytes()), "items": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::UNAUTHORIZED);

        let res = call(&cfg, &new, reqwest::Method::DELETE, "/v1/account", None).await.unwrap();
        assert!(res.status().is_success());
    }
}
