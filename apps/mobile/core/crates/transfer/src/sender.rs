//! Sending a batch: the offer, the answer, then each file in parts, stop and wait, the way the
//! desktop's receiver expects them.

use crate::source::{FileSource, SourceOpener};
use crate::wire::{Heard, Wire};
use runova_link::secure::SecureLink;
use runova_protocol::file::{FILE_CHUNK_BYTES, FileChunk, FileMessage, encode_chunk, transfer_key};
use runova_protocol::send::{AnswerReason, SendFile, SendMessage};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

/// A little past the other side's minute to answer, and the link opening before it.
const ANSWER_WAIT: Duration = Duration::from_secs(75);
/// How long one step of a file (its resume, a part's ack, its receipt) is given.
const STEP_WAIT: Duration = Duration::from_secs(60);
const MAX_PART_RETRIES: u32 = 5;

#[derive(Debug, Clone)]
pub struct SendPlan {
    pub batch_id: String,
    pub files: Vec<SendFile>,
    pub note: Option<String>,
    pub part_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendEvent {
    Waiting,
    Sending,
    Progress {
        transfer_id: String,
        transferred: u64,
    },
    FileDone {
        transfer_id: String,
    },
    FileFailed {
        transfer_id: String,
        reason: String,
    },
    FileSkipped {
        transfer_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    /// Everything that could go went; `failed` did not arrive intact or could not be read.
    Done {
        failed: usize,
    },
    Declined(Option<AnswerReason>),
    /// No one answered in time.
    Expired,
    /// The person here stopped it.
    Cancelled,
    /// The other side stopped it.
    CancelledByThem,
    /// The link went; dialing again resumes it.
    Dropped,
}

enum FileResult {
    Done,
    Failed(String),
    Skipped,
    Stop,
    CancelledByThem,
    Gone,
}

/// Sends `plan` over `link`. `finished` is what has arrived already, from an earlier link of the
/// same batch, and gains each file as it lands.
pub async fn send_batch(
    link: &mut SecureLink,
    plan: &SendPlan,
    sources: &dyn SourceOpener,
    finished: &mut HashSet<String>,
    on_event: &(dyn Fn(SendEvent) + Send + Sync),
    stop: watch::Receiver<bool>,
) -> SendOutcome {
    let mut wire = Wire::new(link, stop);
    let offer = SendMessage::SendOffer {
        v: 1,
        batch_id: plan.batch_id.clone(),
        files: plan.files.clone(),
        note: plan.note.clone(),
    };
    if wire.say(&offer).await.is_err() {
        return SendOutcome::Dropped;
    }
    on_event(SendEvent::Waiting);
    let deadline = Instant::now() + ANSWER_WAIT;
    loop {
        match wire.hear(Some(deadline)).await {
            Heard::Send(SendMessage::SendAnswer {
                batch_id,
                accept,
                reason,
                finished: already,
                ..
            }) if batch_id == plan.batch_id => {
                if !accept {
                    return SendOutcome::Declined(reason);
                }
                finished.extend(already.unwrap_or_default());
                break;
            }
            Heard::Send(SendMessage::SendCancel { batch_id, .. }) if batch_id == plan.batch_id => {
                return SendOutcome::CancelledByThem;
            }
            Heard::File(FileMessage::FileOffer { transfer_id, .. }) => {
                refuse_offer(&mut wire, transfer_id).await;
            }
            Heard::Stop => return cancel(&mut wire, plan, "The sender cancelled.").await,
            Heard::Timeout => {
                let _ = cancel(&mut wire, plan, "No one answered in time.").await;
                return SendOutcome::Expired;
            }
            Heard::Gone => return SendOutcome::Dropped,
            _ => {}
        }
    }

    on_event(SendEvent::Sending);
    let mut failed = 0;
    for file in &plan.files {
        if finished.contains(&file.transfer_id) {
            on_event(SendEvent::FileDone {
                transfer_id: file.transfer_id.clone(),
            });
            continue;
        }
        match send_file(&mut wire, file, plan.part_bytes, sources, on_event).await {
            FileResult::Done => {
                finished.insert(file.transfer_id.clone());
                on_event(SendEvent::FileDone {
                    transfer_id: file.transfer_id.clone(),
                });
            }
            FileResult::Failed(reason) => {
                failed += 1;
                on_event(SendEvent::FileFailed {
                    transfer_id: file.transfer_id.clone(),
                    reason,
                });
            }
            FileResult::Skipped => on_event(SendEvent::FileSkipped {
                transfer_id: file.transfer_id.clone(),
            }),
            FileResult::Stop => return cancel(&mut wire, plan, "The sender cancelled.").await,
            FileResult::CancelledByThem => return SendOutcome::CancelledByThem,
            FileResult::Gone => return SendOutcome::Dropped,
        }
    }
    let _ = wire
        .say(&SendMessage::SendComplete {
            batch_id: plan.batch_id.clone(),
        })
        .await;
    SendOutcome::Done { failed }
}

async fn cancel(wire: &mut Wire<'_>, plan: &SendPlan, reason: &str) -> SendOutcome {
    let _ = wire
        .say(&SendMessage::SendCancel {
            batch_id: plan.batch_id.clone(),
            reason: Some(reason.to_owned()),
        })
        .await;
    SendOutcome::Cancelled
}

/// A sender takes no files: an offer the other way is turned away.
async fn refuse_offer(wire: &mut Wire<'_>, transfer_id: String) {
    let _ = wire
        .say(&FileMessage::FileError {
            transfer_id,
            message: "This side only sends files.".to_owned(),
        })
        .await;
}

/// What came while one step of a file waited.
enum StepHeard {
    Got(FileMessage),
    Result(FileResult),
}

async fn wait_step(wire: &mut Wire<'_>, transfer_id: &str) -> StepHeard {
    let deadline = Instant::now() + STEP_WAIT;
    loop {
        match wire.hear(Some(deadline)).await {
            Heard::File(FileMessage::FileOffer {
                transfer_id: other, ..
            }) => refuse_offer(wire, other).await,
            Heard::File(message) if message.transfer_id() == transfer_id => match message {
                FileMessage::FileError { message, .. } => {
                    return StepHeard::Result(FileResult::Failed(message));
                }
                FileMessage::FileCancel { .. } => return StepHeard::Result(FileResult::Skipped),
                other => return StepHeard::Got(other),
            },
            Heard::Send(SendMessage::SendCancel { .. }) => {
                return StepHeard::Result(FileResult::CancelledByThem);
            }
            Heard::Stop => return StepHeard::Result(FileResult::Stop),
            Heard::Gone | Heard::Timeout => return StepHeard::Result(FileResult::Gone),
            _ => {}
        }
    }
}

async fn send_file(
    wire: &mut Wire<'_>,
    file: &SendFile,
    part_bytes: u64,
    sources: &dyn SourceOpener,
    on_event: &(dyn Fn(SendEvent) + Send + Sync),
) -> FileResult {
    let mut source = match sources.open(&file.transfer_id) {
        Ok(source) => source,
        Err(reason) => return FileResult::Failed(reason),
    };
    let id = file.transfer_id.as_str();
    let name = file
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&file.path)
        .to_owned();
    let part_count = file.size.div_ceil(part_bytes).max(1);
    let offer = FileMessage::FileOffer {
        transfer_id: id.to_owned(),
        name,
        size: file.size,
        part_size: part_bytes,
        part_count,
        dest_dir: None,
    };
    if wire.say(&offer).await.is_err() {
        return FileResult::Gone;
    }
    let missing = match wait_step(wire, id).await {
        StepHeard::Got(FileMessage::FileResume { missing_parts, .. }) => missing_parts,
        // Saved already on an earlier link; the receipt just never came.
        StepHeard::Got(FileMessage::FileDone { verified, .. }) => {
            return if verified {
                FileResult::Done
            } else {
                FileResult::Failed("It did not arrive intact.".to_owned())
            };
        }
        StepHeard::Got(_) => {
            return FileResult::Failed("The other side lost track of it.".to_owned());
        }
        StepHeard::Result(result) => return result,
    };
    let key = transfer_key(id);
    let mut done_parts = part_count.saturating_sub(missing.len() as u64);
    for part in missing.into_iter().filter(|part| *part < part_count) {
        let mut retries = 0;
        loop {
            let base = done_parts * part_bytes;
            let (hash, size) = match send_part(
                wire,
                source.as_mut(),
                key,
                part,
                part_bytes,
                file.size,
                |sent| {
                    on_event(SendEvent::Progress {
                        transfer_id: id.to_owned(),
                        transferred: (base + sent).min(file.size),
                    });
                },
            )
            .await
            {
                PartSent::Sent { hash, size } => (hash, size),
                PartSent::Unreadable(reason) => {
                    tell_error(wire, id, &reason).await;
                    return FileResult::Failed(reason);
                }
                PartSent::Stop => return FileResult::Stop,
                PartSent::Gone => return FileResult::Gone,
            };
            let done = FileMessage::FilePartDone {
                transfer_id: id.to_owned(),
                part_index: part,
                hash,
                size,
            };
            if wire.say(&done).await.is_err() {
                return FileResult::Gone;
            }
            let ok = loop {
                match wait_step(wire, id).await {
                    StepHeard::Got(FileMessage::FilePartAck { part_index, ok, .. })
                        if part_index == part =>
                    {
                        break ok;
                    }
                    StepHeard::Got(_) => {}
                    StepHeard::Result(result) => return result,
                }
            };
            if ok {
                done_parts += 1;
                break;
            }
            retries += 1;
            if retries > MAX_PART_RETRIES {
                let reason = format!("Part {} of {part_count} failed too many times.", part + 1);
                tell_error(wire, id, &reason).await;
                return FileResult::Failed(reason);
            }
        }
    }

    // The whole file's hash is read again from the file, so a resume can not leave a part out.
    // It reads the whole file, so it runs where blocking is fine.
    let size = file.size;
    let hashed = tokio::task::spawn_blocking(move || whole_hash(source.as_mut(), size)).await;
    let hash = match hashed {
        Ok(Ok(hash)) => hash,
        Ok(Err(reason)) => {
            tell_error(wire, id, &reason).await;
            return FileResult::Failed(reason);
        }
        Err(_) => {
            let reason = "It could not be read.".to_owned();
            tell_error(wire, id, &reason).await;
            return FileResult::Failed(reason);
        }
    };
    let complete = FileMessage::FileComplete {
        transfer_id: id.to_owned(),
        hash,
    };
    if wire.say(&complete).await.is_err() {
        return FileResult::Gone;
    }
    loop {
        match wait_step(wire, id).await {
            StepHeard::Got(FileMessage::FileDone { verified, .. }) => {
                return if verified {
                    FileResult::Done
                } else {
                    FileResult::Failed("It did not arrive intact.".to_owned())
                };
            }
            StepHeard::Got(_) => {}
            StepHeard::Result(result) => return result,
        }
    }
}

async fn tell_error(wire: &mut Wire<'_>, transfer_id: &str, reason: &str) {
    let _ = wire
        .say(&FileMessage::FileError {
            transfer_id: transfer_id.to_owned(),
            message: reason.to_owned(),
        })
        .await;
}

enum PartSent {
    Sent { hash: String, size: u64 },
    Unreadable(String),
    Stop,
    Gone,
}

/// Streams one part as chunk frames and hashes it as it goes.
async fn send_part(
    wire: &mut Wire<'_>,
    source: &mut dyn FileSource,
    key: u32,
    part: u64,
    part_bytes: u64,
    size: u64,
    progress: impl Fn(u64),
) -> PartSent {
    let start = part * part_bytes;
    let end = (start + part_bytes).min(size);
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; FILE_CHUNK_BYTES];
    let mut offset = start;
    let mut seq = 0u32;
    loop {
        if wire.stopped() {
            return PartSent::Stop;
        }
        let want = ((end - offset) as usize).min(FILE_CHUNK_BYTES);
        let read = match source.read_at(offset, &mut buffer[..want]) {
            Ok(read) => read,
            Err(_) => return PartSent::Unreadable("It could not be read.".to_owned()),
        };
        if read < want {
            return PartSent::Unreadable("It changed while it was being sent.".to_owned());
        }
        hash.update(&buffer[..read]);
        let frame = encode_chunk(&FileChunk {
            transfer_key: key,
            part_index: part as u32,
            seq,
            bytes: buffer[..read].to_vec(),
        });
        if wire.say_binary(&frame).await.is_err() {
            return PartSent::Gone;
        }
        seq += 1;
        offset += read as u64;
        progress(offset - start);
        if offset >= end {
            break;
        }
    }
    PartSent::Sent {
        hash: hex::encode(hash.finalize()),
        size: end - start,
    }
}

fn whole_hash(source: &mut dyn FileSource, size: u64) -> Result<String, String> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; FILE_CHUNK_BYTES * 4];
    let mut offset = 0;
    while offset < size {
        let want = ((size - offset) as usize).min(buffer.len());
        let read = source
            .read_at(offset, &mut buffer[..want])
            .map_err(|_| "It could not be read.".to_owned())?;
        if read == 0 {
            return Err("It changed while it was being sent.".to_owned());
        }
        hash.update(&buffer[..read]);
        offset += read as u64;
    }
    Ok(hex::encode(hash.finalize()))
}
