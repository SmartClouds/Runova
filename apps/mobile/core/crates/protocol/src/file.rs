//! The resumable file transfer the desktop speaks over a link (`packages/protocol/src/index.ts`):
//! a file goes in parts, each part as binary chunk frames, each part hashed and acknowledged, and
//! the whole file checked once more at the end.

use serde::{Deserialize, Serialize};

pub const BIN_FILE_CHUNK: u8 = 0x02;
/// The bytes of one chunk frame, apart from its 13-byte header.
pub const FILE_CHUNK_BYTES: usize = 64 * 1024;
const CHUNK_HEADER: usize = 13;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FileMessage {
    FileOffer {
        transfer_id: String,
        name: String,
        size: u64,
        part_size: u64,
        part_count: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dest_dir: Option<String>,
    },
    FileResume {
        transfer_id: String,
        missing_parts: Vec<u64>,
    },
    FilePartDone {
        transfer_id: String,
        part_index: u64,
        hash: String,
        size: u64,
    },
    FilePartAck {
        transfer_id: String,
        part_index: u64,
        ok: bool,
    },
    FileComplete {
        transfer_id: String,
        hash: String,
    },
    FileDone {
        transfer_id: String,
        saved_path: String,
        verified: bool,
    },
    FileError {
        transfer_id: String,
        message: String,
    },
    FileCancel {
        transfer_id: String,
    },
}

impl FileMessage {
    /// Reads a file message, or `None` for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    pub fn transfer_id(&self) -> &str {
        match self {
            Self::FileOffer { transfer_id, .. }
            | Self::FileResume { transfer_id, .. }
            | Self::FilePartDone { transfer_id, .. }
            | Self::FilePartAck { transfer_id, .. }
            | Self::FileComplete { transfer_id, .. }
            | Self::FileDone { transfer_id, .. }
            | Self::FileError { transfer_id, .. }
            | Self::FileCancel { transfer_id } => transfer_id,
        }
    }
}

/// One binary frame of a part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChunk {
    pub transfer_key: u32,
    pub part_index: u32,
    pub seq: u32,
    pub bytes: Vec<u8>,
}

/// `kind(1) transferKey(4) partIndex(4) seq(4)`, big-endian, then the bytes.
pub fn encode_chunk(chunk: &FileChunk) -> Vec<u8> {
    let mut frame = Vec::with_capacity(CHUNK_HEADER + chunk.bytes.len());
    frame.push(BIN_FILE_CHUNK);
    frame.extend_from_slice(&chunk.transfer_key.to_be_bytes());
    frame.extend_from_slice(&chunk.part_index.to_be_bytes());
    frame.extend_from_slice(&chunk.seq.to_be_bytes());
    frame.extend_from_slice(&chunk.bytes);
    frame
}

pub fn decode_chunk(frame: &[u8]) -> Option<FileChunk> {
    if frame.len() < CHUNK_HEADER || frame[0] != BIN_FILE_CHUNK {
        return None;
    }
    let word =
        |at: usize| u32::from_be_bytes([frame[at], frame[at + 1], frame[at + 2], frame[at + 3]]);
    Some(FileChunk {
        transfer_key: word(1),
        part_index: word(5),
        seq: word(9),
        bytes: frame[CHUNK_HEADER..].to_vec(),
    })
}

/// The 32-bit key a transfer's chunks carry: FNV-1a over the id's UTF-16 code units, as the
/// desktop computes it with `charCodeAt`.
pub fn transfer_key(id: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in id.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}
