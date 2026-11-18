//! Receiving a batch: answer the offer, take each listed file in parts into a part file under the
//! chosen folder, check every part and the whole file, and only then move it into place. Anything
//! not in the list the person accepted is turned away.

use crate::wire::{Heard, Wire};
use runova_link::secure::SecureLink;
use runova_protocol::file::{FileMessage, decode_chunk, transfer_key};
use runova_protocol::send::{
    AnswerReason, MAX_PART_SIZE, MIN_PART_SIZE, SendFile, SendMessage, safe_relative_path,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

/// The folder part files wait in, inside the folder the files are saved to.
pub const PARTIAL_DIR: &str = ".runova-partial";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiveOutcome {
    /// The sender said it was done. What arrived is in [`ReceiveState::saved`].
    Done,
    Declined,
    /// The sender stopped it.
    Cancelled,
    /// The person here stopped it.
    Stopped,
    /// The link went; the sender may come back with the same batch.
    Dropped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiveEvent {
    Progress { transfer_id: String, received: u64 },
    Saved { transfer_id: String, path: PathBuf },
    Failed { transfer_id: String, reason: String },
    Skipped { transfer_id: String },
}

#[derive(Debug, Default, Clone)]
struct Kept {
    part_size: u64,
    part_count: u64,
    parts: BTreeSet<u64>,
}

/// What one batch has received so far, kept across the links it comes over.
#[derive(Debug, Default, Clone)]
pub struct ReceiveState {
    batch_id: Option<String>,
    saved: HashMap<String, PathBuf>,
    kept: HashMap<String, Kept>,
}

impl ReceiveState {
    /// Where each file that arrived intact was saved, by transfer id.
    pub fn saved(&self) -> &HashMap<String, PathBuf> {
        &self.saved
    }
}

/// The part of a file arriving now.
struct Current {
    index: u64,
    next_seq: u32,
    received: u64,
    hash: Sha256,
}

struct Open {
    file: File,
    part_path: PathBuf,
    size: u64,
    part_size: u64,
    current: Option<Current>,
}

struct Batch<'a> {
    folder: &'a Path,
    listed: HashMap<&'a str, &'a SendFile>,
    keys: HashMap<u32, &'a str>,
    open: HashMap<String, Open>,
    skipped: BTreeSet<String>,
}

/// Answers `offer` and, when `accept`, receives it into `folder`. `state` carries what an earlier
/// link of the same batch already received.
pub async fn receive_batch(
    link: &mut SecureLink,
    offer: &SendMessage,
    folder: &Path,
    accept: bool,
    state: &mut ReceiveState,
    stop: watch::Receiver<bool>,
) -> ReceiveOutcome {
    receive_batch_with(link, offer, folder, accept, state, stop, |_| true).await
}

/// [`receive_batch`], asking `keep_reading` about each binary frame first: `false` leaves the
/// link as a dropped network would.
pub async fn receive_batch_with(
    link: &mut SecureLink,
    offer: &SendMessage,
    folder: &Path,
    accept: bool,
    state: &mut ReceiveState,
    stop: watch::Receiver<bool>,
    keep_reading: impl FnMut(&[u8]) -> bool,
) -> ReceiveOutcome {
    run(
        link,
        offer,
        folder,
        accept,
        state,
        stop,
        keep_reading,
        &|_| {},
    )
    .await
}

/// [`receive_batch`], telling `on_event` how each file goes.
pub async fn receive_batch_observed(
    link: &mut SecureLink,
    offer: &SendMessage,
    folder: &Path,
    state: &mut ReceiveState,
    stop: watch::Receiver<bool>,
    on_event: &(dyn Fn(ReceiveEvent) + Send + Sync),
) -> ReceiveOutcome {
    run(link, offer, folder, true, state, stop, |_| true, on_event).await
}

/// Turns an offer away without a person saying so: this side is busy, does not take files from
/// that sender, or has no room.
pub async fn refuse_batch(link: &mut SecureLink, batch_id: &str, reason: AnswerReason) {
    let answer = SendMessage::SendAnswer {
        batch_id: batch_id.to_owned(),
        accept: false,
        reason: Some(reason),
        resumed: None,
        finished: None,
    };
    if let Ok(text) = serde_json::to_string(&answer) {
        let _ = link.send_text(&text).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    link: &mut SecureLink,
    offer: &SendMessage,
    folder: &Path,
    accept: bool,
    state: &mut ReceiveState,
    stop: watch::Receiver<bool>,
    mut keep_reading: impl FnMut(&[u8]) -> bool,
    on_event: &(dyn Fn(ReceiveEvent) + Send + Sync),
) -> ReceiveOutcome {
    let SendMessage::SendOffer {
        batch_id, files, ..
    } = offer
    else {
        return ReceiveOutcome::Dropped;
    };
    if !accept {
        refuse_batch(link, batch_id, AnswerReason::Declined).await;
        return ReceiveOutcome::Declined;
    }
    let resumed = state.batch_id.as_deref() == Some(batch_id.as_str());
    if !resumed {
        *state = ReceiveState {
            batch_id: Some(batch_id.clone()),
            ..ReceiveState::default()
        };
    }
    let mut wire = Wire::new(link, stop);
    let answer = SendMessage::SendAnswer {
        batch_id: batch_id.clone(),
        accept: true,
        reason: None,
        resumed: resumed.then_some(true),
        finished: resumed.then(|| {
            let mut ids: Vec<String> = state.saved.keys().cloned().collect();
            ids.sort();
            ids
        }),
    };
    if wire.say(&answer).await.is_err() {
        return ReceiveOutcome::Dropped;
    }
    let mut batch = Batch {
        folder,
        listed: files.iter().map(|f| (f.transfer_id.as_str(), f)).collect(),
        keys: files
            .iter()
            .map(|f| (transfer_key(&f.transfer_id), f.transfer_id.as_str()))
            .collect(),
        open: HashMap::new(),
        skipped: BTreeSet::new(),
    };

    let outcome = loop {
        match wire.hear(None).await {
            Heard::Send(SendMessage::SendComplete { batch_id: id }) if id == *batch_id => {
                break ReceiveOutcome::Done;
            }
            Heard::Send(SendMessage::SendCancel { batch_id: id, .. }) if id == *batch_id => {
                break ReceiveOutcome::Cancelled;
            }
            Heard::File(message) => {
                if handle_file(&mut wire, &mut batch, state, message, on_event)
                    .await
                    .is_err()
                {
                    break ReceiveOutcome::Dropped;
                }
            }
            Heard::Binary(frame) => {
                if !keep_reading(&frame) {
                    break ReceiveOutcome::Dropped;
                }
                handle_chunk(&mut batch, &frame, on_event);
            }
            Heard::Stop => {
                let _ = wire
                    .say(&SendMessage::SendCancel {
                        batch_id: batch_id.clone(),
                        reason: Some("The receiver cancelled.".to_owned()),
                    })
                    .await;
                break ReceiveOutcome::Stopped;
            }
            Heard::Gone | Heard::Timeout => break ReceiveOutcome::Dropped,
            Heard::Send(_) => {}
        }
    };

    // Open part files are closed here either way; only a dropped link keeps them for a resume.
    batch.open.clear();
    if outcome != ReceiveOutcome::Dropped {
        for file in files {
            if !state.saved.contains_key(&file.transfer_id) {
                let _ = std::fs::remove_file(part_path(folder, &file.transfer_id));
            }
        }
        state.kept.clear();
        let _ = std::fs::remove_dir(folder.join(PARTIAL_DIR));
    }
    outcome
}

async fn handle_file(
    wire: &mut Wire<'_>,
    batch: &mut Batch<'_>,
    state: &mut ReceiveState,
    message: FileMessage,
    on_event: &(dyn Fn(ReceiveEvent) + Send + Sync),
) -> Result<(), ()> {
    match message {
        FileMessage::FileOffer {
            transfer_id,
            name,
            size,
            part_size,
            part_count,
            ..
        } => {
            let reply = offered(
                batch,
                state,
                &transfer_id,
                &name,
                size,
                part_size,
                part_count,
            );
            match reply {
                Ok(reply) => wire.say(&reply).await,
                Err(reason) => {
                    wire.say(&FileMessage::FileError {
                        transfer_id,
                        message: reason,
                    })
                    .await
                }
            }
        }
        FileMessage::FilePartDone {
            transfer_id,
            part_index,
            hash,
            size,
        } => {
            let ok = part_done(batch, state, &transfer_id, part_index, &hash, size);
            wire.say(&FileMessage::FilePartAck {
                transfer_id,
                part_index,
                ok,
            })
            .await
        }
        FileMessage::FileComplete { transfer_id, hash } => {
            let reply = complete(batch, state, &transfer_id, &hash, on_event).await;
            match reply {
                Some(reply) => wire.say(&reply).await,
                None => Ok(()),
            }
        }
        FileMessage::FileCancel { transfer_id } | FileMessage::FileError { transfer_id, .. } => {
            if batch.listed.contains_key(transfer_id.as_str()) {
                batch.open.remove(&transfer_id);
                state.kept.remove(&transfer_id);
                let _ = std::fs::remove_file(part_path(batch.folder, &transfer_id));
                batch.skipped.insert(transfer_id.clone());
                on_event(ReceiveEvent::Skipped { transfer_id });
            }
            Ok(())
        }
        // What only a receiver says means nothing coming from the sender.
        FileMessage::FileResume { .. }
        | FileMessage::FilePartAck { .. }
        | FileMessage::FileDone { .. } => Ok(()),
    }
}

/// Checks a file offer against the accepted list and opens its part file.
fn offered(
    batch: &mut Batch<'_>,
    state: &mut ReceiveState,
    transfer_id: &str,
    name: &str,
    size: u64,
    part_size: u64,
    part_count: u64,
) -> Result<FileMessage, String> {
    let Some(entry) = batch.listed.get(transfer_id).copied() else {
        return Err("That file is not in the list that was accepted.".to_owned());
    };
    if batch.skipped.contains(transfer_id) {
        return Err("That file was skipped.".to_owned());
    }
    if let Some(saved) = state.saved.get(transfer_id) {
        return Ok(FileMessage::FileDone {
            transfer_id: transfer_id.to_owned(),
            saved_path: saved.to_string_lossy().into_owned(),
            verified: true,
        });
    }
    let listed_name = entry.path.rsplit('/').next().unwrap_or(&entry.path);
    if name != listed_name || size != entry.size {
        return Err("That file does not match the list that was accepted.".to_owned());
    }
    if !(MIN_PART_SIZE..=MAX_PART_SIZE).contains(&part_size) {
        return Err("That file comes in parts of a size this side does not take.".to_owned());
    }
    if part_count != size.div_ceil(part_size).max(1) {
        return Err("Its parts do not add up to its size.".to_owned());
    }
    // A different part size on a new link means the parts kept so far do not line up.
    let kept = state.kept.entry(transfer_id.to_owned()).or_default();
    if kept.part_size != part_size || kept.part_count != part_count {
        *kept = Kept {
            part_size,
            part_count,
            parts: BTreeSet::new(),
        };
    }
    let path = part_path(batch.folder, transfer_id);
    let file = open_part(&path, kept.parts.is_empty())
        .map_err(|_| "There is no room to save it here.".to_owned())?;
    batch.open.insert(
        transfer_id.to_owned(),
        Open {
            file,
            part_path: path,
            size,
            part_size,
            current: None,
        },
    );
    Ok(FileMessage::FileResume {
        transfer_id: transfer_id.to_owned(),
        missing_parts: (0..part_count)
            .filter(|i| !kept.parts.contains(i))
            .collect(),
    })
}

fn open_part(path: &Path, fresh: bool) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(fresh)
        .open(path)
}

fn part_path(folder: &Path, transfer_id: &str) -> PathBuf {
    folder.join(PARTIAL_DIR).join(format!("{transfer_id}.part"))
}

/// Writes one chunk where it belongs. A chunk out of turn spoils its part, which the sender then
/// sends again.
fn handle_chunk(
    batch: &mut Batch<'_>,
    frame: &[u8],
    on_event: &(dyn Fn(ReceiveEvent) + Send + Sync),
) {
    let Some(chunk) = decode_chunk(frame) else {
        return;
    };
    let Some(id) = batch.keys.get(&chunk.transfer_key).copied() else {
        return;
    };
    let Some(open) = batch.open.get_mut(id) else {
        return;
    };
    let index = u64::from(chunk.part_index);
    if chunk.seq == 0 {
        open.current = Some(Current {
            index,
            next_seq: 0,
            received: 0,
            hash: Sha256::new(),
        });
    }
    let Some(current) = open.current.as_mut() else {
        return;
    };
    if current.index != index || current.next_seq != chunk.seq {
        open.current = None;
        return;
    }
    current.hash.update(&chunk.bytes);
    current.next_seq += 1;
    let offset_in_part = current.received;
    current.received += chunk.bytes.len() as u64;
    let write = |file: &mut File, at: u64| -> std::io::Result<()> {
        file.seek(SeekFrom::Start(at))?;
        file.write_all(&chunk.bytes)
    };
    let start = index * open.part_size;
    if start + offset_in_part + chunk.bytes.len() as u64 > open.size
        || write(&mut open.file, start + offset_in_part).is_err()
    {
        open.current = None;
        return;
    }
    on_event(ReceiveEvent::Progress {
        transfer_id: id.to_owned(),
        received: start + offset_in_part + chunk.bytes.len() as u64,
    });
}

fn part_done(
    batch: &mut Batch<'_>,
    state: &mut ReceiveState,
    transfer_id: &str,
    part_index: u64,
    hash: &str,
    size: u64,
) -> bool {
    let Some(open) = batch.open.get_mut(transfer_id) else {
        return false;
    };
    let Some(current) = open.current.take() else {
        return false;
    };
    let ok = current.index == part_index
        && current.received == size
        && hex::encode(current.hash.finalize()) == hash;
    if ok && let Some(kept) = state.kept.get_mut(transfer_id) {
        kept.parts.insert(part_index);
    }
    ok
}

async fn complete(
    batch: &mut Batch<'_>,
    state: &mut ReceiveState,
    transfer_id: &str,
    hash: &str,
    on_event: &(dyn Fn(ReceiveEvent) + Send + Sync),
) -> Option<FileMessage> {
    let open = batch.open.remove(transfer_id)?;
    let entry = batch.listed.get(transfer_id).copied()?;
    let all_parts = state
        .kept
        .get(transfer_id)
        .is_some_and(|kept| kept.parts.len() as u64 == kept.part_count);
    let Open {
        file, part_path, ..
    } = open;
    drop(file);
    let path = part_path.clone();
    let actual = tokio::task::spawn_blocking(move || hash_file(&path))
        .await
        .ok()
        .and_then(Result::ok);
    state.kept.remove(transfer_id);
    if !all_parts || actual.as_deref() != Some(hash) {
        let _ = std::fs::remove_file(&part_path);
        let reason = "It did not arrive intact.".to_owned();
        on_event(ReceiveEvent::Failed {
            transfer_id: transfer_id.to_owned(),
            reason,
        });
        return Some(FileMessage::FileDone {
            transfer_id: transfer_id.to_owned(),
            saved_path: String::new(),
            verified: false,
        });
    }
    let target =
        safe_relative_path(&entry.path).map(|relative| unique_path(&batch.folder.join(relative)));
    let placed = target
        .as_ref()
        .ok_or(())
        .and_then(|target| move_into(&part_path, target).map_err(|_| ()));
    match (placed, target) {
        (Ok(()), Some(target)) => {
            state.saved.insert(transfer_id.to_owned(), target.clone());
            on_event(ReceiveEvent::Saved {
                transfer_id: transfer_id.to_owned(),
                path: target.clone(),
            });
            Some(FileMessage::FileDone {
                transfer_id: transfer_id.to_owned(),
                saved_path: target.to_string_lossy().into_owned(),
                verified: true,
            })
        }
        _ => {
            // A file that is not where it should be is not saved, however well its bytes checked.
            let _ = std::fs::remove_file(&part_path);
            let reason = "It could not be saved here.".to_owned();
            on_event(ReceiveEvent::Failed {
                transfer_id: transfer_id.to_owned(),
                reason: reason.clone(),
            });
            Some(FileMessage::FileError {
                transfer_id: transfer_id.to_owned(),
                message: reason,
            })
        }
    }
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

fn move_into(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    std::fs::remove_file(from)
}

/// `name (1).ext`, `name (2).ext` and so on, as the desktop names a file that is there already.
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name.as_str(), ""),
    };
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| path.to_path_buf())
}
