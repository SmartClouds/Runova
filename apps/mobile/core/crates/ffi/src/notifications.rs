//! The inbox and its switches, from Runova's servers, so they need no computer.

use crate::backend::BackendError;
use crate::engine::{Done, Engine, Runner};
use crate::view::{
    AppView, NotificationDestination, NotificationItemView, NotificationPreferenceView,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

const LIST: &str = "/api/v1/notifications?page=1&pageSize=50";
const PREFERENCES: &str = "/api/v1/accounts/me/notification-preferences";
const READ_MARKERS: &str = "/api/v1/notification-read-markers";
const PUSH_DEVICE: &str = "/api/v1/accounts/me/push-devices/current";
/// What arrives live is not re-read, so this only catches up on anything missed.
const INBOX_EVERY_TICKS: u32 = 15;
const MAX_ITEMS: usize = 200;

/// What the notifications hub says that the app cares about.
pub enum FeedEvent {
    Notification(Value),
    MonitorChanged,
}

#[async_trait]
pub trait FeedConnector: Send + Sync {
    async fn connect(&self, token: String) -> Result<mpsc::Receiver<FeedEvent>, String>;
}

/// For when live delivery is not wanted.
pub struct NoFeed;

#[async_trait]
impl FeedConnector for NoFeed {
    async fn connect(&self, _token: String) -> Result<mpsc::Receiver<FeedEvent>, String> {
        Err("no feed".to_owned())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemDto {
    id: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    kind: String,
    category: Option<String>,
    read_at: Option<String>,
}

#[derive(Deserialize)]
struct ListDto {
    #[serde(default)]
    items: Vec<ItemDto>,
    #[serde(default)]
    unread: u32,
}

#[derive(Deserialize)]
struct PreferenceDto {
    category: String,
    label: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct PreferencesDto {
    #[serde(default)]
    items: Vec<PreferenceDto>,
}

fn item_of(dto: ItemDto) -> NotificationItemView {
    let category = dto.category.unwrap_or(dto.kind);
    NotificationItemView {
        id: dto.id,
        title: dto.title,
        body: dto.body,
        destination: notification_destination(category.clone()),
        category,
        read: dto.read_at.is_some(),
    }
}

/// Which screen a notification opens. Native code uses this for a tapped push too.
#[uniffi::export]
pub fn notification_destination(category: String) -> NotificationDestination {
    match category.as_str() {
        "monitors" => NotificationDestination::Monitors,
        "account" => NotificationDestination::Account,
        _ => NotificationDestination::Inbox,
    }
}

impl Runner {
    pub(crate) fn refresh_notifications(&mut self) {
        let due = self.ticks.is_multiple_of(INBOX_EVERY_TICKS);
        self.ticks = self.ticks.wrapping_add(1);
        if !due {
            return;
        }
        self.view.notifications.loading = self.view.notifications.items.is_empty();
        self.rest(
            LIST,
            |view: &mut AppView, dto: ListDto| {
                view.notifications.loading = false;
                view.notifications.unread = dto.unread;
                view.notifications.items = dto.items.into_iter().map(item_of).collect();
            },
            |view| view.notifications.loading = false,
        );
        self.rest(
            PREFERENCES,
            |view: &mut AppView, dto: PreferencesDto| {
                view.notifications.preferences = dto
                    .items
                    .into_iter()
                    .map(|p| NotificationPreferenceView {
                        category: p.category,
                        label: p.label,
                        enabled: p.enabled,
                    })
                    .collect();
            },
            |_| {},
        );
    }

    pub(crate) fn on_feed_event(&mut self, event: Option<FeedEvent>) {
        match event {
            Some(FeedEvent::Notification(value)) => {
                let Ok(dto) = serde_json::from_value::<ItemDto>(value) else {
                    return;
                };
                let item = item_of(dto);
                let screen = &mut self.view.notifications;
                // A phone that is connected gets both the push and this, with the same id.
                if screen.items.iter().any(|known| known.id == item.id) {
                    return;
                }
                if !item.read {
                    screen.unread += 1;
                }
                screen.banner = Some(item.clone());
                screen.items.insert(0, item);
                screen.items.truncate(MAX_ITEMS);
            }
            Some(FeedEvent::MonitorChanged) => self.refresh_cloud_if_on_show(),
            None => self.feed_events = None,
        }
    }

    pub(crate) fn send_push_token(&mut self) {
        let Some(token) = self.push_token.clone() else {
            return;
        };
        let backend = self.deps_backend();
        let platform = self.platform_name();
        tokio::spawn(async move {
            // A failure is retried at the next start, and the inbox still works without it.
            let _ = backend
                .send_json(
                    "PUT",
                    PUSH_DEVICE,
                    json!({ "platform": platform, "pushToken": token }),
                )
                .await;
        });
    }

    fn open_notification(&mut self, id: i64) {
        let screen = &mut self.view.notifications;
        if screen.banner.as_ref().is_some_and(|b| b.id == id) {
            screen.banner = None;
        }
        let Some(item) = screen.items.iter_mut().find(|i| i.id == id && !i.read) else {
            return;
        };
        item.read = true;
        screen.unread = screen.unread.saturating_sub(1);
        let backend = self.deps_backend();
        tokio::spawn(async move {
            let path = format!("/api/v1/notifications/{id}");
            let _ = backend
                .send_json("PATCH", &path, json!({ "read": true }))
                .await;
        });
    }

    fn mark_all_read(&mut self) {
        let screen = &mut self.view.notifications;
        for item in &mut screen.items {
            item.read = true;
        }
        screen.unread = 0;
        let backend = self.deps_backend();
        tokio::spawn(async move {
            let _ = backend
                .send_json("POST", READ_MARKERS, json!({ "before": null }))
                .await;
        });
    }

    fn set_enabled(&mut self, category: String, enabled: bool) {
        let Some(preference) = self
            .view
            .notifications
            .preferences
            .iter_mut()
            .find(|p| p.category == category)
        else {
            return;
        };
        // Moves at once, and goes back only if the server says no.
        preference.enabled = enabled;
        let backend = self.deps_backend();
        let done = self.done_tx.clone();
        let attempt = self.attempt;
        tokio::spawn(async move {
            let path = format!("{PREFERENCES}/{category}");
            let outcome = backend
                .send_json("PUT", &path, json!({ "enabled": enabled }))
                .await;
            if let Err(error) = outcome {
                let task = move |runner: &mut Runner| {
                    if let Some(preference) = runner
                        .view
                        .notifications
                        .preferences
                        .iter_mut()
                        .find(|p| p.category == category)
                    {
                        preference.enabled = !enabled;
                    }
                    match error {
                        BackendError::SignedOut => runner.on_signed_out(),
                        BackendError::Failed(message) => runner.view.error = Some(message),
                    }
                };
                let _ = done.send(Done::Run {
                    attempt,
                    task: Box::new(task),
                });
            }
        });
    }
}

#[uniffi::export]
impl Engine {
    pub fn notification_open(&self, id: i64) {
        self.run(move |r| r.open_notification(id));
    }

    pub fn notification_dismiss_banner(&self) {
        self.run(|r| r.view.notifications.banner = None);
    }

    pub fn notifications_mark_all_read(&self) {
        self.run(Runner::mark_all_read);
    }

    pub fn notifications_open_settings(&self) {
        self.run(|r| r.view.notifications.settings_open = true);
    }

    pub fn notifications_close_settings(&self) {
        self.run(|r| r.view.notifications.settings_open = false);
    }

    pub fn notification_set_enabled(&self, category: String, enabled: bool) {
        self.run(move |r| r.set_enabled(category, enabled));
    }

    /// Native code calls this when the OS hands it a token, at any time.
    pub fn register_push_token(&self, token: String) {
        self.run(move |r| {
            r.push_token = Some(token);
            if r.view.auth == crate::view::AuthState::SignedIn {
                r.send_push_token();
            }
        });
    }
}
