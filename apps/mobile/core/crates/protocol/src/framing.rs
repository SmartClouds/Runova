//! Link framing, the same over a data channel and the relay (`packages/protocol/src/link.ts`).
//!
//! A frame starts with its kind: `0x01` text, `0x02` binary, or `0x03` a fragment,
//! `[0x03][message id u32][index u16][count u16][inner kind u8][chunk]`, big-endian.

use thiserror::Error;

pub const LINK_TEXT: u8 = 0x01;
pub const LINK_BINARY: u8 = 0x02;
pub const LINK_FRAGMENT: u8 = 0x03;

/// 60 KiB: under the 64 KiB a data channel message is guaranteed to carry.
pub const LINK_MAX_FRAME: usize = 60 * 1024;
pub const LINK_MAX_MESSAGE: usize = 32 * 1024 * 1024;

const FRAGMENT_HEADER: usize = 10;
const FRAGMENT_CHUNK: usize = LINK_MAX_FRAME - FRAGMENT_HEADER;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Text,
    Binary,
}

impl LinkKind {
    fn byte(self) -> u8 {
        match self {
            LinkKind::Text => LINK_TEXT,
            LinkKind::Binary => LINK_BINARY,
        }
    }

    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            LINK_TEXT => Some(LinkKind::Text),
            LINK_BINARY => Some(LinkKind::Binary),
            _ => None,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FramingError {
    #[error("an empty frame")]
    Empty,
    #[error("an unknown frame kind {0}")]
    UnknownKind(u8),
    #[error("a fragment with a bad header")]
    BadFragment,
    #[error("a fragment out of order")]
    OutOfOrder,
    #[error("a whole message in the middle of a fragmented one")]
    Interrupted,
    #[error("a message larger than the link allows")]
    TooLarge,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LinkMessage {
    pub kind: LinkKind,
    pub payload: Vec<u8>,
}

/// The frames for one message. `message_id` only has to differ from the previous fragmented one.
pub fn encode_link_message(
    kind: LinkKind,
    payload: &[u8],
    message_id: u32,
) -> Result<Vec<Vec<u8>>, FramingError> {
    if payload.len() < LINK_MAX_FRAME {
        let mut frame = Vec::with_capacity(payload.len() + 1);
        frame.push(kind.byte());
        frame.extend_from_slice(payload);
        return Ok(vec![frame]);
    }

    let count = payload.len().div_ceil(FRAGMENT_CHUNK);
    let count_u16 = u16::try_from(count).map_err(|_| FramingError::TooLarge)?;
    let mut frames = Vec::with_capacity(count);
    for (index, chunk) in payload.chunks(FRAGMENT_CHUNK).enumerate() {
        let mut frame = Vec::with_capacity(FRAGMENT_HEADER + chunk.len());
        frame.push(LINK_FRAGMENT);
        frame.extend_from_slice(&message_id.to_be_bytes());
        frame.extend_from_slice(&(index as u16).to_be_bytes());
        frame.extend_from_slice(&count_u16.to_be_bytes());
        frame.push(kind.byte());
        frame.extend_from_slice(chunk);
        frames.push(frame);
    }
    Ok(frames)
}

struct Partial {
    id: u32,
    count: u16,
    next: u16,
    kind: LinkKind,
    payload: Vec<u8>,
}

/// Turns frames back into messages. Any error means the link has to close.
pub struct LinkReassembler {
    limit: usize,
    partial: Option<Partial>,
}

impl Default for LinkReassembler {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkReassembler {
    pub fn new() -> Self {
        Self::with_limit(LINK_MAX_MESSAGE)
    }

    pub fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            partial: None,
        }
    }

    pub fn push(&mut self, frame: &[u8]) -> Result<Option<LinkMessage>, FramingError> {
        let (&first, rest) = frame.split_first().ok_or(FramingError::Empty)?;
        if let Some(kind) = LinkKind::from_byte(first) {
            if self.partial.is_some() {
                return Err(FramingError::Interrupted);
            }
            return Ok(Some(LinkMessage {
                kind,
                payload: rest.to_vec(),
            }));
        }
        if first != LINK_FRAGMENT {
            return Err(FramingError::UnknownKind(first));
        }
        self.push_fragment(frame)
    }

    fn push_fragment(&mut self, frame: &[u8]) -> Result<Option<LinkMessage>, FramingError> {
        if frame.len() < FRAGMENT_HEADER {
            return Err(FramingError::BadFragment);
        }
        let id = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
        let index = u16::from_be_bytes([frame[5], frame[6]]);
        let count = u16::from_be_bytes([frame[7], frame[8]]);
        let inner = LinkKind::from_byte(frame[9]).ok_or(FramingError::BadFragment)?;
        if count < 2 || index >= count {
            return Err(FramingError::BadFragment);
        }
        if usize::from(count) * FRAGMENT_CHUNK > self.limit + FRAGMENT_CHUNK {
            return Err(FramingError::TooLarge);
        }

        if index == 0 {
            if self.partial.is_some() {
                return Err(FramingError::Interrupted);
            }
            // Grown as chunks arrive, so a false count can not reserve memory up front.
            self.partial = Some(Partial {
                id,
                count,
                next: 0,
                kind: inner,
                payload: Vec::new(),
            });
        }
        let partial = self.partial.as_mut().ok_or(FramingError::OutOfOrder)?;
        if partial.id != id
            || partial.count != count
            || partial.next != index
            || partial.kind != inner
        {
            return Err(FramingError::OutOfOrder);
        }

        let chunk = &frame[FRAGMENT_HEADER..];
        if partial.payload.len() + chunk.len() > self.limit {
            return Err(FramingError::TooLarge);
        }
        partial.payload.extend_from_slice(chunk);
        partial.next += 1;
        if partial.next < count {
            return Ok(None);
        }

        let done = self.partial.take().ok_or(FramingError::OutOfOrder)?;
        Ok(Some(LinkMessage {
            kind: done.kind,
            payload: done.payload,
        }))
    }
}
