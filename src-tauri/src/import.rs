//! One-time import of the SSH units saved in Singularity.
//!
//! Gravitation used to be Singularity's "SSH Client" mode: servers, keys,
//! scripts, proxies and the audit log live in Singularity's database, their
//! secrets encrypted with Singularity's vault key. On first launch they are
//! copied here — the secrets decrypted with that key and sealed again with
//! Gravitation's own — so the split loses nothing. Singularity's database is
//! only read.

use sqlx::Connection;
use tauri::AppHandle;

use crate::{db, vault};

/// Settings row that marks the import as done (it never runs twice).
const DONE_KEY: &str = "imported_from_singularity";

/// Tables copied as-is, with the columns they hold secrets in.
const TABLES: &[(&str, &str, &[&str])] = &[
    (
        "ssh_servers",
        "id, name, host, port, username, auth, password, private_key, key_id, host_key, os, proxy_id, sort_order, created_at",
        &["password", "private_key"],
    ),
    (
        "ssh_keys",
        "id, name, private_key, passphrase, comment, public_key, fingerprint, sort_order, created_at",
        &["private_key", "passphrase"],
    ),
    ("ssh_scripts", "id, name, description, content, sort_order, created_at", &[]),
    ("ssh_proxies", "id, name, kind, host, port, username, password, sort_order, created_at", &["password"]),
    ("ssh_logs", "id, actor, server_id, server_name, host, action, ok, detail, created_at", &[]),
];

/// Imports once; returns how many servers came over (0 = nothing to do).
#[tauri::command]
pub async fn ssh_import_singularity(app: AppHandle) -> Result<usize, String> {
    let Some(old) = vault::app_data_dir("com.singularity.app").map(|d| d.join("singularity.db")) else {
        return Ok(0);
    };
    let path = db::db_path(&app)?;
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(false);
    let mut conn = sqlx::SqliteConnection::connect_with(&opts)
        .await
        .map_err(|e| format!("cannot open the database: {e}"))?;

    let done: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(DONE_KEY)
        .fetch_optional(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let have: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ssh_servers")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    // Already imported, units added by hand, or no Singularity install.
    if done.is_some() || have > 0 || !old.exists() {
        mark_done(&mut conn).await;
        return Ok(0);
    }

    sqlx::query("ATTACH DATABASE $1 AS old")
        .bind(old.to_string_lossy().to_string())
        .execute(&mut conn)
        .await
        .map_err(|e| format!("cannot read Singularity's database: {e}"))?;
    let copied = copy_tables(&mut conn).await;
    let _ = sqlx::query("DETACH DATABASE old").execute(&mut conn).await;
    let servers = copied?;
    mark_done(&mut conn).await;
    Ok(servers)
}

/// Copies every table, then re-seals the secrets. Returns the server count.
async fn copy_tables(conn: &mut sqlx::SqliteConnection) -> Result<usize, String> {
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    for (table, cols, _) in TABLES {
        // A Singularity version without one of the tables: skip it.
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM old.sqlite_master WHERE type = 'table' AND name = $1")
            .bind(*table)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if exists == 0 {
            continue;
        }
        sqlx::query(&format!("INSERT OR IGNORE INTO main.{table} ({cols}) SELECT {cols} FROM old.{table}"))
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("cannot copy {table}: {e}"))?;
    }

    // Secrets were sealed with Singularity's key: open them with it and seal
    // them again with ours. A value that does not open is dropped — the unit
    // stays, the user enters that password again.
    let key = vault::singularity_key();
    for (table, _, secrets) in TABLES {
        for col in *secrets {
            let rows: Vec<(String, String)> =
                sqlx::query_as(&format!("SELECT id, {col} FROM main.{table} WHERE {col} <> ''"))
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            for (id, stored) in rows {
                let plain = key.as_ref().and_then(|k| vault::decrypt_with(k, &stored)).unwrap_or_default();
                sqlx::query(&format!("UPDATE main.{table} SET {col} = $1 WHERE id = $2"))
                    .bind(vault::encrypt(&plain))
                    .bind(&id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    // The app theme and the terminal settings come along too.
    sqlx::query("INSERT OR IGNORE INTO main.settings (key, value) SELECT key, value FROM old.settings WHERE key = 'theme' OR key LIKE 'ssh\\_%' ESCAPE '\\'")
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("cannot copy settings: {e}"))?;

    let servers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM main.ssh_servers")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(servers as usize)
}

async fn mark_done(conn: &mut sqlx::SqliteConnection) {
    let _ = sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ($1, '1')")
        .bind(DONE_KEY)
        .execute(conn)
        .await;
}
