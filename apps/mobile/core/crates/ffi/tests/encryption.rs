mod common;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use common::{PHONE_SEED, World, connected, signed_in};
use runova_crypto::sealed::{SealKey, seal_with};
use runova_ffi::encryption::{notification_secret, open_sealed_notification};
use runova_ffi::view::Section;
use serde_json::{Value, json};

const ENCRYPTION: &str = "/api/v1/accounts/me/encryption";
const LIST: &str = "/api/v1/notifications?page=1&pageSize=50";
const PREFERENCES: &str = "/api/v1/accounts/me/notification-preferences";

fn phone() -> SealKey {
    SealKey::from_identity_seed(&PHONE_SEED)
}

fn sealed_for(key: &SealKey, line: &str, category: &str) -> String {
    URL_SAFE_NO_PAD.encode(seal_with(
        &key.public_key(),
        [9; 32],
        [8; 12],
        line.as_bytes(),
        &format!("notification:{category}"),
    ))
}

fn row(item: &str, label: &str, extra: Value) -> Value {
    let mut base = json!({"item": item, "label": label, "enabled": false, "active": false,
                          "lapsed": false, "needsKey": false});
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        base.extend(extra.clone());
    }
    base
}

fn status(entitled: bool, plan: &str, notifications: Value, sync: Value) -> Value {
    json!({"entitled": entitled, "planName": plan, "items": [
        row("notifications", "Notifications", notifications),
        row("sync", "Cloud sync", sync),
    ]})
}

async fn on_account(answer: Value) -> World {
    let world = signed_in().await;
    world.backend.answer(ENCRYPTION, answer);
    world.engine.open_section(Some(Section::Account));
    world
        .until(|v| v.encryption.is_some(), "the switches")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn each_item_has_its_own_switch() {
    let world = on_account(status(true, "Pro", json!({"enabled": true}), json!({}))).await;

    let screen = world.latest().and_then(|v| v.encryption).expect("screen");
    assert_eq!(screen.items.len(), 2);
    assert_eq!(screen.items[0].label, "Notifications");
    assert!(screen.items[0].enabled);
    assert!(!screen.items[1].enabled);
    assert!(screen.items.iter().all(|item| item.can_change));
    assert_eq!(screen.note, None);
    assert_eq!(screen.warning, None);
    assert!(screen.footnote.contains("TLS"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_free_plan_is_told_and_can_not_turn_it_on() {
    let world = on_account(status(false, "Free", json!({}), json!({}))).await;

    let screen = world.latest().and_then(|v| v.encryption).expect("screen");
    assert!(screen.items.iter().all(|item| !item.can_change));
    assert_eq!(
        screen.note.as_deref(),
        Some("Included with Go, Pro and Ultra. You are on Free.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_downgrade_it_warns_and_can_still_be_turned_off() {
    let world = on_account(status(
        false,
        "Free",
        json!({"enabled": true, "lapsed": true}),
        json!({}),
    ))
    .await;

    let screen = world.latest().and_then(|v| v.encryption).expect("screen");
    assert!(
        screen
            .warning
            .expect("warning")
            .contains("so Notifications went back to normal")
    );
    assert_eq!(screen.note, None);
    assert!(screen.items[0].can_change);
    assert!(!screen.items[1].can_change);
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_asks_for_a_key_first() {
    let world = on_account(status(true, "Pro", json!({}), json!({"needsKey": true}))).await;

    let screen = world.latest().and_then(|v| v.encryption).expect("screen");
    assert!(!screen.items[1].can_change);
    assert_eq!(screen.items[1].detail, "Set a key on your computer first.");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switch_moves_at_once_and_takes_what_the_server_says() {
    let world = on_account(status(true, "Pro", json!({}), json!({}))).await;
    world.backend.answer(
        &format!("{ENCRYPTION}/notifications"),
        status(true, "Pro", json!({"enabled": true}), json!({})),
    );

    world
        .engine
        .set_encryption("notifications".to_owned(), true);

    world
        .until(
            |v| v.encryption.as_ref().is_some_and(|s| s.items[0].enabled),
            "the switch",
        )
        .await;
    let sent = world.backend.sent();
    let (method, _, body) = sent
        .iter()
        .find(|(_, path, _)| path.ends_with("/encryption/notifications"))
        .expect("the change");
    assert_eq!(method, "PUT");
    assert_eq!(body, &json!({"enabled": true}));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_puts_the_switch_back_and_says_why() {
    let world = on_account(status(true, "Pro", json!({}), json!({}))).await;
    world.backend.refuse(&format!("{ENCRYPTION}/notifications"));

    world
        .engine
        .set_encryption("notifications".to_owned(), true);

    let view = world.until(|v| v.error.is_some(), "the refusal").await;
    assert!(view.error.is_some());
    assert!(!view.encryption.expect("screen").items[0].enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_too_old_to_answer_shows_nothing_and_no_error() {
    let world = signed_in().await;
    world.backend.refuse(ENCRYPTION);
    world
        .backend
        .answer("/api/v1/accounts/me", json!({"email": "sam@example.com"}));

    world.engine.open_section(Some(Section::Account));
    world
        .until(|v| v.account.profile.is_some(), "the account")
        .await;

    let view = world.latest().expect("view");
    assert!(view.encryption.is_none());
}

fn answer_inbox(world: &World, items: Value) {
    world.backend.answer(
        LIST,
        json!({"items": items, "page": 1, "pageSize": 50, "totalItems": 1, "totalPages": 1, "unread": 1}),
    );
    world.backend.answer(PREFERENCES, json!({"items": []}));
}

async fn inbox_with(items: Value) -> String {
    let world = signed_in().await;
    answer_inbox(&world, items);
    world.engine.open_section(Some(Section::Notifications));
    world
        .until(|v| !v.notifications.items.is_empty(), "the inbox")
        .await
        .notifications
        .items[0]
        .title
        .clone()
}

fn sealed_row(copies: Value) -> Value {
    json!([{"id": 1, "kind": "deploys", "title": "New activity on your computer", "body": "",
            "category": "deploys", "readAt": null, "sealed": copies}])
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sealed_line_opens_in_the_inbox() {
    let key = phone();
    let copy = sealed_for(&key, "Critical alert on prod", "deploys");
    let title = inbox_with(sealed_row(json!([{"keyId": key.key_id(), "sealed": copy}]))).await;

    assert_eq!(title, "Critical alert on prod");
}

#[tokio::test(flavor = "multi_thread")]
async fn it_picks_its_own_copy_out_of_several() {
    let key = phone();
    let other = SealKey::from_identity_seed(&[3; 32]);
    let copies = json!([
        {"keyId": other.key_id(), "sealed": sealed_for(&other, "Not for you", "deploys")},
        {"keyId": key.key_id(), "sealed": sealed_for(&key, "For you", "deploys")},
    ]);

    assert_eq!(inbox_with(sealed_row(copies)).await, "For you");
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_copy_for_this_phone_the_generic_line_stays() {
    let other = SealKey::from_identity_seed(&[3; 32]);
    let copies = json!([{"keyId": other.key_id(), "sealed": sealed_for(&other, "x", "deploys")}]);

    assert_eq!(
        inbox_with(sealed_row(copies)).await,
        "New activity on your computer"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_copy_moved_to_another_category_stays_shut() {
    let key = phone();
    let copy = sealed_for(&key, "Critical alert on prod", "tasks");
    let title = inbox_with(sealed_row(json!([{"keyId": key.key_id(), "sealed": copy}]))).await;

    assert_eq!(title, "New activity on your computer");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_computer_is_told_which_key_to_seal_for() {
    let world = connected().await;

    let expected = URL_SAFE_NO_PAD.encode(phone().public_key());
    world
        .until(
            |_| !world.computer.params_of("phone.setSealKey").is_empty(),
            "the key",
        )
        .await;
    assert_eq!(
        world.computer.params_of("phone.setSealKey"),
        vec![Some(json!({"publicKey": expected}))]
    );
}

#[test]
fn a_push_opens_with_only_the_secret() {
    let key = phone();
    let seed = URL_SAFE_NO_PAD.encode(PHONE_SEED);
    let secret = notification_secret(seed).expect("secret");
    let sealed = sealed_for(&key, "Codex finished in Shop", "agent-finished");

    assert_eq!(
        open_sealed_notification(secret, "agent-finished".to_owned(), sealed).as_deref(),
        Some("Codex finished in Shop")
    );
}

#[test]
fn a_push_that_will_not_open_falls_back() {
    let seed = URL_SAFE_NO_PAD.encode(PHONE_SEED);
    let secret = notification_secret(seed).expect("secret");

    assert_eq!(
        open_sealed_notification(secret.clone(), "deploys".to_owned(), "AAAA".to_owned()),
        None
    );
    assert_eq!(
        open_sealed_notification("short".to_owned(), "deploys".to_owned(), "AAAA".to_owned()),
        None
    );
    assert_eq!(notification_secret("short".to_owned()), None);
}
