//! Sending files from the phone to a computer (E113): which computers can take them, the whole
//! trip over a real secure link to a computer that receives as the desktop does, and every way a
//! send can end.

mod common;

use common::{World, connected, signed_in};
use runova_ffi::backend::SystemEntry;
use runova_ffi::engine::AppLifecycle;
use runova_ffi::send::{
    PickedFile, PickedFiles, file_size_label, files_summary, send_button_label,
};
use runova_ffi::view::{AppView, ConnectionPhase, SendBatchView, SendFileState, SendPhase};
use runova_protocol::send::SendMessage;
use runova_session::hub::{AccessMode, HubEvent, Intent};
use runova_transfer::receiver::ReceiveOutcome;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "runova-ffi-send-{name}-{}-{}",
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

    fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = walk(&self.0)
            .into_iter()
            .map(|p| {
                p.strip_prefix(&self.0)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        names.sort();
        names
    }
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bytes(size: usize, seed: u8) -> Vec<u8> {
    (0..size)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

/// The files a person picked, read the way the phone's own pickers hand them over.
#[derive(Default)]
struct Picked {
    paths: HashMap<String, PathBuf>,
    gone: HashSet<String>,
    closed: Mutex<Vec<String>>,
}

impl PickedFiles for Picked {
    fn read(&self, handle: String, offset: u64, length: u32) -> Option<Vec<u8>> {
        if self.gone.contains(&handle) {
            return None;
        }
        let mut file = std::fs::File::open(self.paths.get(&handle)?).ok()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut buffer = Vec::with_capacity(length as usize);
        file.take(u64::from(length)).read_to_end(&mut buffer).ok()?;
        Some(buffer)
    }

    fn close(&self, handle: String) {
        self.closed.lock().unwrap().push(handle);
    }
}

/// Picks `files` as `(handle, offered path, file on disk)`.
fn pick(files: &[(&str, &str, PathBuf)]) -> (Arc<Picked>, Vec<PickedFile>) {
    let mut picked = Picked::default();
    let picks = files
        .iter()
        .map(|(handle, path, source)| {
            picked.paths.insert((*handle).to_owned(), source.clone());
            PickedFile {
                handle: (*handle).to_owned(),
                path: (*path).to_owned(),
                size: std::fs::metadata(source).unwrap().len(),
            }
        })
        .collect();
    (Arc::new(picked), picks)
}

fn first(view: &AppView) -> Option<&SendBatchView> {
    view.send.batches.first()
}

async fn until_phase(world: &World, phase: SendPhase) -> AppView {
    world
        .until(
            |v| first(v).is_some_and(|b| b.phase == phase),
            &format!("{phase:?}"),
        )
        .await
}

fn computer(id: i64, name: &str) -> SystemEntry {
    SystemEntry {
        id,
        remote_id: format!("{id}00000000"),
        name: name.into(),
        platform: "windows".into(),
        kind: "app".into(),
        online: true,
        own: false,
        unattended: false,
        features: Some(vec!["receive-files".into()]),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_takes_files_is_a_place_to_send_them() {
    let world = signed_in().await;

    let view = world
        .until(|v| !v.send.targets.is_empty(), "the targets")
        .await;

    let desk = &view.send.targets[0];
    assert_eq!(desk.system_id, 5);
    assert_eq!(desk.name, "Sam's desk");
    assert!(desk.own);
    assert!(desk.can_receive);
    assert_eq!(desk.reason, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_computer_that_can_not_take_files_says_why() {
    let world = signed_in().await;
    let mut offline = computer(6, "Office PC");
    offline.online = false;
    let mut agent = computer(7, "Build box");
    agent.kind = "agent".into();
    let mut older = computer(8, "Old laptop");
    older.features = Some(Vec::new());
    let mut old_site = computer(9, "Lab PC");
    old_site.features = None;
    world
        .backend
        .extra
        .lock()
        .unwrap()
        .extend([offline, agent, older, old_site]);

    world.engine.refresh();
    let view = world
        .until(|v| v.send.targets.len() == 5, "five targets")
        .await;

    let reason = |id: i64| {
        let target = view
            .send
            .targets
            .iter()
            .find(|t| t.system_id == id)
            .unwrap();
        assert!(!target.can_receive);
        target.reason.clone().unwrap()
    };
    assert_eq!(reason(6), "Offline");
    assert_eq!(reason(7), "Open Runova on Build box to send it files");
    assert_eq!(reason(8), "Needs a newer Runova");
    assert_eq!(reason(9), "The Runova website needs an update for this");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_stops_taking_files_is_marked_at_once() {
    let world = signed_in().await;
    world
        .until(
            |v| v.send.targets.first().is_some_and(|t| t.can_receive),
            "a target",
        )
        .await;
    let events = world.computer.hub_events.lock().unwrap().clone().unwrap();

    events
        .send(HubEvent::Presence {
            device_id: 5,
            online: true,
            features: Some(Vec::new()),
        })
        .await
        .unwrap();

    let view = world
        .until(
            |v| v.send.targets.first().is_some_and(|t| !t.can_receive),
            "outdated",
        )
        .await;
    assert_eq!(
        view.send.targets[0].reason.as_deref(),
        Some("Needs a newer Runova")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn files_picked_on_the_phone_land_on_the_computer_checked() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    let picked = Folder::new("pick");
    let report = bytes(150_000, 1);
    let beach = bytes(70_000, 2);
    let (files, picks) = pick(&[
        ("h1", "report.pdf", picked.write("report.pdf", &report)),
        ("h2", "Holiday/beach.jpg", picked.write("beach.jpg", &beach)),
    ]);

    world
        .engine
        .send_files(5, picks, Some("For the trip".into()), files.clone());

    let view = until_phase(&world, SendPhase::Done).await;
    let batch = first(&view).unwrap();
    assert_eq!(batch.title, "To Sam's desk");
    assert!(
        batch.status.starts_with("Sent 2 files, "),
        "{}",
        batch.status
    );
    assert!(batch.status.ends_with(", verified"), "{}", batch.status);
    assert_eq!(batch.percent, 100);
    assert!(batch.files.iter().all(|f| f.state == SendFileState::Done));
    assert!(batch.can_dismiss);
    assert!(!batch.can_cancel);
    assert_eq!(std::fs::read(inbox.0.join("report.pdf")).unwrap(), report);
    assert_eq!(
        std::fs::read(inbox.0.join("Holiday/beach.jpg")).unwrap(),
        beach
    );
    assert!(
        world
            .computer
            .intents
            .lock()
            .unwrap()
            .contains(&(Intent::Send, AccessMode::Ask))
    );
    assert!(matches!(
        &world.computer.offers.lock().unwrap()[0],
        SendMessage::SendOffer { note: Some(note), .. } if note == "For the trip"
    ));
    // The session is ended on the hub, and every file the phone opened is let go.
    world
        .until(
            |_| !world.computer.ended.lock().unwrap().is_empty(),
            "ended",
        )
        .await;
    let mut closed = files.closed.lock().unwrap().clone();
    closed.sort();
    closed.dedup();
    assert_eq!(closed, ["h1", "h2"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_picks_with_one_name_both_arrive() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[
        ("h1", "IMG_1.jpg", picked.write("a.jpg", b"first")),
        ("h2", "img_1.jpg", picked.write("b.jpg", b"second")),
    ]);

    world.engine.send_files(5, picks, None, files);

    until_phase(&world, SendPhase::Done).await;
    assert_eq!(inbox.names(), ["IMG_1.jpg", "img_1 (1).jpg"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_goes_beside_a_connection_and_leaves_it_be() {
    let world = connected().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "a.txt", picked.write("a.txt", b"hello"))]);

    world.engine.send_files(5, picks, None, files);

    let view = until_phase(&world, SendPhase::Done).await;
    assert_eq!(
        view.connection.as_ref().map(|c| c.phase),
        Some(ConnectionPhase::Connected)
    );
    assert_eq!(std::fs::read(inbox.0.join("a.txt")).unwrap(), b"hello");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_keeps_going_when_the_connection_to_its_computer_ends() {
    let world = connected().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    let content = bytes(5 * 1024 * 1024, 9);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "big.bin", picked.write("big.bin", &content))]);

    // The disconnect is queued right behind the send, so it lands while the send is dialing.
    world.engine.send_files(5, picks, None, files);
    world.engine.disconnect();

    let view = until_phase(&world, SendPhase::Done).await;
    assert!(view.connection.is_none());
    assert_eq!(std::fs::read(inbox.0.join("big.bin")).unwrap(), content);
}

#[tokio::test(flavor = "multi_thread")]
async fn files_declined_at_the_computer_say_so() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    world.computer.declines_files.store(true, Ordering::SeqCst);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "a.txt", picked.write("a.txt", b"hello"))]);

    world.engine.send_files(5, picks, None, files);

    let view = until_phase(&world, SendPhase::Declined).await;
    let batch = first(&view).unwrap();
    assert_eq!(batch.status, "Declined on Sam's desk");
    assert!(batch.can_retry);
    assert!(inbox.names().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_not_taking_files_says_so_and_sending_again_goes_through() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    world.computer.declines.store(true, Ordering::SeqCst);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "a.txt", picked.write("a.txt", b"hello"))]);
    world.engine.send_files(5, picks, None, files);
    let view = until_phase(&world, SendPhase::Declined).await;
    let batch = first(&view).unwrap().clone();
    assert_eq!(batch.status, "Sam's desk isn't taking files right now");

    world.computer.declines.store(false, Ordering::SeqCst);
    world.engine.retry_send(batch.batch_id.clone());

    let view = until_phase(&world, SendPhase::Done).await;
    assert_eq!(first(&view).unwrap().batch_id, batch.batch_id);
    assert_eq!(std::fs::read(inbox.0.join("a.txt")).unwrap(), b"hello");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_link_picks_up_where_it_stopped_and_lands_once() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    // Three parts of 4 MiB; the link goes a few frames into the second.
    let content = bytes(9 * 1024 * 1024, 7);
    *world.computer.cut_after_frames.lock().unwrap() = Some(70);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "big.bin", picked.write("big.bin", &content))]);

    world.engine.send_files(5, picks, None, files);

    until_phase(&world, SendPhase::Done).await;
    let phases: Vec<SendPhase> = world
        .views
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|v| first(v).map(|b| b.phase))
        .collect();
    assert!(phases.contains(&SendPhase::Reconnecting));
    assert_eq!(
        *world.computer.send_outcomes.lock().unwrap(),
        [ReceiveOutcome::Dropped, ReceiveOutcome::Done]
    );
    assert_eq!(inbox.names(), ["big.bin"]);
    assert_eq!(std::fs::read(inbox.0.join("big.bin")).unwrap(), content);
    // The first part arrived once: 71 frames on the first link, then only the second part (64
    // frames) and the last one (1 MiB, 16 frames) on the next.
    assert_eq!(
        world.computer.chunk_frames.load(Ordering::SeqCst),
        71 + 64 + 16
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_while_the_computer_rings_ends_the_request() {
    let world = signed_in().await;
    world.computer.keeps_ringing.store(true, Ordering::SeqCst);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "a.txt", picked.write("a.txt", b"hello"))]);
    world.engine.send_files(5, picks, None, files);
    let view = until_phase(&world, SendPhase::Connecting).await;
    let batch = first(&view).unwrap().clone();
    assert_eq!(batch.status, "Reaching Sam's desk…");
    assert!(batch.can_cancel);

    world.engine.cancel_send(batch.batch_id);

    let view = until_phase(&world, SendPhase::Cancelled).await;
    assert_eq!(first(&view).unwrap().status, "You cancelled it.");
    world
        .until(
            |_| !world.computer.ended.lock().unwrap().is_empty(),
            "ended",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_that_can_not_be_read_fails_alone() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    let picked = Folder::new("pick");
    let (_, picks) = pick(&[
        ("h1", "gone.txt", picked.write("gone.txt", b"soon gone")),
        ("h2", "kept.txt", picked.write("kept.txt", b"kept")),
    ]);
    let mut files = Picked::default();
    files.paths.insert("h2".into(), picked.0.join("kept.txt"));
    files.gone.insert("h1".into());

    world.engine.send_files(5, picks, None, Arc::new(files));

    let view = until_phase(&world, SendPhase::Done).await;
    let batch = first(&view).unwrap();
    assert_eq!(batch.status, "Sent 1 of 2 files, 1 failed");
    assert_eq!(batch.files[0].state, SendFileState::Failed);
    assert_eq!(
        batch.files[0].error.as_deref(),
        Some("It could not be read.")
    );
    assert_eq!(inbox.names(), ["kept.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hub_stays_while_a_send_is_going_in_the_background() {
    let world = signed_in().await;
    world.computer.keeps_ringing.store(true, Ordering::SeqCst);
    let picked = Folder::new("pick");
    let (files, picks) = pick(&[("h1", "a.txt", picked.write("a.txt", b"hello"))]);
    world.engine.send_files(5, picks, None, files);
    let view = until_phase(&world, SendPhase::Connecting).await;

    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 0 });
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(world.latest().unwrap().hub_connected);

    world
        .engine
        .cancel_send(first(&view).unwrap().batch_id.clone());
    world.until(|v| !v.hub_connected, "the hub let go").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn finished_sends_can_be_put_away() {
    let world = signed_in().await;
    let inbox = Folder::new("inbox");
    world.computer.save_to(&inbox.0);
    world.computer.declines_files.store(true, Ordering::SeqCst);
    let picked = Folder::new("pick");
    for name in ["a.txt", "b.txt"] {
        let (files, picks) = pick(&[("h", name, picked.write(name, b"x"))]);
        world.engine.send_files(5, picks, None, files);
        world
            .until(
                |v| {
                    first(v)
                        .is_some_and(|b| b.phase == SendPhase::Declined && b.files[0].name == name)
                },
                name,
            )
            .await;
    }
    let view = world.latest().unwrap();
    assert_eq!(view.send.batches.len(), 2);

    world
        .engine
        .dismiss_send(view.send.batches[0].batch_id.clone());
    world.until(|v| v.send.batches.len() == 1, "one left").await;
    world.engine.clear_finished_sends();
    world
        .until(|v| v.send.batches.is_empty(), "none left")
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn too_many_files_at_once_are_turned_down_before_anything_goes() {
    let world = signed_in().await;
    let picks = (0..10_001)
        .map(|i| PickedFile {
            handle: format!("h{i}"),
            path: format!("f{i}.txt"),
            size: 1,
        })
        .collect();

    world
        .engine
        .send_files(5, picks, None, Arc::new(Picked::default()));

    let view = world.until(|v| v.send.error.is_some(), "the error").await;
    assert_eq!(
        view.send.error.as_deref(),
        Some("You can send up to 10,000 files at a time.")
    );
    assert!(view.send.batches.is_empty());
    assert!(world.computer.intents.lock().unwrap().is_empty());
}

#[test]
fn what_is_picked_is_summed_up_as_the_desktop_says_it() {
    assert_eq!(file_size_label(5), "5 B");
    assert_eq!(file_size_label(1536), "1.5 KB");
    assert_eq!(files_summary(1, 2048), "1 file, 2 KB");
    assert_eq!(files_summary(12_345, 3 * 1024 * 1024), "12,345 files, 3 MB");
    assert_eq!(send_button_label(0, Some("Sam's desk".into())), "Send");
    assert_eq!(send_button_label(1, None), "Send 1 file");
    assert_eq!(
        send_button_label(3, Some("Sam's desk".into())),
        "Send 3 files to Sam's desk"
    );
}
