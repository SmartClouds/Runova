mod common;

use common::{World, connected};
use runova_ffi::engine::AppLifecycle;
use runova_ffi::view::{Section, VaultLockState};
use serde_json::{Value, json};
use std::time::Duration;

fn status(state: &str) -> Value {
    json!({"state": state, "retryAfterMs": 0})
}

fn entries() -> Value {
    json!([{
        "id": "e1", "type": "login", "title": "GitHub", "username": "sam", "service": "", "host": "github.com",
        "favorite": true, "hasPassword": true, "hasTotp": true, "hasSecret": false, "hasNotes": false,
        "fields": [
            {"id": "f1", "label": "PIN", "concealed": true, "hasValue": true},
            {"id": "f2", "label": "Plan", "concealed": false, "hasValue": true},
        ],
    }])
}

async fn on_vault(state: &str) -> World {
    let world = connected().await;
    world.computer.answer("vault.status", status(state));
    world.computer.answer("vault.list", entries());
    world.engine.open_section(Some(Section::Vault));
    world
        .until(|v| v.vault.state != VaultLockState::Unknown, "the state")
        .await;
    world
}

async fn unlocked_entry() -> World {
    let world = on_vault("unlocked").await;
    world
        .until(|v| !v.vault.entries.is_empty(), "the list")
        .await;
    world.engine.vault_open_entry("e1".into());
    world
        .until(|v| v.vault.open_entry.is_some(), "the entry")
        .await;
    world
}

async fn revealed() -> World {
    let world = unlocked_entry().await;
    world
        .computer
        .answer("vault.reveal", json!({"value": "hunter2"}));
    world.engine.vault_request_reveal("password".into(), false);
    let view = world
        .until(|v| v.vault.biometric.is_some(), "the prompt")
        .await;
    world
        .engine
        .biometric_result(view.vault.biometric.unwrap().id, true);
    world
        .until(|v| v.vault.revealed.is_some(), "the value")
        .await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn while_locked_nothing_is_listed() {
    let world = on_vault("locked").await;

    tokio::time::sleep(Duration::from_millis(60)).await;

    assert!(world.computer.params_of("vault.list").is_empty());
    assert_eq!(world.latest().unwrap().vault.state, VaultLockState::Locked);
}

#[tokio::test(flavor = "multi_thread")]
async fn being_on_show_is_known_so_native_code_can_block_screenshots() {
    let world = on_vault("locked").await;
    world.until(|v| v.vault.on_show, "on show").await;

    world.engine.open_section(None);

    world.until(|v| !v.vault.on_show, "off show").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unlocking_sends_the_password_and_opens_the_list() {
    let world = on_vault("locked").await;
    world.computer.answer("vault.unlock", json!({"ok": true}));
    world.computer.answer("vault.status", status("unlocked"));

    world.engine.vault_unlock("correct horse".into());
    let view = world
        .until(|v| !v.vault.entries.is_empty(), "the list")
        .await;

    assert_eq!(
        world.computer.params_of("vault.unlock"),
        vec![Some(json!({"password": "correct horse"}))]
    );
    assert_eq!(view.vault.state, VaultLockState::Unlocked);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_password_says_so() {
    let world = on_vault("locked").await;
    world.computer.answer(
        "vault.unlock",
        json!({"ok": false, "reason": "wrong-password", "retryAfterMs": 0}),
    );

    world.engine.vault_unlock("nope".into());
    let view = world
        .until(|v| v.vault.unlock_error.is_some(), "the message")
        .await;

    assert_eq!(
        view.vault.unlock_error.as_deref(),
        Some("That password isn't right.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn too_many_tries_says_how_long_to_wait() {
    let world = on_vault("locked").await;
    world.computer.answer(
        "vault.unlock",
        json!({"ok": false, "reason": "throttled", "retryAfterMs": 4500}),
    );

    world.engine.vault_unlock("nope".into());
    let view = world
        .until(|v| v.vault.unlock_error.is_some(), "the message")
        .await;

    assert_eq!(
        view.vault.unlock_error.as_deref(),
        Some("Too many tries. Wait 5 seconds.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_entry_offers_only_the_secrets_it_has() {
    let world = unlocked_entry().await;

    let view = world.latest().unwrap();
    let entry = &view.vault.entries[0];
    let keys: Vec<&str> = entry.secrets.iter().map(|s| s.key.as_str()).collect();

    assert_eq!(keys, ["password", "totpSecret", "f1"]);
    assert!(entry.secrets[2].custom);
    assert_eq!(entry.secrets[0].label, "Password");
}

#[tokio::test(flavor = "multi_thread")]
async fn revealing_waits_for_the_phone_to_confirm_who_is_holding_it() {
    let world = unlocked_entry().await;

    world.engine.vault_request_reveal("password".into(), false);
    world
        .until(|v| v.vault.biometric.is_some(), "the prompt")
        .await;
    tokio::time::sleep(Duration::from_millis(40)).await;

    assert!(world.computer.params_of("vault.reveal").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn once_confirmed_the_value_is_shown() {
    let world = revealed().await;

    let view = world.latest().unwrap();

    assert_eq!(view.vault.revealed.as_ref().unwrap().value, "hunter2");
    assert!(view.vault.biometric.is_none());
    assert_eq!(
        world.computer.params_of("vault.reveal"),
        vec![Some(json!({"id": "e1", "field": "password"}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_custom_field_is_asked_for_by_its_id() {
    let world = unlocked_entry().await;
    world
        .computer
        .answer("vault.reveal", json!({"value": "1234"}));

    world.engine.vault_request_reveal("f1".into(), true);
    let view = world
        .until(|v| v.vault.biometric.is_some(), "the prompt")
        .await;
    world
        .engine
        .biometric_result(view.vault.biometric.unwrap().id, true);
    world
        .until(|v| v.vault.revealed.is_some(), "the value")
        .await;

    assert_eq!(
        world.computer.params_of("vault.reveal"),
        vec![Some(json!({"id": "e1", "field": {"customFieldId": "f1"}}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_check_reveals_nothing() {
    let world = unlocked_entry().await;

    world.engine.vault_request_reveal("password".into(), false);
    let view = world
        .until(|v| v.vault.biometric.is_some(), "the prompt")
        .await;
    world
        .engine
        .biometric_result(view.vault.biometric.unwrap().id, false);
    let view = world
        .until(|v| v.vault.biometric.is_none(), "cleared")
        .await;
    tokio::time::sleep(Duration::from_millis(40)).await;

    assert_eq!(
        view.error.as_deref(),
        Some("Couldn't confirm it's you, so nothing was revealed.")
    );
    assert!(world.computer.params_of("vault.reveal").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_to_an_old_check_counts_for_nothing() {
    let world = unlocked_entry().await;

    world.engine.vault_request_reveal("password".into(), false);
    let view = world
        .until(|v| v.vault.biometric.is_some(), "the prompt")
        .await;
    world
        .engine
        .biometric_result(view.vault.biometric.unwrap().id + 1, true);
    tokio::time::sleep(Duration::from_millis(40)).await;

    assert!(world.computer.params_of("vault.reveal").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_the_entry_forgets_the_value() {
    let world = revealed().await;

    world.engine.vault_close_entry();

    world
        .until(|v| v.vault.revealed.is_none(), "forgotten")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hiding_forgets_the_value() {
    let world = revealed().await;

    world.engine.vault_hide();

    world
        .until(|v| v.vault.revealed.is_none(), "forgotten")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_vault_forgets_the_value() {
    let world = revealed().await;

    world.engine.open_section(None);

    world
        .until(|v| v.vault.revealed.is_none(), "forgotten")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn going_to_the_background_forgets_the_value_at_once() {
    let world = revealed().await;

    world.engine.lifecycle(AppLifecycle::Backgrounded {
        grace_ms: 3_600_000,
    });

    world
        .until(|v| v.vault.revealed.is_none(), "forgotten")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn locking_clears_the_list_and_the_value() {
    let world = revealed().await;
    world.computer.answer("vault.lock", json!(null));
    world.computer.answer("vault.status", status("locked"));

    world.engine.vault_lock();

    let view = world
        .until(|v| v.vault.state == VaultLockState::Locked, "locked")
        .await;
    assert!(view.vault.entries.is_empty());
    assert!(view.vault.revealed.is_none());
    assert!(view.vault.open_entry.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lock_from_the_computer_is_noticed_and_clears_the_value() {
    let world = revealed().await;

    world.computer.answer("vault.status", status("locked"));

    let view = world
        .until(|v| v.vault.state == VaultLockState::Locked, "locked")
        .await;
    assert!(view.vault.revealed.is_none());
    assert!(view.vault.entries.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn saving_sends_only_what_changed() {
    let world = unlocked_entry().await;
    world.computer.answer("vault.save", json!({}));

    world.engine.vault_save(
        Some("e1".into()),
        "GitHub 2".into(),
        Some("sammy".into()),
        None,
    );
    world
        .until(
            |_| !world.computer.params_of("vault.save").is_empty(),
            "saved",
        )
        .await;

    assert_eq!(
        world.computer.params_of("vault.save"),
        vec![Some(
            json!({"id": "e1", "title": "GitHub 2", "username": "sammy"})
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_asks_first() {
    let world = unlocked_entry().await;
    world.computer.answer("vault.remove", json!(1));

    world.engine.vault_remove("e1".into());
    let view = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(view.confirm.unwrap().danger);
    assert!(world.computer.params_of("vault.remove").is_empty());

    world.engine.confirm();
    world
        .until(
            |_| !world.computer.params_of("vault.remove").is_empty(),
            "sent",
        )
        .await;
    world
        .until(|v| v.vault.open_entry.is_none(), "closed")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_computer_forgets_everything() {
    let world = revealed().await;

    world.engine.disconnect();

    let view = world
        .until(|v| v.connection.is_none(), "disconnected")
        .await;
    assert!(view.vault.revealed.is_none());
    assert!(view.vault.entries.is_empty());
    assert_eq!(view.vault.state, VaultLockState::Unknown);
}
