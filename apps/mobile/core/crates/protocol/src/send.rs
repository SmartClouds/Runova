//! Sending files (E112): the messages on a link opened with the `send` intent, as
//! `packages/protocol/src/send.ts` defines them. The sender offers a list, the person at the other
//! end accepts or declines, the files go with the [`crate::file`] messages, and `send-complete`
//! ends it. `send-ping` keeps a quiet link from looking dead.

use crate::file::transfer_key;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// What a device says, as it goes online, when it takes files.
pub const RECEIVE_FILES_FEATURE: &str = "receive-files";
/// The part size a send uses.
pub const SEND_PART_BYTES: u64 = 4 * 1024 * 1024;
/// How often a send link is pinged, and how long a silent one is given.
pub const SEND_PING_MS: u64 = 10_000;
pub const SEND_SILENCE_MS: u64 = 20_000;

pub const MAX_FILES: usize = 10_000;
pub const MAX_OFFER_BYTES: usize = 4 * 1024 * 1024;
/// In characters (code points).
pub const MAX_NOTE_CHARS: usize = 500;
/// In UTF-16 units, as the desktop counts a string's length.
pub const MAX_PATH_CHARS: usize = 1024;
pub const MAX_SEGMENTS: usize = 32;
pub const MAX_SEGMENT_BYTES: usize = 255;
pub const MIN_PART_SIZE: u64 = 64 * 1024;
pub const MAX_PART_SIZE: u64 = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFile {
    pub transfer_id: String,
    /// Relative, with `/` between folders, ending in the file's name.
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnswerReason {
    Declined,
    Busy,
    Timeout,
    NotAllowed,
    NoSpace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum SendMessage {
    SendOffer {
        v: u8,
        batch_id: String,
        files: Vec<SendFile>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    SendAnswer {
        batch_id: String,
        accept: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<AnswerReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resumed: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finished: Option<Vec<String>>,
    },
    SendCancel {
        batch_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    SendPing,
    SendComplete {
        batch_id: String,
    },
}

/// Whether a text message belongs to the send protocol, by its `t`.
pub fn is_send_message(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("t")?.as_str().map(|t| t.starts_with("send-")))
        .unwrap_or(false)
}

/// Reads one send message, or `None` when it is malformed or breaks a limit.
pub fn parse_send_message(text: &str) -> Option<SendMessage> {
    if text.len() > MAX_OFFER_BYTES {
        return None;
    }
    let message: SendMessage = serde_json::from_str(text).ok()?;
    let fine = match &message {
        SendMessage::SendOffer {
            v,
            batch_id,
            files,
            note,
        } => *v == 1 && is_id(batch_id) && note.as_deref().is_none_or(is_note) && files_fine(files),
        SendMessage::SendAnswer {
            batch_id, finished, ..
        } => {
            is_id(batch_id)
                && finished
                    .as_ref()
                    .is_none_or(|ids| ids.len() <= MAX_FILES && ids.iter().all(|id| is_id(id)))
        }
        SendMessage::SendCancel { batch_id, reason } => {
            is_id(batch_id) && reason.as_deref().is_none_or(is_note)
        }
        SendMessage::SendPing => true,
        SendMessage::SendComplete { batch_id } => is_id(batch_id),
    };
    fine.then_some(message)
}

fn files_fine(files: &[SendFile]) -> bool {
    if files.is_empty() || files.len() > MAX_FILES {
        return false;
    }
    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    let mut paths = HashSet::new();
    files.iter().all(|file| {
        let Some(target) = safe_relative_path(&file.path) else {
            return false;
        };
        // Two files that would land on one name, or share a chunk key, can not both be told apart.
        is_id(&file.transfer_id)
            && file.size <= MAX_SAFE_INTEGER
            && ids.insert(file.transfer_id.clone())
            && keys.insert(transfer_key(&file.transfer_id))
            && paths.insert(send_path_key(&target))
    })
}

/// Where a file in an offer may go, as a relative path with `/` between parts, or `None` when the
/// path tries to leave the folder it is saved in. The same rules as the desktop's
/// `safeRelativePath`: refused are empty parts, `.` and `..`, a leading `/`, a drive letter, a
/// backslash and control characters; mended are the characters Windows forbids, trailing dots and
/// spaces, and the names Windows keeps for devices.
pub fn safe_relative_path(path: &str) -> Option<String> {
    let units = path.encode_utf16().count();
    if units == 0 || units > MAX_PATH_CHARS {
        return None;
    }
    if path.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
        || path.contains('\\')
        || path.starts_with('/')
        || has_drive(path)
    {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > MAX_SEGMENTS {
        return None;
    }
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        let mended = mend_part(part);
        if mended.len() > MAX_SEGMENT_BYTES {
            return None;
        }
        out.push(mended);
    }
    Some(out.join("/"))
}

/// A path as compared for clashes: case does not count, as on Windows and macOS.
pub fn send_path_key(path: &str) -> String {
    path.to_lowercase()
}

fn has_drive(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some(letter), Some(':')) if letter.is_ascii_alphabetic())
}

fn mend_part(part: &str) -> String {
    let replaced: String = part
        .chars()
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return "_".to_owned();
    }
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    if is_reserved(stem) {
        format!("{stem}_{}", &trimmed[stem.len()..])
    } else {
        trimmed.to_owned()
    }
}

fn is_reserved(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || ((lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.len() == 4
            && matches!(lower.as_bytes()[3], b'1'..=b'9'))
}

fn is_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_note(value: &str) -> bool {
    value.chars().count() <= MAX_NOTE_CHARS
}
