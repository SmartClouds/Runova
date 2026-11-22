//! Taking a batch only to throw it away, for the demo computer inside the app (E119). It answers
//! every step as a computer that saved the files would, and keeps none of the bytes.

use crate::receiver::ReceiveOutcome;
use crate::wire::{Heard, Wire};
use runova_link::secure::SecureLink;
use runova_protocol::file::FileMessage;
use runova_protocol::send::{SendMessage, safe_relative_path};
use std::collections::HashMap;
use tokio::sync::watch;

/// Answers `offer` with a yes and takes every file in it, keeping nothing.
pub async fn discard_batch(
    link: &mut SecureLink,
    offer: &SendMessage,
    stop: watch::Receiver<bool>,
) -> ReceiveOutcome {
    let SendMessage::SendOffer {
        batch_id, files, ..
    } = offer
    else {
        return ReceiveOutcome::Dropped;
    };
    let listed: HashMap<&str, &str> = files
        .iter()
        .map(|f| (f.transfer_id.as_str(), f.path.as_str()))
        .collect();
    let mut wire = Wire::new(link, stop);
    let answer = SendMessage::SendAnswer {
        batch_id: batch_id.clone(),
        accept: true,
        reason: None,
        resumed: None,
        finished: None,
    };
    if wire.say(&answer).await.is_err() {
        return ReceiveOutcome::Dropped;
    }
    loop {
        let reply = match wire.hear(None).await {
            Heard::Send(SendMessage::SendComplete { batch_id: id }) if id == *batch_id => {
                return ReceiveOutcome::Done;
            }
            Heard::Send(SendMessage::SendCancel { batch_id: id, .. }) if id == *batch_id => {
                return ReceiveOutcome::Cancelled;
            }
            Heard::Stop => return ReceiveOutcome::Stopped,
            Heard::Gone | Heard::Timeout => return ReceiveOutcome::Dropped,
            Heard::File(message) => answer_file(&listed, message),
            Heard::Send(_) | Heard::Binary(_) => None,
        };
        if let Some(reply) = reply
            && wire.say(&reply).await.is_err()
        {
            return ReceiveOutcome::Dropped;
        }
    }
}

fn answer_file(listed: &HashMap<&str, &str>, message: FileMessage) -> Option<FileMessage> {
    match message {
        FileMessage::FileOffer {
            transfer_id,
            part_count,
            ..
        } => Some(if listed.contains_key(transfer_id.as_str()) {
            FileMessage::FileResume {
                transfer_id,
                missing_parts: (0..part_count.max(1)).collect(),
            }
        } else {
            FileMessage::FileError {
                transfer_id,
                message: "That file is not in the list that was accepted.".to_owned(),
            }
        }),
        FileMessage::FilePartDone {
            transfer_id,
            part_index,
            ..
        } => Some(FileMessage::FilePartAck {
            transfer_id,
            part_index,
            ok: true,
        }),
        FileMessage::FileComplete { transfer_id, .. } => {
            let path = listed.get(transfer_id.as_str())?;
            let saved_path = safe_relative_path(path).unwrap_or_default();
            Some(FileMessage::FileDone {
                transfer_id,
                saved_path,
                verified: true,
            })
        }
        _ => None,
    }
}
