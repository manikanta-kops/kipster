use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Creates the main window; web pages outside the app open in the default browser.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("tauri.conf.json defines the main window")
        .clone();
    let dev_url = app.config().build.dev_url.clone();
    let opener = app.clone();
    let navigator = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, _| {
            let _ = open_in_browser(&opener, url.as_str());
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            let inside = !matches!(url.scheme(), "http" | "https")
                || url.host_str() == Some("tauri.localhost")
                || dev_url
                    .as_ref()
                    .is_some_and(|dev| dev.origin() == url.origin());
            if !inside {
                let _ = open_in_browser(&navigator, url.as_str());
            }
            inside
        })
        .build()?;
    Ok(())
}

fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https addresses open in the browser".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Opens an http or https address in the default browser.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    open_in_browser(&app, &url)
}
