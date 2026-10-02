//! Desktop lifecycle: keep running after the window closes, open at login,
//! and a Quit command that goes through `ExitRequested`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

/// Passed by the login item; the app starts without showing its window.
pub const HIDDEN_ARG: &str = "--hidden";

/// Read before the webview loads, so the window and login item behave correctly
/// from the first moment.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    keep_running: bool,
    /// Set once open at login has been turned on by default or chosen by the
    /// user, so the default never overrides the user's choice.
    open_at_login_configured: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keep_running: true,
            open_at_login_configured: false,
        }
    }
}

pub struct ShellState {
    path: Option<PathBuf>,
    keep_running: AtomicBool,
    settings: Mutex<Settings>,
}

impl ShellState {
    fn save(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut settings = self.settings.lock().map_err(|error| error.to_string())?;
        change(&mut settings);
        let path = self.path.as_ref().ok_or("No app configuration directory")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let json = serde_json::to_vec_pretty(&*settings).map_err(|error| error.to_string())?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, json).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    }
}

pub fn setup(app: &AppHandle) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("desktop-shell.json"));
    let settings: Settings = path
        .as_ref()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let state = ShellState {
        path,
        keep_running: AtomicBool::new(settings.keep_running),
        settings: Mutex::new(settings),
    };
    let configure_login = !state
        .settings
        .lock()
        .map(|settings| settings.open_at_login_configured)
        .unwrap_or(true);
    app.manage(state);

    if configure_login && login_item_supported(app) && app.autolaunch().enable().is_ok() {
        let _ = app
            .state::<ShellState>()
            .save(|settings| settings.open_at_login_configured = true);
    }

    if !std::env::args().any(|arg| arg == HIDDEN_ARG) {
        crate::notifications::show_main_window(app);
    }
}

/// The login item starts the binary directly, outside Launch Services, so it
/// can race an instance that macOS reopened at login. That copy steps aside.
pub fn started_hidden_as_duplicate(identifier: &str) -> bool {
    if !std::env::args().any(|arg| arg == HIDDEN_ARG) {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSRunningApplication;
        use objc2_foundation::NSString;
        let own = std::process::id() as i32;
        NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
            identifier,
        ))
        .iter()
        .any(|running| running.processIdentifier() != own)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = identifier;
        false
    }
}

/// Only an installed macOS app registers itself: not `tauri dev`, the demo, or
/// a quarantined copy that macOS runs from a temporary translocated path.
fn login_item_supported(app: &AppHandle) -> bool {
    if !cfg!(target_os = "macos") || app.config().identifier == "app.kipster.demo" {
        return false;
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.canonicalize().ok())
        .map(|exe| exe.to_string_lossy().into_owned())
        .is_some_and(|exe| {
            exe.contains(".app/Contents/MacOS/") && !exe.contains("/AppTranslocation/")
        })
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if !cfg!(target_os = "macos")
        || window.label() != "main"
        || !window
            .state::<ShellState>()
            .keep_running
            .load(Ordering::SeqCst)
    {
        return;
    }
    api.prevent_close();
    let Some(window) = window.get_webview_window("main") else {
        return;
    };
    if window.is_fullscreen().unwrap_or(false) {
        // Hiding a full-screen window leaves an empty Space behind.
        let _ = window.set_fullscreen(false);
        std::thread::spawn(move || hide_after_fullscreen(window));
    } else {
        let _ = window.hide();
    }
}

/// The window reports leaving full screen when the animation starts; hiding
/// before it ends has no effect, so wait for the animation.
fn hide_after_fullscreen(window: WebviewWindow) {
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let _ = window.hide();
}

#[cfg(target_os = "macos")]
pub const QUIT_MENU_ID: &str = "kipster-quit";

/// The default menu with its Quit item replaced. The stock item terminates the
/// process directly, skipping `ExitRequested` and the update installed on quit.
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let items = app_menu.items()?;
        if let Some(position) = items
            .iter()
            .position(|item| matches!(item, MenuItemKind::Predefined(quit) if quit.text().is_ok_and(|text| text.starts_with("Quit"))))
        {
            app_menu.remove_at(position)?;
            let name = &app.package_info().name;
            app_menu.insert(
                &MenuItem::with_id(app, QUIT_MENU_ID, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
                position,
            )?;
        }
    }
    Ok(menu)
}

#[tauri::command]
pub fn keep_running_enabled(state: tauri::State<ShellState>) -> bool {
    state.keep_running.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn set_keep_running(state: tauri::State<ShellState>, on: bool) -> Result<(), String> {
    state.keep_running.store(on, Ordering::SeqCst);
    state.save(|settings| settings.keep_running = on)
}

#[tauri::command]
pub fn open_at_login_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_open_at_login(app: AppHandle, on: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if on {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    }
    .map_err(|error| error.to_string())?;
    app.state::<ShellState>()
        .save(|settings| settings.open_at_login_configured = true)
}
