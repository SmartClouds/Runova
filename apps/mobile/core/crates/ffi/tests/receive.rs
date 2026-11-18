//! Files sent to the phone (E114): going online to take them, the question on screen, the trip
//! over the relay from a computer that sends as the desktop does, and every way it can end.

mod common;

use common::{ToPhone, World, signed_in};
use runova_ffi::engine::AppLifecycle;
use runova_ffi::view::{AppView, ReceivePhase, SendFileState};
use runova_protocol::send::{AnswerReason, SendFile};
use runova_transfer::sender::{SendOutcome, SendPlan};
use runova_transfer::source::PathOpener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "runova-ffi-receive-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bytes(size: usize, seed: u8) -> Vec<u8> {
    (0..size)
        .map(|i| (i as u8).wrapping_mul(17).wrapping_add(seed))
        .collect()
}

/// Sam's desk sends `files` (offered path, file on disk) as one batch.
fn send_of(files: &[(&str, PathBuf)], note: Option<&str>) -> ToPhone {
    let mut sources = PathOpener::default();
    let files = files
        .iter()
        .enumerate()
        .map(|(i, (path, source))| {
            let transfer_id = format!("f{i}");
            sources.add(&transfer_id, source.clone());
            SendFile {
                transfer_id,
                path: (*path).to_owned(),
                size: std::fs::metadata(source).unwrap().len(),
            }
        })
        .collect();
    ToPhone {
        plan: SendPlan {
            batch_id: "batch-7".into(),
            files,
            note: note.map(str::to_owned),
            part_bytes: 64 * 1024,
        },
        sources,
        cut_after: None,
    }
}

/// A signed-in phone that knows where to save, and is online to take files.
async fn ready(inbox: &Folder) -> World {
    let world = signed_in().await;
    world.engine.set_receive_folder(inbox.path());
    world
        .until(
            |_| !world.computer.went_online.lock().unwrap().is_empty(),
            "online",
        )
        .await;
    world
}

fn first(view: &AppView) -> Option<&runova_ffi::view::ReceivedBatchView> {
    view.receive.batches.first()
}

async fn until_phase(world: &World, phase: ReceivePhase) -> AppView {
    world
        .until(
            |v| first(v).is_some_and(|b| b.phase == phase),
            &format!("{phase:?}"),
        )
        .await
}

async fn until_outcome(world: &World) -> SendOutcome {
    for _ in 0..800 {
        if let Some(outcome) = world
            .computer
            .phone_outcomes
            .lock()
            .unwrap()
            .first()
            .cloned()
        {
            return outcome;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the computer's send never ended");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_goes_online_to_take_files_once_it_knows_where_to_put_them() {
    let world = signed_in().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(world.computer.went_online.lock().unwrap().is_empty());

    let inbox = Folder::new("inbox");
    world.engine.set_receive_folder(inbox.path());

    world
        .until(
            |_| !world.computer.went_online.lock().unwrap().is_empty(),
            "online",
        )
        .await;
    assert_eq!(
        world.computer.went_online.lock().unwrap()[0],
        (77, vec!["receive-files".to_owned()])
    );
    let view = world.latest().unwrap();
    assert!(view.receive.enabled);
    assert!(view.receive.ready);
}

#[tokio::test(flavor = "multi_thread")]
async fn files_from_my_computer_wait_for_a_yes_then_land_checked() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    let picked = Folder::new("pick");
    let photo = bytes(150_000, 3);
    let send = send_of(
        &[
            ("Holiday/beach.jpg", picked.write("beach.jpg", &photo)),
            ("notes.txt", picked.write("notes.txt", b"pack sunscreen")),
        ],
        Some("From the trip"),
    );

    world.computer.ask_phone("s9", "send", Some(send));

    let view = world
        .until(|v| !v.receive.offers.is_empty(), "the question")
        .await;
    let offer = &view.receive.offers[0];
    assert_eq!(offer.title, "Sam's desk wants to send you 2 files");
    assert_eq!(offer.note.as_deref(), Some("From the trip"));
    assert_eq!(offer.files[0].name, "beach.jpg");
    assert_eq!(offer.files[0].folder.as_deref(), Some("Holiday"));
    assert_eq!(
        world.computer.responses.lock().unwrap()[0],
        ("s9".to_owned(), true)
    );

    world.engine.answer_offer(offer.id.clone(), true);

    let view = until_phase(&world, ReceivePhase::Done).await;
    let batch = first(&view).unwrap();
    assert_eq!(batch.title, "From Sam's desk");
    assert!(
        batch.status.starts_with("Received 2 files, "),
        "{}",
        batch.status
    );
    assert!(view.receive.offers.is_empty());
    assert!(batch.files.iter().all(|f| f.state == SendFileState::Done));
    let saved = batch.files[0].path.clone().unwrap();
    assert_eq!(std::fs::read(&saved).unwrap(), photo);
    assert_eq!(
        std::fs::read(inbox.0.join("notes.txt")).unwrap(),
        b"pack sunscreen"
    );
    assert_eq!(until_outcome(&world).await, SendOutcome::Done { failed: 0 });
    world
        .until(
            |_| {
                world
                    .computer
                    .ended
                    .lock()
                    .unwrap()
                    .contains(&"s9".to_owned())
            },
            "ended",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn saying_no_turns_the_files_away() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    let picked = Folder::new("pick");
    world.computer.ask_phone(
        "s9",
        "send",
        Some(send_of(&[("a.txt", picked.write("a.txt", b"hi"))], None)),
    );
    let view = world
        .until(|v| !v.receive.offers.is_empty(), "the question")
        .await;

    world
        .engine
        .answer_offer(view.receive.offers[0].id.clone(), false);

    assert_eq!(
        until_outcome(&world).await,
        SendOutcome::Declined(Some(AnswerReason::Declined))
    );
    let view = until_phase(&world, ReceivePhase::Declined).await;
    assert_eq!(first(&view).unwrap().status, "You declined it.");
    assert!(!inbox.0.join("a.txt").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn files_from_my_own_computers_can_come_straight_in() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    world.engine.set_receive_auto_accept(true);
    world
        .until(|v| v.receive.auto_accept, "auto accept on")
        .await;
    let picked = Folder::new("pick");

    world.computer.ask_phone(
        "s9",
        "send",
        Some(send_of(&[("a.txt", picked.write("a.txt", b"hi"))], None)),
    );

    until_phase(&world, ReceivePhase::Done).await;
    assert_eq!(std::fs::read(inbox.0.join("a.txt")).unwrap(), b"hi");
    assert!(
        world
            .views
            .0
            .lock()
            .unwrap()
            .iter()
            .all(|v| v.receive.offers.is_empty())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_that_takes_no_files_says_no_before_anything_opens() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    world.engine.set_receive_enabled(false);
    world.until(|v| !v.receive.enabled, "off").await;

    world.computer.ask_phone("s9", "send", None);

    world
        .until(
            |_| !world.computer.responses.lock().unwrap().is_empty(),
            "the answer",
        )
        .await;
    assert_eq!(
        world.computer.responses.lock().unwrap()[0],
        ("s9".to_owned(), false)
    );
    assert!(world.latest().unwrap().receive.batches.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_send_is_taken() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;

    world.computer.ask_phone("s9", "control", None);

    world
        .until(
            |_| !world.computer.responses.lock().unwrap().is_empty(),
            "the answer",
        )
        .await;
    assert_eq!(
        world.computer.responses.lock().unwrap()[0],
        ("s9".to_owned(), false)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_send_picks_up_on_the_next_link_without_asking_again() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    let picked = Folder::new("pick");
    let content = bytes(600_000, 5);
    let source = picked.write("big.bin", &content);
    let mut first_try = send_of(&[("big.bin", source.clone())], None);
    first_try.cut_after = Some(20);
    world.computer.ask_phone("s9", "send", Some(first_try));
    let view = world
        .until(|v| !v.receive.offers.is_empty(), "the question")
        .await;
    world
        .engine
        .answer_offer(view.receive.offers[0].id.clone(), true);
    until_phase(&world, ReceivePhase::Reconnecting).await;
    let asked = world
        .views
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|v| !v.receive.offers.is_empty())
        .count();

    world.computer.phone_outcomes.lock().unwrap().clear();
    world
        .computer
        .ask_phone("s10", "send", Some(send_of(&[("big.bin", source)], None)));

    let view = until_phase(&world, ReceivePhase::Done).await;
    assert_eq!(view.receive.batches.len(), 1);
    assert_eq!(std::fs::read(inbox.0.join("big.bin")).unwrap(), content);
    assert!(!inbox.0.join("big (1).bin").exists());
    // Asked once, on the first link only.
    let asked_after = world
        .views
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|v| !v.receive.offers.is_empty())
        .count();
    assert_eq!(asked, asked_after);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hub_stays_while_files_come_in_the_background() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    let picked = Folder::new("pick");
    world.computer.ask_phone(
        "s9",
        "send",
        Some(send_of(&[("a.txt", picked.write("a.txt", b"hi"))], None)),
    );
    let view = world
        .until(|v| !v.receive.offers.is_empty(), "the question")
        .await;

    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 0 });
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(world.latest().unwrap().hub_connected);

    world
        .engine
        .answer_offer(view.receive.offers[0].id.clone(), false);
    world.until(|v| !v.hub_connected, "the hub let go").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn finished_files_can_be_put_away() {
    let inbox = Folder::new("inbox");
    let world = ready(&inbox).await;
    world.engine.set_receive_auto_accept(true);
    let picked = Folder::new("pick");
    world.computer.ask_phone(
        "s9",
        "send",
        Some(send_of(&[("a.txt", picked.write("a.txt", b"hi"))], None)),
    );
    let view = until_phase(&world, ReceivePhase::Done).await;

    world
        .engine
        .dismiss_received(first(&view).unwrap().id.clone());

    world
        .until(|v| v.receive.batches.is_empty(), "put away")
        .await;
    // The file itself stays where it was saved.
    assert!(inbox.0.join("a.txt").exists());
}
