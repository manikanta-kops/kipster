//! Native notifications.
//!
//! A bundled macOS app uses `UNUserNotificationCenter`, which reports clicks.
//! Elsewhere (other platforms, or `tauri dev`, where the binary is not inside
//! an app bundle) notifications go through `tauri-plugin-notification`, which
//! cannot report clicks.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/// Emitted when the user clicks a notification. Listeners then call
/// `take_pending_notification_target`, so a click that launched the app is not
/// lost before the webview subscribes.
pub const OPEN_EVENT: &str = "notification-open";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notification_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationMessage {
    title: String,
    subtitle: Option<String>,
    body: String,
    thread_id: Option<String>,
    notification_id: Option<String>,
}

#[derive(Default)]
pub struct NotificationState {
    native: bool,
    pending: Mutex<Option<NotificationTarget>>,
}

/// Installs the native click handler. Call from `setup`, which runs inside
/// `applicationDidFinishLaunching`, so the click that launched the app arrives.
pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let native = native::install(app);
    #[cfg(not(target_os = "macos"))]
    let native = false;
    app.manage(NotificationState {
        native,
        ..Default::default()
    });
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn notification_permission(app: AppHandle) -> String {
    #[cfg(target_os = "macos")]
    if app.state::<NotificationState>().native {
        return native::permission(false).await;
    }
    plugin_permission(&app)
}

/// Prompts only if the user has never answered.
#[tauri::command]
pub async fn request_notification_permission(app: AppHandle) -> String {
    #[cfg(target_os = "macos")]
    if app.state::<NotificationState>().native {
        return native::permission(true).await;
    }
    plugin_permission(&app)
}

#[tauri::command]
pub async fn send_notification(app: AppHandle, message: NotificationMessage) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if app.state::<NotificationState>().native {
        return native::send(message).await;
    }
    let body = match &message.subtitle {
        Some(subtitle) if !subtitle.is_empty() => format!("{subtitle}\n{}", message.body),
        _ => message.body,
    };
    tauri::async_runtime::spawn_blocking(move || {
        app.notification()
            .builder()
            .title(message.title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn take_pending_notification_target(
    state: tauri::State<NotificationState>,
) -> Option<NotificationTarget> {
    state.pending.lock().ok()?.take()
}

#[tauri::command]
pub fn open_notification_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={}",
            app.config().identifier
        );
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|error| error.to_string())
            .and_then(|status| {
                status
                    .success()
                    .then_some(())
                    .ok_or_else(|| "Could not open notification settings".into())
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Notification settings are not available on this platform".into())
    }
}

fn plugin_permission(app: &AppHandle) -> String {
    use tauri::plugin::PermissionState;
    match app.notification().permission_state() {
        Ok(PermissionState::Granted) => "granted",
        Ok(PermissionState::Denied) => "denied",
        Ok(_) => "prompt",
        Err(_) => "unavailable",
    }
    .into()
}

#[cfg(target_os = "macos")]
mod native {
    use super::{show_main_window, NotificationMessage, NotificationState, NotificationTarget};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};

    const THREAD_KEY: &str = "threadId";
    const NOTIFICATION_KEY: &str = "notificationId";

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "KipsterNotificationDelegate"]
        #[ivars = AppHandle]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                if &*response.actionIdentifier() == unsafe { UNNotificationDefaultActionIdentifier }
                {
                    open(self.ivars(), response);
                }
                completion.call(());
            }
        }
    );

    fn open(app: &AppHandle, response: &UNNotificationResponse) {
        let info = response.notification().request().content().userInfo();
        let text = |key: &str| {
            info.objectForKey(&NSString::from_str(key))
                .and_then(|value| {
                    value
                        .downcast_ref::<NSString>()
                        .map(|text| text.to_string())
                })
                .filter(|text| !text.is_empty())
        };
        if let Some(thread_id) = text(THREAD_KEY) {
            let target = NotificationTarget {
                thread_id,
                notification_id: text(NOTIFICATION_KEY),
            };
            if let Ok(mut pending) = app.state::<NotificationState>().pending.lock() {
                *pending = Some(target.clone());
            }
            let _ = app.emit(super::OPEN_EVENT, target);
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || show_main_window(&handle));
    }

    /// `UNUserNotificationCenter` requires a real app bundle; `tauri dev` runs a
    /// bare binary even though an Info.plist is embedded in it.
    fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    pub fn install(app: &AppHandle) -> bool {
        if !bundled() {
            return false;
        }
        let delegate: Retained<Delegate> = {
            let this = Delegate::alloc().set_ivars(app.clone());
            unsafe { msg_send![super(this), init] }
        };
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; it must live as long as the app.
        std::mem::forget(delegate);
        tauri::async_runtime::spawn(async {
            if status().await == Some(UNAuthorizationStatus::Authorized) {
                authorize().await;
            }
        });
        true
    }

    /// Waits off the async runtime for a completion handler's answer.
    async fn wait<T: Send + 'static>(receiver: mpsc::Receiver<T>, seconds: u64) -> Option<T> {
        tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_secs(seconds)).ok()
        })
        .await
        .ok()
        .flatten()
    }

    async fn status() -> Option<UNAuthorizationStatus> {
        let (sender, receiver) = mpsc::channel();
        {
            let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                let _ = sender.send(unsafe { settings.as_ref() }.authorizationStatus());
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .getNotificationSettingsWithCompletionHandler(&block);
        }
        wait(receiver, 30).await
    }

    /// Prompts only while undetermined. Once allowed, asking again is silent and
    /// adds badges for earlier grants; the Dock badge is hidden without them.
    async fn authorize() -> bool {
        let (sender, receiver) = mpsc::channel();
        {
            let block = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
                let _ = sender.send(());
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert
                        | UNAuthorizationOptions::Sound
                        | UNAuthorizationOptions::Badge,
                    &block,
                );
        }
        // A prompt waits for the user.
        wait(receiver, 600).await.is_some()
    }

    pub async fn permission(request: bool) -> String {
        let mut current = status().await;
        if request
            && matches!(
                current,
                Some(UNAuthorizationStatus::NotDetermined | UNAuthorizationStatus::Authorized)
            )
            && authorize().await
        {
            current = status().await;
        }
        match current {
            Some(UNAuthorizationStatus::NotDetermined) => "prompt",
            Some(UNAuthorizationStatus::Denied) => "denied",
            Some(_) => "granted",
            None => "unavailable",
        }
        .into()
    }

    pub async fn send(message: NotificationMessage) -> Result<(), String> {
        let receiver = {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&message.title));
            content.setBody(&NSString::from_str(&message.body));
            if let Some(subtitle) = &message.subtitle {
                content.setSubtitle(&NSString::from_str(subtitle));
            }
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let mut keys = Vec::new();
            let mut values = Vec::new();
            if let Some(thread_id) = &message.thread_id {
                content.setThreadIdentifier(&NSString::from_str(thread_id));
                keys.push(NSString::from_str(THREAD_KEY));
                values.push(NSString::from_str(thread_id));
            }
            if let Some(notification_id) = &message.notification_id {
                keys.push(NSString::from_str(NOTIFICATION_KEY));
                values.push(NSString::from_str(notification_id));
            }
            let keys: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
            let values: Vec<&NSString> = values.iter().map(|value| &**value).collect();
            let info = NSDictionary::<NSString, NSString>::from_slices(&keys, &values);
            // SAFETY: an NSDictionary of strings is a valid untyped NSDictionary.
            let info: Retained<NSDictionary<AnyObject, AnyObject>> =
                unsafe { Retained::cast_unchecked(info) };
            unsafe { content.setUserInfo(&info) };

            // Reusing the notification id replaces an earlier banner instead of stacking.
            let identifier = message
                .notification_id
                .as_deref()
                .map(NSString::from_str)
                .unwrap_or_else(|| objc2_foundation::NSUUID::new().UUIDString());
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &identifier,
                &content,
                None,
            );

            let (sender, receiver) = mpsc::channel();
            let block = RcBlock::new(move |error: *mut NSError| {
                let _ = sender.send(
                    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string()),
                );
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&request, Some(&block));
            receiver
        };
        match wait(receiver, 30).await {
            Some(None) => Ok(()),
            Some(Some(error)) => Err(error),
            None => Err("The notification was not confirmed".into()),
        }
    }
}
