mod common;

use common::{World, signed_in};
use runova_ffi::notifications::notification_destination;
use runova_ffi::view::{NotificationDestination, Section};
use serde_json::{Value, json};

const LIST: &str = "/api/v1/notifications?page=1&pageSize=50";
const PREFERENCES: &str = "/api/v1/accounts/me/notification-preferences";

fn item(id: i64, title: &str, category: &str, read: bool) -> Value {
    json!({"id": id, "kind": category, "title": title, "body": "", "severity": "info",
           "createdAt": "2026-01-02T03:04:05Z", "readAt": if read { json!("x") } else { Value::Null },
           "category": category})
}

fn answer(world: &World) {
    world.backend.answer(
        LIST,
        json!({"items": [item(1, "Deploy failed on prod", "deploys", false),
                         item(2, "Claude needs input", "agent-needs-input", true)],
               "page": 1, "pageSize": 50, "totalItems": 2, "totalPages": 1, "unread": 1}),
    );
    world.backend.answer(
        PREFERENCES,
        json!({"items": [
            {"category": "deploys", "label": "Deploys", "enabled": true},
            {"category": "monitors", "label": "Monitors", "enabled": false},
        ]}),
    );
}

async fn on_inbox() -> World {
    let world = signed_in().await;
    answer(&world);
    world.engine.open_section(Some(Section::Notifications));
    world
        .until(
            |v| !v.notifications.items.is_empty() && !v.notifications.preferences.is_empty(),
            "the inbox",
        )
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_inbox_needs_no_computer_and_counts_what_is_unread() {
    let world = on_inbox().await;

    let screen = world.latest().unwrap().notifications;

    assert_eq!(screen.unread, 1);
    assert_eq!(screen.items[0].title, "Deploy failed on prod");
    assert!(!screen.items[0].read);
    assert!(screen.items[1].read);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_one_arrives_live_on_top_and_as_a_banner() {
    let world = on_inbox().await;

    world
        .feed
        .notification(item(3, "Monitor Shop is down", "monitors", false));
    let view = world
        .until(|v| v.notifications.items.len() == 3, "the new one")
        .await;

    assert_eq!(view.notifications.items[0].id, 3);
    assert_eq!(view.notifications.unread, 2);
    assert_eq!(view.notifications.banner.unwrap().id, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_one_twice_is_shown_once() {
    let world = on_inbox().await;

    world.feed.notification(item(3, "Once", "monitors", false));
    world
        .until(|v| v.notifications.items.len() == 3, "the new one")
        .await;
    world.feed.notification(item(3, "Once", "monitors", false));
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;

    let view = world.latest().unwrap();
    assert_eq!(view.notifications.items.len(), 3);
    assert_eq!(view.notifications.unread, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_banner_can_be_put_away() {
    let world = on_inbox().await;
    world
        .feed
        .notification(item(3, "Banner", "monitors", false));
    world
        .until(|v| v.notifications.banner.is_some(), "the banner")
        .await;

    world.engine.notification_dismiss_banner();

    world
        .until(|v| v.notifications.banner.is_none(), "gone")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_one_marks_it_read_on_the_server() {
    let world = on_inbox().await;
    world.backend.answer("/api/v1/notifications/1", json!({}));

    world.engine.notification_open(1);
    let view = world.until(|v| v.notifications.items[0].read, "read").await;

    assert_eq!(view.notifications.unread, 0);
    assert_eq!(
        world.backend.sent()[0],
        (
            "PATCH".to_owned(),
            "/api/v1/notifications/1".to_owned(),
            json!({"read": true})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn all_can_be_marked_read() {
    let world = on_inbox().await;
    world
        .backend
        .answer("/api/v1/notification-read-markers", json!({"marked": 1}));

    world.engine.notifications_mark_all_read();
    let view = world.until(|v| v.notifications.unread == 0, "read").await;

    assert!(view.notifications.items.iter().all(|i| i.read));
    assert_eq!(
        world.backend.sent()[0],
        (
            "POST".to_owned(),
            "/api/v1/notification-read-markers".to_owned(),
            json!({"before": null})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_category_can_be_switched() {
    let world = on_inbox().await;
    let path = format!("{PREFERENCES}/monitors");
    world.backend.answer(&path, json!({}));

    world
        .engine
        .notification_set_enabled("monitors".into(), true);
    let view = world
        .until(|v| v.notifications.preferences[1].enabled, "on")
        .await;

    assert!(view.notifications.preferences[1].enabled);
    assert_eq!(
        world.backend.sent()[0],
        ("PUT".to_owned(), path, json!({"enabled": true}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switch_that_failed_goes_back() {
    let world = on_inbox().await;

    world
        .engine
        .notification_set_enabled("deploys".into(), false);
    world.until(|v| v.error.is_some(), "the error").await;

    assert!(world.latest().unwrap().notifications.preferences[0].enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_push_token_reaches_the_server_with_this_platform() {
    let world = signed_in().await;
    let path = "/api/v1/accounts/me/push-devices/current";
    world.backend.answer(path, json!({}));

    world.engine.register_push_token("tok".into());
    world
        .until(|_| !world.backend.sent().is_empty(), "sent")
        .await;

    assert_eq!(
        world.backend.sent()[0],
        (
            "PUT".to_owned(),
            path.to_owned(),
            json!({"platform": "android", "pushToken": "tok"})
        )
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_to_a_cloud_monitor_refreshes_the_list_at_once() {
    let world = signed_in().await;
    world.backend.answer(
        "/api/v1/cloud-monitors",
        json!({"items": [{"id": "m1", "name": "Shop", "paused": false, "canWrite": true,
                          "status": {"verdict": "up"}}]}),
    );
    world.engine.open_section(Some(Section::Monitoring));
    world
        .until(|v| !v.monitoring.cloud.is_empty(), "the list")
        .await;
    world.backend.answer(
        "/api/v1/cloud-monitors",
        json!({"items": [{"id": "m1", "name": "Shop", "paused": false, "canWrite": true,
                          "status": {"verdict": "down"}}]}),
    );

    world.feed.monitor_changed();

    world
        .until(
            |v| v.monitoring.cloud[0].state == runova_ffi::view::MonitorState::Down,
            "the change",
        )
        .await;
}

#[test]
fn each_category_opens_the_screen_it_is_about() {
    assert_eq!(
        notification_destination("monitors".into()),
        NotificationDestination::Monitors
    );
    assert_eq!(
        notification_destination("account".into()),
        NotificationDestination::Account
    );
    assert_eq!(
        notification_destination("deploys".into()),
        NotificationDestination::Inbox
    );
}
