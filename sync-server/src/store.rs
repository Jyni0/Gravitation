//! SQLite storage. Everything here is either public (account public keys),
//! a hash (session tokens, invite codes) or ciphertext the server cannot
//! open (item blobs).

use std::path::Path;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::{now, random};

/// A session lives this long without use; every request extends it.
pub const SESSION_TTL: i64 = 30 * 24 * 3600;
/// Upper bound of items per account (units + tombstones).
pub const MAX_ITEMS: i64 = 100_000;

pub struct Store {
    db: Mutex<Connection>,
}

pub struct AccountRow {
    pub id: String,
    pub items: i64,
    pub sessions: i64,
    pub created_at: i64,
    pub last_seen: Option<i64>,
}

pub struct Item {
    pub id: String,
    pub rev: i64,
    pub blob: Vec<u8>,
}

/// Outcome of a push: new revisions, or the ids whose base revision is stale.
pub enum PushResult {
    Ok(Vec<(String, i64)>),
    Conflict(Vec<String>),
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

pub fn fmt_time(t: i64) -> String {
    // UTC "YYYY-MM-DD HH:MM" without a date crate (civil-from-days).
    let days = t.div_euclid(86400);
    let secs = t.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", secs / 3600, (secs % 3600) / 60)
}

impl Store {
    pub fn open(dir: &Path) -> Result<Store, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let path = dir.join("sync.db");
        let db = Connection::open(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        db.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS accounts (
              id          TEXT PRIMARY KEY,
              public_key  BLOB NOT NULL,
              rev         INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL,
              last_seen   INTEGER
            );
            CREATE TABLE IF NOT EXISTS items (
              account     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
              id          TEXT NOT NULL,
              rev         INTEGER NOT NULL,
              blob        BLOB NOT NULL,
              updated_at  INTEGER NOT NULL,
              PRIMARY KEY (account, id)
            );
            CREATE INDEX IF NOT EXISTS items_by_rev ON items(account, rev);
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash  BLOB PRIMARY KEY,
              account     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
              device      TEXT NOT NULL DEFAULT '',
              created_at  INTEGER NOT NULL,
              expires_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS retired_keys (
              account     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
              public_key  BLOB NOT NULL,
              retired_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS retired_by_account ON retired_keys(account);
            CREATE TABLE IF NOT EXISTS invites (
              code_hash   BLOB PRIMARY KEY,
              created_at  INTEGER NOT NULL,
              expires_at  INTEGER NOT NULL,
              used_at     INTEGER
            );
            ",
        )
        .map_err(|e| format!("cannot init database: {e}"))?;
        Ok(Store { db: Mutex::new(db) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    /* ---------- invites ---------- */

    pub fn create_invite(&self, hours: u64) -> Result<String, String> {
        // 120 bits, grouped for reading aloud / typing.
        let raw = crockford(&random::<15>());
        let code = format!("INV-{}-{}-{}-{}", &raw[0..6], &raw[6..12], &raw[12..18], &raw[18..24]);
        let t = now();
        self.conn()
            .execute(
                "INSERT INTO invites (code_hash, created_at, expires_at) VALUES (?1, ?2, ?3)",
                params![sha256(normalize_invite(&code).as_bytes()), t, t + hours as i64 * 3600],
            )
            .map_err(|e| e.to_string())?;
        Ok(code)
    }

    /// Creates an account if the invite is valid and unused (both in one
    /// transaction, so one code makes exactly one account).
    pub fn register(&self, invite: &str, account: &str, public_key: &[u8; 32]) -> Result<(), &'static str> {
        let mut db = self.conn();
        let tx = db.transaction().map_err(|_| "database error")?;
        let hash = sha256(normalize_invite(invite).as_bytes());
        let t = now();
        let ok = tx
            .execute(
                "UPDATE invites SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2",
                params![hash, t],
            )
            .map_err(|_| "database error")?;
        if ok != 1 {
            return Err("invalid or expired invite");
        }
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO accounts (id, public_key, created_at) VALUES (?1, ?2, ?3)",
                params![account, &public_key[..], t],
            )
            .map_err(|_| "database error")?;
        if inserted != 1 {
            return Err("account already exists");
        }
        tx.commit().map_err(|_| "database error")
    }

    /* ---------- accounts ---------- */

    pub fn public_key(&self, account: &str) -> Option<[u8; 32]> {
        let v: Option<Vec<u8>> = self
            .conn()
            .query_row("SELECT public_key FROM accounts WHERE id = ?1", [account], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        v.and_then(|b| b.try_into().ok())
    }

    /// Public keys this account used before a key reset (newest first).
    pub fn retired_keys(&self, account: &str) -> Vec<[u8; 32]> {
        let db = self.conn();
        let Ok(mut st) = db.prepare("SELECT public_key FROM retired_keys WHERE account = ?1 ORDER BY retired_at DESC LIMIT 50") else {
            return Vec::new();
        };
        st.query_map([account], |r| r.get::<_, Vec<u8>>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).filter_map(|b| b.try_into().ok()).collect())
            .unwrap_or_default()
    }

    /// Key reset: the old public key is retired, every item is replaced by
    /// the set re-encrypted under the new keys, and every session ends.
    /// All or nothing.
    pub fn rotate(&self, account: &str, new_key: &[u8; 32], items: &[(String, Vec<u8>)]) -> Result<Vec<(String, i64)>, String> {
        if items.len() as i64 > MAX_ITEMS {
            return Err("item limit reached".into());
        }
        let mut db = self.conn();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let t = now();
        tx.execute(
            "INSERT INTO retired_keys (account, public_key, retired_at) SELECT id, public_key, ?2 FROM accounts WHERE id = ?1",
            params![account, t],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM items WHERE account = ?1", [account]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM sessions WHERE account = ?1", [account]).map_err(|e| e.to_string())?;
        let mut rev: i64 = tx
            .query_row("SELECT rev FROM accounts WHERE id = ?1", [account], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(items.len());
        for (id, blob) in items {
            rev += 1;
            tx.execute(
                "INSERT INTO items (account, id, rev, blob, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![account, id, rev, blob, t],
            )
            .map_err(|e| e.to_string())?;
            out.push((id.clone(), rev));
        }
        tx.execute("UPDATE accounts SET public_key = ?2, rev = ?3 WHERE id = ?1", params![account, &new_key[..], rev])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn accounts(&self) -> Result<Vec<AccountRow>, String> {
        let db = self.conn();
        let mut st = db
            .prepare(
                "SELECT a.id, a.created_at, a.last_seen,
                        (SELECT COUNT(*) FROM items i WHERE i.account = a.id),
                        (SELECT COUNT(*) FROM sessions s WHERE s.account = a.id AND s.expires_at > ?1)
                 FROM accounts a ORDER BY a.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([now()], |r| {
                Ok(AccountRow {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    last_seen: r.get(2)?,
                    items: r.get(3)?,
                    sessions: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Full account id from an id or a unique prefix (admin convenience).
    pub fn resolve_account(&self, prefix: &str) -> Result<String, String> {
        let ids: Vec<String> = self.accounts()?.into_iter().map(|a| a.id).filter(|id| id.starts_with(prefix)).collect();
        match ids.len() {
            1 => Ok(ids.into_iter().next().unwrap_or_default()),
            0 => Err(format!("no account matches {prefix}")),
            n => Err(format!("{n} accounts match {prefix} — give more characters")),
        }
    }

    pub fn delete_account(&self, account: &str) -> Result<(), String> {
        let mut db = self.conn();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM items WHERE account = ?1", [account]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM sessions WHERE account = ?1", [account]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM retired_keys WHERE account = ?1", [account]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM accounts WHERE id = ?1", [account]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// (item count, highest revision, created_at)
    pub fn account_info(&self, account: &str) -> Result<(i64, i64, i64), String> {
        self.conn()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM items WHERE account = ?1), rev, created_at FROM accounts WHERE id = ?1",
                [account],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())
    }

    /* ---------- sessions ---------- */

    pub fn create_session(&self, account: &str, device: &str) -> Result<String, String> {
        let token = B64URL.encode(random::<32>());
        let t = now();
        let db = self.conn();
        // Housekeeping: expired sessions and invites go on every login.
        let _ = db.execute("DELETE FROM sessions WHERE expires_at <= ?1", [t]);
        let _ = db.execute("DELETE FROM invites WHERE expires_at <= ?1", [t - 30 * 24 * 3600]);
        db.execute(
            "INSERT INTO sessions (token_hash, account, device, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![sha256(token.as_bytes()), account, device, t, t + SESSION_TTL],
        )
        .map_err(|e| e.to_string())?;
        db.execute("UPDATE accounts SET last_seen = ?2 WHERE id = ?1", params![account, t])
            .map_err(|e| e.to_string())?;
        Ok(token)
    }

    /// Account of a live session token (and slides its expiry forward).
    pub fn session(&self, token: &str) -> Option<String> {
        let t = now();
        let hash = sha256(token.as_bytes());
        let db = self.conn();
        let account: Option<String> = db
            .query_row(
                "SELECT account FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
                params![hash, t],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(a) = &account {
            let _ = db.execute("UPDATE sessions SET expires_at = ?2 WHERE token_hash = ?1", params![hash, t + SESSION_TTL]);
            let _ = db.execute("UPDATE accounts SET last_seen = ?2 WHERE id = ?1", params![a, t]);
        }
        account
    }

    pub fn end_session(&self, token: &str) {
        let _ = self.conn().execute("DELETE FROM sessions WHERE token_hash = ?1", [sha256(token.as_bytes())]);
    }

    pub fn revoke_sessions(&self, account: &str) -> Result<usize, String> {
        self.conn().execute("DELETE FROM sessions WHERE account = ?1", [account]).map_err(|e| e.to_string())
    }

    /* ---------- items ---------- */

    /// Items changed after `since`, oldest first; the flag says more remain.
    pub fn pull(&self, account: &str, since: i64, limit: i64) -> Result<(Vec<Item>, bool), String> {
        let db = self.conn();
        let mut st = db
            .prepare("SELECT id, rev, blob FROM items WHERE account = ?1 AND rev > ?2 ORDER BY rev LIMIT ?3")
            .map_err(|e| e.to_string())?;
        let mut items: Vec<Item> = st
            .query_map(params![account, since, limit + 1], |r| Ok(Item { id: r.get(0)?, rev: r.get(1)?, blob: r.get(2)? }))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let more = items.len() as i64 > limit;
        items.truncate(limit as usize);
        Ok((items, more))
    }

    /// Writes items atomically. Each one names the revision it was based on
    /// (0 = new); if any is stale nothing is written and the client pulls
    /// first. Every written item gets the next account revision.
    pub fn push(&self, account: &str, items: &[(String, i64, Vec<u8>)]) -> Result<PushResult, String> {
        let mut db = self.conn();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let mut conflicts = Vec::new();
        let mut new_items = 0i64;
        for (id, base, _) in items {
            let cur: Option<i64> = tx
                .query_row("SELECT rev FROM items WHERE account = ?1 AND id = ?2", params![account, id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if cur.unwrap_or(0) != *base {
                conflicts.push(id.clone());
            }
            if cur.is_none() {
                new_items += 1;
            }
        }
        if !conflicts.is_empty() {
            return Ok(PushResult::Conflict(conflicts));
        }
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM items WHERE account = ?1", [account], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count + new_items > MAX_ITEMS {
            return Err("item limit reached".into());
        }
        let mut rev: i64 = tx
            .query_row("SELECT rev FROM accounts WHERE id = ?1", [account], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let t = now();
        let mut out = Vec::with_capacity(items.len());
        for (id, _, blob) in items {
            rev += 1;
            tx.execute(
                "INSERT INTO items (account, id, rev, blob, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(account, id) DO UPDATE SET rev = ?3, blob = ?4, updated_at = ?5",
                params![account, id, rev, blob, t],
            )
            .map_err(|e| e.to_string())?;
            out.push((id.clone(), rev));
        }
        tx.execute("UPDATE accounts SET rev = ?2 WHERE id = ?1", params![account, rev]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(PushResult::Ok(out))
    }
}

/// Invite codes compare case-insensitively, without dashes or spaces.
fn normalize_invite(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_uppercase()
}

/// Crockford base32 (no I, L, O, U — unambiguous to read and type).
fn crockford(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}
