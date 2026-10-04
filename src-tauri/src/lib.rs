/// Gravitation — SSH client: terminals, SFTP, keys, scripts and proxies.
mod db;
mod import;
mod proxy;
mod safety;
mod ssh;
mod vault;

use tauri::Manager;

/// True while a terminal has keyboard focus — only then does Ctrl+Shift+C
/// belong to the page (terminal copy) instead of the browser.
static TERMINAL_FOCUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The frontend reports terminal focus changes (see TerminalView).
#[tauri::command]
fn terminal_focus(focused: bool) {
    TERMINAL_FOCUSED.store(focused, std::sync::atomic::Ordering::Relaxed);
}

/// Connects (or reuses a pooled session) to a saved server. The frontend
/// never sends credentials here — Rust reads them from the database.
#[tauri::command]
async fn ssh_connect(app: tauri::AppHandle, server_id: String) -> Result<(), String> {
    ssh::connect(&app, "user", &server_id).await
}

/// Server ids with a live connection — the Units grid paints status from it.
#[tauri::command]
fn ssh_connected() -> Vec<String> {
    ssh::connected_ids()
}

/// Logs to stderr. Filter with RUST_LOG (default: this crate at info).
fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("gravitation_lib=info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}

pub fn run() {
    init_tracing();
    let migrations = db::migrations();

    tauri::Builder::default()
        // ONE app: a second launch only brings the running window forward.
        // Registered first, as the plugin requires.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // File pickers for SFTP up/downloads and key import.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, migrations)
                .build(),
        )
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                #[cfg(windows)]
                keep_find_keys_for_the_page(&window);
            }
            match db::db_path(app.handle()) {
                Ok(p) => println!("[gravitation] database: {p}"),
                Err(e) => eprintln!("[gravitation] database path unavailable: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal_focus,
            ssh_connect,
            ssh_connected,
            proxy::ssh_list_proxies,
            proxy::ssh_save_proxy,
            proxy::ssh_delete_proxy,
            ssh::ssh_list_servers,
            ssh::ssh_save_server,
            ssh::ssh_reorder_units,
            ssh::ssh_reveal_password,
            ssh::ssh_delete_server,
            ssh::ssh_list_keys,
            ssh::ssh_save_key,
            ssh::ssh_delete_key,
            ssh::ssh_get_key,
            ssh::ssh_derive_public,
            ssh::ssh_generate_key,
            ssh::ssh_list_scripts,
            ssh::ssh_save_script,
            ssh::ssh_delete_script,
            ssh::ssh_shell_open,
            ssh::ssh_shell_input,
            ssh::ssh_shell_resize,
            ssh::ssh_shell_snapshot,
            ssh::ssh_shell_close,
            ssh::ssh_shell_list,
            ssh::ssh_sftp_list,
            ssh::ssh_sftp_home,
            ssh::ssh_sftp_download,
            ssh::ssh_sftp_upload,
            ssh::ssh_sftp_read_text,
            ssh::ssh_sftp_write_text,
            ssh::ssh_sftp_write_chunk,
            ssh::ssh_sftp_rename,
            ssh::ssh_sftp_remove,
            ssh::ssh_sftp_mkdir,
            ssh::ssh_vault_status,
            import::ssh_import_singularity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gravitation");
}

/// WebView2 opens its own find bar on Ctrl+F before the page can say no —
/// preventDefault in JS does not stop it. Turn the browser handling of the
/// find keys off: the key still reaches the page, so the app's own search
/// (SFTP filter, code editor search) gets it instead.
#[cfg(windows)]
fn keep_find_keys_for_the_page(window: &tauri::WebviewWindow) {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AcceleratorKeyPressedEventArgs2;
    use windows_core::Interface;

    const VK_F: u32 = 0x46;
    const VK_G: u32 = 0x47;
    const VK_F3: u32 = 0x72;
    const VK_C: u32 = 0x43;

    let _ = window.with_webview(|webview| unsafe {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            // The event only fires for accelerators (Ctrl/Alt combos and
            // function keys), so a bare F/G typed into a field never lands here.
            // Ctrl+Shift+C is DevTools' "inspect element" — a focused
            // terminal copies with it, so there the browser must not take it
            // first. Everywhere else it keeps its usual meaning.
            let shift = windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x10) < 0;
            let terminal = TERMINAL_FOCUSED.load(std::sync::atomic::Ordering::Relaxed);
            if matches!(key, VK_F | VK_G | VK_F3) || (key == VK_C && shift && terminal) {
                if let Ok(args2) = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
                    args2.SetIsBrowserAcceleratorKeyEnabled(false)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = webview.controller().add_AcceleratorKeyPressed(&handler, &mut token) {
            eprintln!("[gravitation] cannot hook find keys: {e}");
        }
    });
}
