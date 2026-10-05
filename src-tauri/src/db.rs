/// Gravitation — persistence layer.
///
/// The units live in a SQLite database (`sqlite:gravitation.db`) managed by
/// `tauri-plugin-sql`; Rust reads and writes the same file through sqlx
/// (ssh.rs). Migrations run when the frontend opens the database.
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Path of the app database, relative to the app data directory.
pub const DB_URL: &str = "sqlite:gravitation.db";
/// File name of that database.
const DB_FILE: &str = "gravitation.db";

/// Builds the migration list handed to the SQL plugin.
///
/// IMPORTANT: never edit an already-applied migration. sqlx records a
/// checksum per version in `_sqlx_migrations` and refuses to run ANY
/// migration when one of them no longer matches. Schema changes always go in
/// a new version at the end.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
        version: 1,
        description: "ssh client schema",
        // Secret columns (password, private_key, passphrase) hold AES-256-GCM
        // ciphertext written by vault.rs — the master key lives in the OS
        // credential store, never in the database.
        sql: "
            CREATE TABLE IF NOT EXISTS settings (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ssh_servers (
              id           TEXT PRIMARY KEY,
              name         TEXT NOT NULL,
              host         TEXT NOT NULL,
              port         INTEGER NOT NULL DEFAULT 22,
              username     TEXT NOT NULL DEFAULT 'root',
              auth         TEXT NOT NULL DEFAULT 'password',
              password     TEXT NOT NULL DEFAULT '',
              private_key  TEXT NOT NULL DEFAULT '',
              key_id       TEXT NOT NULL DEFAULT '',
              host_key     TEXT NOT NULL DEFAULT '',
              os           TEXT NOT NULL DEFAULT '',
              proxy_id     TEXT NOT NULL DEFAULT '',
              sort_order   INTEGER NOT NULL DEFAULT 0,
              created_at   INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS ssh_keys (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              private_key TEXT NOT NULL DEFAULT '',
              passphrase  TEXT NOT NULL DEFAULT '',
              comment     TEXT NOT NULL DEFAULT '',
              public_key  TEXT NOT NULL DEFAULT '',
              fingerprint TEXT NOT NULL DEFAULT '',
              sort_order  INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS ssh_scripts (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              content     TEXT NOT NULL DEFAULT '',
              sort_order  INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS ssh_proxies (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              kind        TEXT NOT NULL DEFAULT 'http',
              host        TEXT NOT NULL,
              port        INTEGER NOT NULL,
              username    TEXT NOT NULL DEFAULT '',
              password    TEXT NOT NULL DEFAULT '',
              sort_order  INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS ssh_logs (
              id          TEXT PRIMARY KEY,
              actor       TEXT NOT NULL,
              server_id   TEXT NOT NULL,
              server_name TEXT NOT NULL,
              host        TEXT NOT NULL DEFAULT '',
              action      TEXT NOT NULL,
              ok          INTEGER NOT NULL DEFAULT 1,
              detail      TEXT NOT NULL DEFAULT '',
              created_at  INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE INDEX IF NOT EXISTS idx_ssh_logs_time ON ssh_logs(created_at);
        ",
        kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "unit groups",
            // A unit's group ("" = none) — the sidebar and the Units page
            // gather units of one group under a collapsible header.
            sql: "
                ALTER TABLE ssh_servers ADD COLUMN group_name TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_keys    ADD COLUMN group_name TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_scripts ADD COLUMN group_name TEXT NOT NULL DEFAULT '';
                ALTER TABLE ssh_proxies ADD COLUMN group_name TEXT NOT NULL DEFAULT '';
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "sync state",
            // What was last synced per item (see sync.rs): content hash,
            // item version and server revision. Empty while sync is off.
            sql: "
                CREATE TABLE IF NOT EXISTS sync_items (
                  item     TEXT PRIMARY KEY,
                  kind     TEXT NOT NULL DEFAULT '',
                  unit_id  TEXT NOT NULL DEFAULT '',
                  hash     TEXT NOT NULL DEFAULT '',
                  v        INTEGER NOT NULL DEFAULT 0,
                  rev      INTEGER NOT NULL DEFAULT 0
                );
            ",
            kind: MigrationKind::Up,
        },
    ]
}

/// Absolute path of the database file, resolved from the app data directory.
pub fn db_path(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {dir:?}: {e}"))?;
    Ok(dir.join(DB_FILE).to_string_lossy().to_string())
}
