//! A sender and a receiver over a real secure link, both ways a send can go and every way it can
//! end, as the phone and the desktop speak it (E112, E113).

use runova_crypto::handshake::{Identity, Mode, os_random};
use runova_link::secure::{ControllerConfig, HostConfig, LinkEvent, SecureLink};
use runova_link::testing::memory_pair;
use runova_protocol::file::{FileMessage, decode_chunk, transfer_key};
use runova_protocol::send::{AnswerReason, SendFile, SendMessage, parse_send_message};
use runova_transfer::receiver::{ReceiveOutcome, ReceiveState, receive_batch, receive_batch_with};
use runova_transfer::sender::{SendOutcome, SendPlan, send_batch};
use runova_transfer::source::PathOpener;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(20);
const PART: u64 = 64 * 1024;

async fn linked() -> (SecureLink, SecureLink) {
    let (a, b) = memory_pair();
    let phone_key = Identity::from_seed([2; 32]).public_key();
    let desk_key = Identity::from_seed([1; 32]).public_key();
    let desk = tokio::spawn(async move {
        SecureLink::as_host(
            Box::new(b),
            HostConfig {
                session_id: "s".into(),
                mode: Mode::Ask,
                identity: Identity::from_seed([1; 32]),
                expected_controller_key: phone_key,
                password_secret: None,
                local_fingerprint: String::new(),
                remote_fingerprint: String::new(),
            },
            false,
            &mut os_random,
        )
        .await
        .unwrap()
    });
    let phone = SecureLink::as_controller(
        Box::new(a),
        ControllerConfig {
            session_id: "s".into(),
            mode: Mode::Ask,
            identity: Identity::from_seed([2; 32]),
            expected_host_key: desk_key,
            password_secret: None,
            local_fingerprint: String::new(),
            remote_fingerprint: String::new(),
        },
        false,
        &mut os_random,
    )
    .await
    .unwrap();
    (phone, desk.await.unwrap())
}

struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "runova-transfer-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }
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

/// A plan for the files at `picked`, offered under the names `paths`.
fn plan(picked: &[(&str, PathBuf)]) -> (SendPlan, PathOpener) {
    let mut opener = PathOpener::default();
    let files = picked
        .iter()
        .enumerate()
        .map(|(i, (path, source))| {
            let transfer_id = format!("file-{i}");
            opener.add(&transfer_id, source.clone());
            SendFile {
                transfer_id,
                path: (*path).to_owned(),
                size: std::fs::metadata(source).unwrap().len(),
            }
        })
        .collect();
    (
        SendPlan {
            batch_id: "batch-1".into(),
            files,
            note: Some("From the phone".into()),
            part_bytes: PART,
        },
        opener,
    )
}

/// The receiver's half, as a computer runs it: read the offer, then answer it.
async fn receive(
    mut link: SecureLink,
    folder: PathBuf,
    accept: bool,
    state: &mut ReceiveState,
) -> (ReceiveOutcome, SecureLink) {
    let offer = loop {
        match timeout(WAIT, link.next()).await.unwrap().unwrap() {
            LinkEvent::Text(text) => {
                if let Some(message @ SendMessage::SendOffer { .. }) = parse_send_message(&text) {
                    break message;
                }
            }
            LinkEvent::Binary(_) => {}
        }
    };
    let (never, stop) = watch::channel(false);
    let outcome = receive_batch(&mut link, &offer, &folder, accept, state, stop).await;
    drop(never);
    (outcome, link)
}

fn never() -> watch::Receiver<bool> {
    let (keep, stop) = watch::channel(false);
    std::mem::forget(keep);
    stop
}

#[tokio::test]
async fn a_folder_and_a_file_cross_and_check_out() {
    let picked = Folder::new("pick");
    let inbox = Folder::new("inbox");
    let report = picked.write("report.pdf", &bytes(150_000, 1));
    let beach = picked.write("Holiday/beach.jpg", &bytes(70_000, 2));
    let notes = picked.write("Holiday/notes.txt", b"beach day");
    let (plan, opener) = plan(&[
        ("report.pdf", report),
        ("Holiday/beach.jpg", beach),
        ("Holiday/notes.txt", notes),
    ]);
    let (mut phone, desk) = linked().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        receive(desk, inbox_path, true, &mut state).await.0
    });

    let mut finished = HashSet::new();
    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut finished,
        &move |event| seen.lock().unwrap().push(event),
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Done { failed: 0 });
    assert_eq!(
        timeout(WAIT, receiver).await.unwrap().unwrap(),
        ReceiveOutcome::Done
    );
    assert_eq!(
        std::fs::read(inbox.0.join("report.pdf")).unwrap(),
        bytes(150_000, 1)
    );
    assert_eq!(
        std::fs::read(inbox.0.join("Holiday/beach.jpg")).unwrap(),
        bytes(70_000, 2)
    );
    assert_eq!(
        std::fs::read(inbox.0.join("Holiday/notes.txt")).unwrap(),
        b"beach day"
    );
    assert_eq!(finished.len(), 3);
    assert!(!events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_decline_ends_it_and_says_so() {
    let picked = Folder::new("pick");
    let inbox = Folder::new("inbox");
    let file = picked.write("a.txt", b"hello");
    let (plan, opener) = plan(&[("a.txt", file)]);
    let (mut phone, desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        receive(desk, inbox_path, false, &mut state).await.0
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Declined(Some(AnswerReason::Declined)));
    assert_eq!(
        timeout(WAIT, receiver).await.unwrap().unwrap(),
        ReceiveOutcome::Declined
    );
    assert!(!inbox.0.join("a.txt").exists());
}

async fn hear(link: &mut SecureLink) -> LinkEvent {
    timeout(WAIT, link.next()).await.unwrap().unwrap()
}

async fn hear_text(link: &mut SecureLink) -> String {
    loop {
        if let LinkEvent::Text(text) = hear(link).await {
            if text.contains("send-ping") {
                continue;
            }
            return text;
        }
    }
}

async fn say(link: &mut SecureLink, value: &impl serde::Serialize) {
    link.send_text(&serde_json::to_string(value).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_part_that_arrives_wrong_is_sent_again() {
    let picked = Folder::new("pick");
    let content = bytes(1_000, 3);
    let file = picked.write("a.bin", &content);
    let (plan, opener) = plan(&[("a.bin", file)]);
    let (mut phone, mut desk) = linked().await;
    let script = tokio::spawn(async move {
        hear_text(&mut desk).await; // the offer
        say(
            &mut desk,
            &SendMessage::SendAnswer {
                batch_id: "batch-1".into(),
                accept: true,
                reason: None,
                resumed: None,
                finished: None,
            },
        )
        .await;
        hear_text(&mut desk).await; // the file offer
        say(
            &mut desk,
            &FileMessage::FileResume {
                transfer_id: "file-0".into(),
                missing_parts: vec![0],
            },
        )
        .await;
        let mut part_done = 0;
        loop {
            let LinkEvent::Text(text) = hear(&mut desk).await else {
                continue;
            };
            match FileMessage::parse(&text) {
                Some(FileMessage::FilePartDone { part_index, .. }) => {
                    part_done += 1;
                    say(
                        &mut desk,
                        &FileMessage::FilePartAck {
                            transfer_id: "file-0".into(),
                            part_index,
                            ok: part_done > 1,
                        },
                    )
                    .await;
                }
                Some(FileMessage::FileComplete { hash, .. }) => {
                    assert_eq!(hash, hex::encode(Sha256::digest(&content)));
                    say(
                        &mut desk,
                        &FileMessage::FileDone {
                            transfer_id: "file-0".into(),
                            saved_path: "/inbox/a.bin".into(),
                            verified: true,
                        },
                    )
                    .await;
                }
                _ if text.contains("send-complete") => return part_done,
                _ => {}
            }
        }
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Done { failed: 0 });
    assert_eq!(timeout(WAIT, script).await.unwrap().unwrap(), 2);
}

#[tokio::test]
async fn a_link_that_drops_in_the_middle_resumes_on_a_new_one_with_one_good_copy() {
    let picked = Folder::new("pick");
    let inbox = Folder::new("inbox");
    let content = bytes(5 * PART as usize + 100, 4);
    let file = picked.write("big.bin", &content);
    let small = picked.write("small.txt", b"small");
    let (plan, opener) = plan(&[("small.txt", small), ("big.bin", file)]);
    let mut finished = HashSet::new();

    // First link: the receiver stops reading a few frames into the big file and goes away.
    let (mut phone, mut desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let cut = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        let offer = loop {
            if let LinkEvent::Text(text) = hear(&mut desk).await
                && let Some(offer @ SendMessage::SendOffer { .. }) = parse_send_message(&text)
            {
                break offer;
            }
        };
        let big = transfer_key("file-1");
        let mut frames = 0;
        receive_batch_with(
            &mut desk,
            &offer,
            &inbox_path,
            true,
            &mut state,
            never(),
            |frame| {
                if decode_chunk(frame).is_some_and(|chunk| chunk.transfer_key == big) {
                    frames += 1;
                }
                frames < 3
            },
        )
        .await;
        desk.close().await;
        state
    });
    let first = send_batch(&mut phone, &plan, &opener, &mut finished, &|_| {}, never()).await;
    assert_eq!(first, SendOutcome::Dropped);
    let state = timeout(WAIT, cut).await.unwrap().unwrap();

    // Second link: the same batch again, from a sender that forgot what arrived. The receiver
    // knows the batch, says what it has, and asks only for the parts it lacks.
    assert!(finished.contains("file-0"));
    let mut forgot = HashSet::new();
    let (mut phone, desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = state;
        receive(desk, inbox_path, true, &mut state).await.0
    });
    let second = send_batch(&mut phone, &plan, &opener, &mut forgot, &|_| {}, never()).await;

    assert_eq!(second, SendOutcome::Done { failed: 0 });
    assert_eq!(forgot.len(), 2);
    assert_eq!(
        timeout(WAIT, receiver).await.unwrap().unwrap(),
        ReceiveOutcome::Done
    );
    assert_eq!(std::fs::read(inbox.0.join("big.bin")).unwrap(), content);
    assert_eq!(std::fs::read(inbox.0.join("small.txt")).unwrap(), b"small");
    let mut names: Vec<_> = std::fs::read_dir(&inbox.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec!["big.bin", "small.txt"]);
}

#[tokio::test(start_paused = true)]
async fn a_link_that_goes_silent_counts_as_dropped() {
    let picked = Folder::new("pick");
    let file = picked.write("a.txt", b"hello");
    let (plan, opener) = plan(&[("a.txt", file)]);
    let (mut phone, mut desk) = linked().await;
    let silent = tokio::spawn(async move {
        hear_text(&mut desk).await;
        say(
            &mut desk,
            &SendMessage::SendAnswer {
                batch_id: "batch-1".into(),
                accept: true,
                reason: None,
                resumed: None,
                finished: None,
            },
        )
        .await;
        // Then nothing at all, as a dead network does: no answer and no ping.
        tokio::time::sleep(Duration::from_secs(600)).await;
        desk
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Dropped);
    silent.abort();
}

#[tokio::test]
async fn cancelling_stops_it_and_tells_the_other_side() {
    let picked = Folder::new("pick");
    let inbox = Folder::new("inbox");
    let file = picked.write("a.txt", b"hello");
    let (plan, opener) = plan(&[("a.txt", file)]);
    let (mut phone, mut desk) = linked().await;
    let (cancel, stop) = watch::channel(false);
    let receiver = tokio::spawn(async move {
        let text = hear_text(&mut desk).await;
        assert!(text.contains("send-offer"));
        cancel.send(true).unwrap();
        let next = hear_text(&mut desk).await;
        let _ = inbox;
        next
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        stop,
    )
    .await;

    assert_eq!(outcome, SendOutcome::Cancelled);
    let said = timeout(WAIT, receiver).await.unwrap().unwrap();
    assert!(matches!(
        parse_send_message(&said),
        Some(SendMessage::SendCancel { .. })
    ));
}

#[tokio::test]
async fn the_sender_takes_no_files_from_the_other_side() {
    let picked = Folder::new("pick");
    let file = picked.write("a.txt", b"hello");
    let (plan, opener) = plan(&[("a.txt", file)]);
    let (mut phone, mut desk) = linked().await;
    let script = tokio::spawn(async move {
        hear_text(&mut desk).await;
        say(
            &mut desk,
            &FileMessage::FileOffer {
                transfer_id: "sneaky".into(),
                name: "payload.exe".into(),
                size: 4,
                part_size: 4,
                part_count: 1,
                dest_dir: None,
            },
        )
        .await;
        let refused = hear_text(&mut desk).await;
        say(
            &mut desk,
            &SendMessage::SendAnswer {
                batch_id: "batch-1".into(),
                accept: false,
                reason: Some(AnswerReason::Busy),
                resumed: None,
                finished: None,
            },
        )
        .await;
        refused
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Declined(Some(AnswerReason::Busy)));
    let refused = timeout(WAIT, script).await.unwrap().unwrap();
    assert!(matches!(
        FileMessage::parse(&refused),
        Some(FileMessage::FileError { transfer_id, .. }) if transfer_id == "sneaky"
    ));
}

#[tokio::test]
async fn a_file_that_can_not_be_read_fails_and_the_rest_still_go() {
    let picked = Folder::new("pick");
    let inbox = Folder::new("inbox");
    let gone = picked.write("gone.txt", b"soon gone");
    let kept = picked.write("kept.txt", b"kept");
    let (plan, opener) = plan(&[("gone.txt", gone.clone()), ("kept.txt", kept)]);
    std::fs::remove_file(gone).unwrap();
    let (mut phone, desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        receive(desk, inbox_path, true, &mut state).await.0
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Done { failed: 1 });
    assert_eq!(
        timeout(WAIT, receiver).await.unwrap().unwrap(),
        ReceiveOutcome::Done
    );
    assert_eq!(std::fs::read(inbox.0.join("kept.txt")).unwrap(), b"kept");
    assert!(!inbox.0.join("gone.txt").exists());
}

#[tokio::test]
async fn the_receiver_turns_away_a_file_not_in_the_list() {
    let inbox = Folder::new("inbox");
    let (mut phone, desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        receive(desk, inbox_path, true, &mut state).await
    });
    say(
        &mut phone,
        &SendMessage::SendOffer {
            v: 1,
            batch_id: "batch-1".into(),
            files: vec![SendFile {
                transfer_id: "listed".into(),
                path: "a.txt".into(),
                size: 1,
            }],
            note: None,
        },
    )
    .await;
    hear_text(&mut phone).await; // the answer

    say(
        &mut phone,
        &FileMessage::FileOffer {
            transfer_id: "smuggled".into(),
            name: "evil.exe".into(),
            size: 4,
            part_size: PART,
            part_count: 1,
            dest_dir: None,
        },
    )
    .await;
    let refused = hear_text(&mut phone).await;

    assert!(matches!(
        FileMessage::parse(&refused),
        Some(FileMessage::FileError { transfer_id, .. }) if transfer_id == "smuggled"
    ));
    say(
        &mut phone,
        &SendMessage::SendCancel {
            batch_id: "batch-1".into(),
            reason: None,
        },
    )
    .await;
    let (outcome, _) = timeout(WAIT, receiver).await.unwrap().unwrap();
    assert_eq!(outcome, ReceiveOutcome::Cancelled);
}

#[tokio::test]
async fn a_name_that_is_taken_gets_a_number_and_the_old_file_is_kept() {
    let picked = Folder::new("pick");
    let inbox = Folder::new("inbox");
    inbox.write("report.pdf", b"the old one");
    let file = picked.write("report.pdf", b"the new one");
    let (plan, opener) = plan(&[("report.pdf", file)]);
    let (mut phone, desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        let outcome = receive(desk, inbox_path, true, &mut state).await.0;
        (outcome, state)
    });

    let outcome = send_batch(
        &mut phone,
        &plan,
        &opener,
        &mut HashSet::new(),
        &|_| {},
        never(),
    )
    .await;

    assert_eq!(outcome, SendOutcome::Done { failed: 0 });
    let (_, state) = timeout(WAIT, receiver).await.unwrap().unwrap();
    assert_eq!(
        std::fs::read(inbox.0.join("report.pdf")).unwrap(),
        b"the old one"
    );
    assert_eq!(
        std::fs::read(inbox.0.join("report (1).pdf")).unwrap(),
        b"the new one"
    );
    assert_eq!(state.saved()["file-0"], inbox.0.join("report (1).pdf"));
}

/// The phone's side of a hand-written exchange with the receiver: the offer of one file, accepted.
async fn offer_one(phone: &mut SecureLink, size: u64) {
    say(
        phone,
        &SendMessage::SendOffer {
            v: 1,
            batch_id: "batch-1".into(),
            files: vec![SendFile {
                transfer_id: "t".into(),
                path: "a.txt".into(),
                size,
            }],
            note: None,
        },
    )
    .await;
    let answer = hear_text(phone).await;
    assert!(matches!(
        parse_send_message(&answer),
        Some(SendMessage::SendAnswer { accept: true, .. })
    ));
}

fn file_offer(size: u64, part_size: u64) -> FileMessage {
    FileMessage::FileOffer {
        transfer_id: "t".into(),
        name: "a.txt".into(),
        size,
        part_size,
        part_count: size.div_ceil(part_size).max(1),
        dest_dir: None,
    }
}

/// A receiver saving into `inbox`, and the phone's end of its link.
async fn receiving(inbox: &Folder) -> (SecureLink, tokio::task::JoinHandle<ReceiveOutcome>) {
    let (phone, desk) = linked().await;
    let inbox_path = inbox.0.clone();
    let receiver = tokio::spawn(async move {
        let mut state = ReceiveState::default();
        receive(desk, inbox_path, true, &mut state).await.0
    });
    (phone, receiver)
}

#[tokio::test]
async fn an_offer_that_does_not_match_the_list_is_turned_away() {
    let inbox = Folder::new("inbox");
    let (mut phone, receiver) = receiving(&inbox).await;
    offer_one(&mut phone, 5).await;

    for wrong in [
        file_offer(6, PART),
        file_offer(5, 1024),
        file_offer(5, 16 * 1024 * 1024),
    ] {
        say(&mut phone, &wrong).await;
        let refused = hear_text(&mut phone).await;

        assert!(
            matches!(
                FileMessage::parse(&refused),
                Some(FileMessage::FileError { .. })
            ),
            "should refuse {wrong:?}, got {refused}"
        );
    }
    say(
        &mut phone,
        &SendMessage::SendCancel {
            batch_id: "batch-1".into(),
            reason: None,
        },
    )
    .await;
    assert_eq!(
        timeout(WAIT, receiver).await.unwrap().unwrap(),
        ReceiveOutcome::Cancelled
    );
    assert!(!inbox.0.join(".runova-partial").exists());
}

#[tokio::test]
async fn a_chunk_out_of_turn_spoils_its_part() {
    let inbox = Folder::new("inbox");
    let (mut phone, receiver) = receiving(&inbox).await;
    offer_one(&mut phone, 5).await;
    say(&mut phone, &file_offer(5, PART)).await;
    let resume = hear_text(&mut phone).await;
    assert!(matches!(
        FileMessage::parse(&resume),
        Some(FileMessage::FileResume { .. })
    ));

    let frame = runova_protocol::file::encode_chunk(&runova_protocol::file::FileChunk {
        transfer_key: transfer_key("t"),
        part_index: 0,
        seq: 1,
        bytes: b"hello".to_vec(),
    });
    phone.send_binary(&frame).await.unwrap();
    say(
        &mut phone,
        &FileMessage::FilePartDone {
            transfer_id: "t".into(),
            part_index: 0,
            hash: hex::encode(Sha256::digest(b"hello")),
            size: 5,
        },
    )
    .await;
    let ack = hear_text(&mut phone).await;

    assert!(matches!(
        FileMessage::parse(&ack),
        Some(FileMessage::FilePartAck { ok: false, .. })
    ));
    say(
        &mut phone,
        &SendMessage::SendCancel {
            batch_id: "batch-1".into(),
            reason: None,
        },
    )
    .await;
    assert_eq!(
        timeout(WAIT, receiver).await.unwrap().unwrap(),
        ReceiveOutcome::Cancelled
    );
}
