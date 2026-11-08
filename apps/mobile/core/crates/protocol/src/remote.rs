//! The remote-control messages the desktop and the background agent speak, as
//! `packages/protocol/src/index.ts` defines them. A controller sends JSON text frames and gets the
//! screen back as binary frames carrying JPEG tiles.

use serde::{Deserialize, Serialize};

pub const REMOTE_PROTOCOL_VERSION: u32 = 4;
pub const BIN_SCREEN_TILE: u8 = 0x01;

const TILE_HEADER: usize = 13;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum InputEvent {
    Move {
        x: f64,
        y: f64,
    },
    Down {
        x: f64,
        y: f64,
        button: MouseButton,
    },
    Up {
        x: f64,
        y: f64,
        button: MouseButton,
    },
    Wheel {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    /// A key that is not a character. `code` is a DOM `KeyboardEvent.code`.
    Key {
        code: String,
        down: bool,
    },
    Text {
        text: String,
    },
}

/// The control messages this app sends or reads. Everything else on the link, such as file
/// transfer, reads as [`ControlMessage::Other`] and is ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ControlMessage {
    Hello {
        role: String,
        device_name: String,
        protocol_version: u32,
        intent: String,
    },
    AuthOk {
        device_name: String,
        screen: ScreenSize,
    },
    AuthFail {
        reason: String,
    },
    ScreenInfo {
        width: u32,
        height: u32,
    },
    ControlStart,
    Input {
        event: InputEvent,
    },
    Clipboard {
        text: String,
    },
    Ping,
    Pong,
    Bye {
        reason: String,
    },
    #[serde(other)]
    Other,
}

/// A control message, or `None` for text that is not one.
pub fn parse_control(text: &str) -> Option<ControlMessage> {
    serde_json::from_str(text).ok()
}

/// Where a tile goes. The JPEG is the rest of the frame, from [`TILE_JPEG_OFFSET`] on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileHeader {
    pub frame_id: u32,
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

pub const TILE_JPEG_OFFSET: usize = TILE_HEADER;

fn be16(frame: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([frame[at], frame[at + 1]])
}

/// A tile's header, or `None` for any other frame or a truncated one.
pub fn decode_tile_header(frame: &[u8]) -> Option<TileHeader> {
    if frame.len() <= TILE_HEADER || frame[0] != BIN_SCREEN_TILE {
        return None;
    }
    let header = TileHeader {
        frame_id: u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]),
        x: be16(frame, 5),
        y: be16(frame, 7),
        w: be16(frame, 9),
        h: be16(frame, 11),
    };
    (header.w > 0 && header.h > 0).then_some(header)
}
