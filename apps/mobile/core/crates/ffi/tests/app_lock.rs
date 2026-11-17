//! The app lock (E106) in a whole app: setting a passcode, cold starts, wrong codes and their
//! waits, biometrics, auto-lock, "Forgot passcode?" and the settings behind the current code.

mod common;

use common::{MemoryStore, World, connected, signed_in, signed_in_store, start_signed_in};
use runova_crypto::passcode::hash_passcode;
use runova_ffi::engine::AppLifecycle;
use runova_ffi::secure::SecureStore;
use runova_ffi::view::{
    AppView, AuthState, AutoLock, BiometricKind, PasscodeKind, PasscodeStep, Section,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const SETTINGS: &str = "app-lock";
const TRIES: &str = "app-lock-tries";

fn type_lock(world: &World, digits: &str) {
    for d in digits.bytes() {
        world.engine.lock_key(d - b'0');
    }
}

fn type_settings(world: &World, digits: &str) {
    for d in digits.bytes() {
        world.engine.passcode_key(d - b'0');
    }
}

fn saved(world: &World, key: &str) -> Option<Value> {
    world
        .store
        .get(key.to_owned())
        .map(|json| serde_json::from_str(&json).expect("json"))
}

/// A store whose phone already has a lock set to `code`.
fn locked_store(kind: &str, code: &str, extra: Value) -> Arc<MemoryStore> {
    let store = signed_in_store();
    let mut settings = json!({
        "kind": kind,
        "hash": hash_passcode(code, &[9; 16]),
        "auto_lock": "one_minute",
    });
    for (key, value) in extra.as_object().expect("object") {
        settings[key] = value.clone();
    }
    store.set(SETTINGS.to_owned(), settings.to_string());
    store
}

async fn locked_with(kind: &str, code: &str, extra: Value) -> World {
    start_signed_in(locked_store(kind, code, extra), false).await
}

async fn unlocked_with(extra: Value) -> World {
    let world = locked_with("pin4", "1234", extra).await;
    type_lock(&world, "1234");
    world.until(|v| !v.lock.locked, "unlocked").await;
    world
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_the_lock_on_keeps_a_hash_and_never_the_code() {
    let world = signed_in().await;
    assert!(!world.latest().unwrap().lock.enabled);

    world.engine.passcode_open();
    let view = world.until(|v| v.passcode.open, "the settings").await;
    assert_eq!(view.passcode.step, PasscodeStep::Off);

    world.engine.passcode_start(PasscodeKind::Pin4);
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::Choose, "choosing")
        .await;
    assert_eq!(view.passcode.entry.length, 4);
    assert_eq!(view.passcode.entry.title, "Choose a passcode");

    type_settings(&world, "2580");
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::Confirm, "again")
        .await;
    assert_eq!(view.passcode.entry.filled, 0);
    type_settings(&world, "2580");
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::On, "on")
        .await;

    assert!(view.lock.enabled);
    assert!(!view.lock.locked, "setting it does not lock you out");
    assert_eq!(view.notice.as_deref(), Some("Passcode on."));
    assert_eq!(view.passcode.auto_lock, AutoLock::OneMinute);
    let settings = saved(&world, SETTINGS).expect("saved");
    assert_eq!(settings["kind"], "pin4");
    assert!(settings["hash"].as_str().unwrap().starts_with("scrypt$"));
    for value in settings.as_object().unwrap().values() {
        assert_ne!(value, "2580");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_code_that_differs_starts_over() {
    let world = signed_in().await;
    world.engine.passcode_open();
    world.engine.passcode_start(PasscodeKind::Pin6);
    type_settings(&world, "123456");
    world
        .until(|v| v.passcode.step == PasscodeStep::Confirm, "again")
        .await;
    type_settings(&world, "654321");
    let view = world
        .until(|v| v.passcode.entry.shake == 1, "the shake")
        .await;
    assert_eq!(view.passcode.step, PasscodeStep::Choose);
    assert_eq!(
        view.passcode.entry.error.as_deref(),
        Some("Those didn't match. Try again.")
    );
    assert!(saved(&world, SETTINGS).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_short_password_is_refused() {
    let world = signed_in().await;
    world.engine.passcode_open();
    world.engine.passcode_start(PasscodeKind::Password);
    world.engine.passcode_submit("abc".into());
    let view = world
        .until(|v| v.passcode.entry.error.is_some(), "the problem")
        .await;
    assert_eq!(
        view.passcode.entry.error.as_deref(),
        Some("Use at least 4 characters.")
    );
    assert_eq!(view.passcode.step, PasscodeStep::Choose);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cold_start_is_locked_from_the_first_view() {
    let world = locked_with("pin4", "1234", json!({})).await;
    let views = world.views.0.lock().unwrap().clone();
    assert!(views.iter().all(|v: &AppView| v.lock.locked));
    let first = &views[0];
    assert!(first.lock.enabled);
    assert_eq!(first.lock.entry.length, 4);
    assert_eq!(first.lock.entry.title, "Enter your passcode");
    assert_eq!(first.lock.biometric_label, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_right_code_unlocks_and_a_wrong_one_shakes() {
    let world = locked_with("pin4", "1234", json!({})).await;
    type_lock(&world, "12");
    world.until(|v| v.lock.entry.filled == 2, "two dots").await;
    world.engine.lock_backspace();
    world.until(|v| v.lock.entry.filled == 1, "one dot").await;
    world.engine.lock_backspace();

    type_lock(&world, "0000");
    let view = world.until(|v| v.lock.entry.shake == 1, "the shake").await;
    assert!(view.lock.locked);
    assert_eq!(view.lock.entry.filled, 0);
    assert_eq!(
        view.lock.entry.error.as_deref(),
        Some("Wrong passcode. Try again.")
    );
    assert_eq!(saved(&world, TRIES).unwrap()["failures"], 1);

    type_lock(&world, "1234");
    let view = world.until(|v| !v.lock.locked, "unlocked").await;
    assert_eq!(view.lock.entry.error, None);
    assert!(
        saved(&world, TRIES).is_none(),
        "a right code forgets the wrong ones"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_password_lock_takes_the_typed_password() {
    let world = locked_with("password", "correct horse", json!({})).await;
    let view = world.latest().unwrap();
    assert_eq!(view.lock.entry.kind, PasscodeKind::Password);
    assert_eq!(view.lock.entry.length, 0);
    assert_eq!(view.lock.entry.title, "Enter your password");

    world.engine.lock_submit("wrong horse".into());
    let view = world.until(|v| v.lock.entry.shake == 1, "the shake").await;
    assert_eq!(
        view.lock.entry.error.as_deref(),
        Some("Wrong password. Try again.")
    );
    world.engine.lock_submit("correct horse".into());
    world.until(|v| !v.lock.locked, "unlocked").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_fifth_wrong_code_holds_back_the_next() {
    let world = locked_with("pin4", "1234", json!({})).await;
    for n in 1..=5 {
        type_lock(&world, "9999");
        world
            .until(|v| v.lock.entry.shake == n, "another shake")
            .await;
    }
    let view = world
        .until(|v| v.lock.entry.wait_seconds > 0, "the wait")
        .await;
    assert!((29..=30).contains(&view.lock.entry.wait_seconds));
    assert!(
        view.lock
            .entry
            .error
            .as_deref()
            .unwrap()
            .starts_with("Try again in 0:"),
        "{:?}",
        view.lock.entry.error
    );

    // The right code is not even looked at during the wait.
    type_lock(&world, "1234");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let view = world.latest().unwrap();
    assert!(view.lock.locked);
    assert_eq!(view.lock.entry.filled, 0);
    assert_eq!(saved(&world, TRIES).unwrap()["failures"], 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wait_carries_over_a_restart() {
    let store = locked_store("pin4", "1234", json!({}));
    store.set(
        TRIES.to_owned(),
        json!({"failures": 5, "retry_at_ms": now_ms() + 30_000}).to_string(),
    );
    let world = start_signed_in(store, false).await;
    let first = world.views.0.lock().unwrap()[0].clone();
    assert!((29..=30).contains(&first.lock.entry.wait_seconds));

    // The countdown moves on its own.
    world
        .until(
            |v| v.lock.entry.wait_seconds < first.lock.entry.wait_seconds,
            "a tick",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn biometrics_open_the_lock_and_stale_answers_do_not() {
    let world = locked_with(
        "pin4",
        "1234",
        json!({"biometric": true, "biometric_enrollment": "e1"}),
    )
    .await;
    assert_eq!(
        world.latest().unwrap().lock.biometric,
        None,
        "nothing until the phone says"
    );

    world
        .engine
        .set_biometric_capability(BiometricKind::Face, "Face ID".into(), Some("e1".into()));
    let view = world
        .until(|v| v.lock.biometric.is_some(), "the prompt")
        .await;
    assert_eq!(view.lock.biometric_label.as_deref(), Some("Face ID"));
    assert_eq!(view.lock.biometric_kind, BiometricKind::Face);
    let id = view.lock.biometric.unwrap().id;

    world.engine.biometric_result(id + 100, true);
    world.engine.biometric_result(id, false);
    let view = world
        .until(|v| v.lock.biometric.is_none(), "cancelled")
        .await;
    assert!(view.lock.locked, "a cancel or a stale answer opens nothing");

    world.engine.lock_use_biometric();
    let view = world
        .until(|v| v.lock.biometric.is_some(), "asked again")
        .await;
    world
        .engine
        .biometric_result(view.lock.biometric.unwrap().id, true);
    world.until(|v| !v.lock.locked, "unlocked").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_face_or_finger_turns_biometrics_off() {
    let world = locked_with(
        "pin4",
        "1234",
        json!({"biometric": true, "biometric_enrollment": "e1"}),
    )
    .await;
    world.engine.set_biometric_capability(
        BiometricKind::Fingerprint,
        "Fingerprint".into(),
        Some("e2".into()),
    );
    let view = world
        .until(|v| v.lock.entry.error.is_some(), "the reason")
        .await;
    assert_eq!(
        view.lock.entry.error.as_deref(),
        Some("Fingerprint changed on this phone. Enter your passcode to turn it back on.")
    );
    assert_eq!(view.lock.biometric, None);
    assert_eq!(view.lock.biometric_label, None);
    assert_eq!(saved(&world, SETTINGS).unwrap()["biometric"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn right_away_locks_as_soon_as_the_app_leaves() {
    let world = unlocked_with(json!({"auto_lock": "immediately"})).await;
    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 30_000 });
    world.until(|v| v.lock.locked, "locked").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_short_trip_away_does_not_lock_after_one_minute() {
    let world = unlocked_with(json!({})).await;
    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 30_000 });
    world.engine.lifecycle(AppLifecycle::Foregrounded);
    world.engine.passcode_open();
    let view = world.until(|v| v.passcode.open, "a later view").await;
    assert!(!view.lock.locked);
}

#[tokio::test(flavor = "multi_thread")]
async fn coming_back_locked_offers_biometrics_again() {
    let world = unlocked_with(json!({
        "auto_lock": "immediately", "biometric": true, "biometric_enrollment": null,
    }))
    .await;
    world
        .engine
        .set_biometric_capability(BiometricKind::Face, "Face ID".into(), None);
    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 30_000 });
    let view = world.until(|v| v.lock.locked, "locked").await;
    assert_eq!(view.lock.biometric, None, "not while away");
    world.engine.lifecycle(AppLifecycle::Foregrounded);
    world
        .until(|v| v.lock.biometric.is_some(), "the prompt")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lock_now_locks_and_closes_the_settings() {
    let world = unlocked_with(json!({})).await;
    world.engine.passcode_open();
    world.until(|v| v.passcode.open, "the settings").await;
    world.engine.lock_now();
    let view = world.until(|v| v.lock.locked, "locked").await;
    assert!(!view.passcode.open);
}

#[tokio::test(flavor = "multi_thread")]
async fn locking_drops_a_vault_check_waiting_behind_it() {
    let world = connected().await;
    // Set a lock on this running app through the settings, then reveal and lock.
    world.engine.passcode_open();
    world.engine.passcode_start(PasscodeKind::Pin4);
    type_settings(&world, "1234");
    world
        .until(|v| v.passcode.step == PasscodeStep::Confirm, "again")
        .await;
    type_settings(&world, "1234");
    world
        .until(|v| v.passcode.step == PasscodeStep::On, "on")
        .await;
    world.engine.passcode_close();

    world.computer.answer(
        "vault.status",
        json!({"state": "unlocked", "retryAfterMs": 0}),
    );
    world.computer.answer(
        "vault.list",
        json!([{
            "id": "e1", "type": "login", "title": "GitHub", "username": "sam", "service": "",
            "host": "github.com", "favorite": false, "hasPassword": true, "hasTotp": false,
            "hasSecret": false, "hasNotes": false, "fields": [],
        }]),
    );
    world.engine.open_section(Some(Section::Vault));
    world
        .until(|v| !v.vault.entries.is_empty(), "the list")
        .await;
    world.engine.vault_open_entry("e1".into());
    world
        .until(|v| v.vault.open_entry.is_some(), "the entry")
        .await;
    world.engine.vault_request_reveal("password".into(), false);
    world
        .until(|v| v.vault.biometric.is_some(), "the vault's check")
        .await;

    world.engine.lock_now();
    let view = world.until(|v| v.lock.locked, "locked").await;
    assert_eq!(view.vault.biometric, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn forgot_passcode_signs_the_phone_out_and_removes_the_lock() {
    let world = locked_with("pin4", "1234", json!({})).await;
    world.engine.lock_forgot();
    world.until(|v| v.lock.confirm_forgot, "the question").await;
    world.engine.lock_forgot_confirm(false);
    let view = world.until(|v| !v.lock.confirm_forgot, "back").await;
    assert!(view.lock.locked);

    world.engine.lock_forgot();
    world.until(|v| v.lock.confirm_forgot, "the question").await;
    world.engine.lock_forgot_confirm(true);
    let view = world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;
    assert!(!view.lock.enabled);
    assert!(!view.lock.locked);
    assert!(saved(&world, SETTINGS).is_none());
    assert!(world.store.get("identity-seed".into()).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_settings_ask_for_the_current_code_first() {
    let world = unlocked_with(json!({})).await;
    world.engine.passcode_open();
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::Verify, "the question")
        .await;
    assert_eq!(view.passcode.entry.title, "Enter your passcode");

    // Nothing changes before the code is in.
    world.engine.passcode_off();
    world.engine.set_auto_lock(AutoLock::OneHour);
    type_settings(&world, "4321");
    let view = world
        .until(|v| v.passcode.entry.shake == 1, "the shake")
        .await;
    assert_eq!(view.passcode.step, PasscodeStep::Verify);
    assert_eq!(view.passcode.auto_lock, AutoLock::OneMinute);
    assert!(view.lock.enabled);

    type_settings(&world, "1234");
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::On, "the settings")
        .await;
    assert_eq!(view.passcode.auto_lock_choices.len(), 5);
    assert_eq!(view.passcode.auto_lock_label, "After 1 minute");

    world.engine.set_auto_lock(AutoLock::FiveMinutes);
    world
        .until(|v| v.passcode.auto_lock == AutoLock::FiveMinutes, "saved")
        .await;
    assert_eq!(
        saved(&world, SETTINGS).unwrap()["auto_lock"],
        "five_minutes"
    );

    world.engine.passcode_off();
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::Off, "off")
        .await;
    assert!(!view.lock.enabled);
    assert_eq!(view.notice.as_deref(), Some("Passcode off."));
    assert!(saved(&world, SETTINGS).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn biometric_unlock_is_turned_on_from_the_settings() {
    let world = unlocked_with(json!({})).await;
    world.engine.passcode_open();
    type_settings(&world, "1234");
    let view = world
        .until(|v| v.passcode.step == PasscodeStep::On, "the settings")
        .await;
    assert_eq!(view.passcode.biometric_label, None, "no hardware said yet");

    world.engine.set_biometric_unlock(true);
    world
        .engine
        .set_biometric_capability(BiometricKind::Face, "Face ID".into(), Some("e7".into()));
    world
        .until(|v| v.passcode.biometric_label.is_some(), "the hardware")
        .await;
    world.engine.set_biometric_unlock(true);
    let view = world.until(|v| v.passcode.biometric_on, "on").await;
    assert_eq!(view.lock.biometric_label.as_deref(), Some("Face ID"));
    let settings = saved(&world, SETTINGS).unwrap();
    assert_eq!(settings["biometric"], true);
    assert_eq!(settings["biometric_enrollment"], "e7");
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_the_passcode_keeps_the_other_settings() {
    let world = unlocked_with(json!({"auto_lock": "one_hour"})).await;
    world.engine.passcode_open();
    type_settings(&world, "1234");
    world
        .until(|v| v.passcode.step == PasscodeStep::On, "the settings")
        .await;
    world.engine.passcode_start(PasscodeKind::Password);
    world.engine.passcode_submit("opensesame".into());
    world
        .until(|v| v.passcode.step == PasscodeStep::Confirm, "again")
        .await;
    world.engine.passcode_submit("opensesame".into());
    let view = world
        .until(
            |v| v.notice.as_deref() == Some("Passcode changed."),
            "changed",
        )
        .await;
    assert_eq!(view.passcode.step, PasscodeStep::On);
    assert_eq!(view.lock.entry.kind, PasscodeKind::Password);
    let settings = saved(&world, SETTINGS).unwrap();
    assert_eq!(settings["kind"], "password");
    assert_eq!(settings["auto_lock"], "one_hour");
}
