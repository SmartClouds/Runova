//! Recovery phrases on the phone (E108): scanning the QR code a computer shows, keeping the phrase
//! in the secure store, showing it only after the phone's own check, and using it to unlock the
//! Vault on a computer.

mod common;

use common::{World, connected, signed_in};
use runova_ffi::secure::SecureStore;
use serde_json::{Value, json};

const PHRASE: &str = "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
const SYNC_CODE: &str = "RUNOVA-PHRASE:1:sync:UGVyc29uYWwgc3luYw:legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
const VAULT_CODE: &str = "RUNOVA-PHRASE:1:vault:VmF1bHQ6IHdvcmsgbGFwdG9wIOKckw:zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
const ZOO: &str = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";

fn index(world: &World) -> Vec<Value> {
    world
        .store
        .get("recovery-phrases".to_owned())
        .map(|json| serde_json::from_str(&json).expect("json"))
        .unwrap_or_default()
}

async fn scanned(world: &World, code: &str) {
    let before = world.latest().map_or(0, |v| v.recovery_phrases.items.len());
    world.engine.phrase_scan(code.to_owned());
    world
        .until(
            |v| v.recovery_phrases.items.len() > before,
            "the phrase in the list",
        )
        .await;
}

async fn revealed(world: &World, id: &str) {
    world.engine.phrase_reveal(id.to_owned());
    let view = world
        .until(|v| v.recovery_phrases.biometric.is_some(), "the check")
        .await;
    world
        .engine
        .biometric_result(view.recovery_phrases.biometric.unwrap().id, true);
    world
        .until(|v| v.recovery_phrases.revealed.is_some(), "the words")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scanned_code_is_kept_in_the_secure_store_and_listed_without_its_words() {
    let world = signed_in().await;

    scanned(&world, SYNC_CODE).await;

    let view = world.latest().unwrap();
    let item = &view.recovery_phrases.items[0];
    assert_eq!(item.label, "Personal sync");
    assert_eq!(item.opens, "Synced data");
    assert_eq!(
        view.recovery_phrases.notice.as_deref(),
        Some("Saved Personal sync.")
    );
    assert!(view.recovery_phrases.revealed.is_none());
    assert!(!format!("{view:?}").contains("sausage"));
    let stored = index(&world);
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].to_string().contains("sausage"));
    assert_eq!(
        world
            .store
            .get(format!("recovery-phrase.{}", item.id))
            .as_deref(),
        Some(PHRASE)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_code_of_just_the_words_gets_a_plain_name() {
    let world = signed_in().await;

    scanned(&world, &ZOO.to_uppercase()).await;

    let item = &world.latest().unwrap().recovery_phrases.items[0];
    assert_eq!(item.label, "Recovery phrase");
    assert_eq!(item.opens, "Not said");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_code_that_is_not_a_phrase_is_refused_and_one_already_kept_is_not_kept_twice() {
    let world = signed_in().await;

    world.engine.phrase_scan("https://example.com".to_owned());
    let view = world
        .until(|v| v.recovery_phrases.error.is_some(), "the refusal")
        .await;
    assert_eq!(
        view.recovery_phrases.error.as_deref(),
        Some("That isn't a recovery phrase.")
    );

    scanned(&world, SYNC_CODE).await;
    world.engine.phrase_scan(SYNC_CODE.to_owned());
    let view = world
        .until(
            |v| v.recovery_phrases.notice.as_deref() == Some("That phrase is already saved."),
            "the notice",
        )
        .await;
    assert_eq!(view.recovery_phrases.items.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_words_show_only_after_the_phones_own_check() {
    let world = signed_in().await;
    scanned(&world, SYNC_CODE).await;
    let id = world.latest().unwrap().recovery_phrases.items[0].id.clone();

    world.engine.phrase_reveal(id.clone());
    let view = world
        .until(|v| v.recovery_phrases.biometric.is_some(), "the check")
        .await;
    let check = view.recovery_phrases.biometric.unwrap();
    assert_eq!(check.reason, "Show the recovery phrase Personal sync");
    world.engine.biometric_result(check.id, false);
    let view = world
        .until(|v| v.recovery_phrases.biometric.is_none(), "the check gone")
        .await;
    assert!(view.recovery_phrases.revealed.is_none());

    revealed(&world, &id).await;
    let shown = world.latest().unwrap().recovery_phrases.revealed.unwrap();
    assert_eq!(shown.words.join(" "), PHRASE);
    assert_eq!(shown.qr_payload, SYNC_CODE);
    assert!(!format!("{shown:?}").contains("sausage"));

    world.engine.phrase_hide();
    world
        .until(|v| v.recovery_phrases.revealed.is_none(), "hidden")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_app_hides_the_words() {
    let world = signed_in().await;
    scanned(&world, SYNC_CODE).await;
    let id = world.latest().unwrap().recovery_phrases.items[0].id.clone();
    revealed(&world, &id).await;

    world
        .engine
        .lifecycle(runova_ffi::engine::AppLifecycle::Backgrounded { grace_ms: 60_000 });

    world
        .until(|v| v.recovery_phrases.revealed.is_none(), "hidden")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_asks_first_and_removes_the_phrase_from_the_store() {
    let world = signed_in().await;
    scanned(&world, SYNC_CODE).await;
    let id = world.latest().unwrap().recovery_phrases.items[0].id.clone();

    world.engine.phrase_delete(id.clone());
    let view = world
        .until(
            |v| v.recovery_phrases.confirm_delete.is_some(),
            "the question",
        )
        .await;
    assert_eq!(
        view.recovery_phrases.confirm_delete.as_deref(),
        Some(id.as_str())
    );
    world.engine.phrase_delete_answer(false);
    world
        .until(|v| v.recovery_phrases.confirm_delete.is_none(), "kept")
        .await;
    assert_eq!(index(&world).len(), 1);

    world.engine.phrase_delete(id.clone());
    world
        .until(
            |v| v.recovery_phrases.confirm_delete.is_some(),
            "the question",
        )
        .await;
    world.engine.phrase_delete_answer(true);
    world
        .until(|v| v.recovery_phrases.items.is_empty(), "gone")
        .await;
    assert!(index(&world).is_empty());
    assert!(world.store.get(format!("recovery-phrase.{id}")).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shown_vault_phrase_unlocks_the_vault_on_the_computer() {
    let world = connected().await;
    world.computer.answer("vault.unlock", json!({"ok": true}));
    world
        .computer
        .answer("vault.status", json!({"state": "unlocked"}));
    scanned(&world, VAULT_CODE).await;
    let item = world.latest().unwrap().recovery_phrases.items[0].clone();
    assert_eq!(item.label, "Vault: work laptop ✓");

    revealed(&world, &item.id).await;
    assert!(
        world
            .latest()
            .unwrap()
            .recovery_phrases
            .revealed
            .unwrap()
            .can_unlock_vault
    );
    world.engine.phrase_unlock_vault(item.id.clone());

    for _ in 0..400 {
        if !world.computer.params_of("vault.unlock").is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        world.computer.params_of("vault.unlock"),
        vec![Some(json!({"password": ZOO}))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_fully_forgets_every_phrase() {
    let world = signed_in().await;
    scanned(&world, SYNC_CODE).await;
    let id = world.latest().unwrap().recovery_phrases.items[0].id.clone();

    world.engine.sign_out();

    world
        .until(|v| v.recovery_phrases.items.is_empty(), "forgotten")
        .await;
    assert!(index(&world).is_empty());
    assert!(world.store.get(format!("recovery-phrase.{id}")).is_none());
}
