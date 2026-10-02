mod notifications;
mod shell;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
struct SoftwareUpdateExit {
    ready: AtomicBool,
    automatic: AtomicBool,
    quitting: AtomicBool,
}

#[tauri::command]
fn software_updater_available(app: tauri::AppHandle) -> bool {
    !cfg!(debug_assertions)
        && app.config().identifier != "app.kipster.demo"
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|config| config.get("pubkey"))
            .and_then(|key| key.as_str())
            .is_some_and(|key| !key.trim().is_empty())
}

#[tauri::command]
async fn check_software_update(
    webview: tauri::Webview,
    endpoint: String,
) -> Result<Option<serde_json::Value>, String> {
    if !software_updater_available(webview.app_handle().clone()) {
        return Ok(None);
    }
    let url = tauri::Url::parse(&endpoint).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("updates.kipster.app")
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/v1/app/")
        || !url.path().ends_with(".json")
        || url.path().trim_start_matches("/v1/app/").contains('/')
    {
        return Err("Invalid app update endpoint".into());
    }
    let channel = url.path() == "/v1/app/stable.json" || url.path() == "/v1/app/next.json";
    let mut builder = webview
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|error| error.to_string())?
        .timeout(std::time::Duration::from_secs(30));
    if !channel {
        builder = builder.version_comparator(|current, release| current != release.version);
    }
    let update = builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        let metadata = serde_json::json!({
            "currentVersion": update.current_version,
            "version": update.version,
            "body": update.body,
            "rawJson": update.raw_json,
        });
        let rid = webview.resources_table().add(update);
        let mut metadata = metadata;
        metadata["rid"] = rid.into();
        metadata
    }))
}

#[tauri::command]
fn arm_software_update(state: tauri::State<SoftwareUpdateExit>, ready: bool, automatic: bool) {
    state.ready.store(ready, Ordering::SeqCst);
    state.automatic.store(automatic, Ordering::SeqCst);
    if !ready {
        state.quitting.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
fn finish_software_update_quit(app: tauri::AppHandle) {
    app.state::<SoftwareUpdateExit>()
        .ready
        .store(false, Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    if shell::started_hidden_as_duplicate(&context.config().identifier) {
        return;
    }
    let login_item = tauri_plugin_autostart::Builder::new()
        .app_name(context.config().identifier.clone())
        .arg(shell::HIDDEN_ARG);
    #[cfg(target_os = "macos")]
    let login_item = login_item.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    let builder = tauri::Builder::default()
        // Fallback for notifications where the native macOS center is unavailable.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(login_item.build())
        .manage(SoftwareUpdateExit::default())
        .setup(|app| {
            notifications::setup(app.handle());
            shell::setup(app.handle());
            Ok(())
        })
        .on_window_event(shell::on_window_event);
    #[cfg(target_os = "macos")]
    let builder = builder.menu(shell::menu).on_menu_event(|app, event| {
        if event.id() == shell::QUIT_MENU_ID {
            app.exit(0);
        }
    });
    builder
        .invoke_handler(tauri::generate_handler![
            software_updater_available,
            check_software_update,
            arm_software_update,
            finish_software_update_quit,
            notifications::notification_permission,
            notifications::request_notification_permission,
            notifications::send_notification,
            notifications::take_pending_notification_target,
            notifications::open_notification_settings,
            shell::keep_running_enabled,
            shell::set_keep_running,
            shell::open_at_login_enabled,
            shell::set_open_at_login,
        ])
        .build(context)
        .expect("error while building Kipster")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                let state = app.state::<SoftwareUpdateExit>();
                if state.ready.load(Ordering::SeqCst) && state.automatic.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    if !state.quitting.swap(true, Ordering::SeqCst)
                        && app.emit("software-update-quit", ()).is_err()
                    {
                        state.ready.store(false, Ordering::SeqCst);
                        app.exit(0);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => notifications::show_main_window(app),
            _ => {}
        });
}
