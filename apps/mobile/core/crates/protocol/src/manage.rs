//! Managing a computer from a phone: `packages/protocol/src/manage.ts`, field order included.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MANAGE_VERSION: u32 = 1;
pub const MANAGE_CAPABILITY: &str = "manage/1";

const STREAM_KIND: u8 = 1;
const STREAM_HEADER: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ManageMessage {
    #[serde(rename = "manage-ready")]
    ManageReady {
        v: u32,
        #[serde(rename = "deviceName")]
        device_name: String,
        scopes: Vec<String>,
    },
    #[serde(rename = "rpc-call")]
    RpcCall {
        id: u64,
        m: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p: Option<Value>,
    },
    #[serde(rename = "rpc-result")]
    RpcResult {
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        v: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "rpc-sub")]
    RpcSub {
        id: u64,
        m: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p: Option<Value>,
    },
    #[serde(rename = "rpc-unsub")]
    RpcUnsub { id: u64 },
    #[serde(rename = "rpc-event")]
    RpcEvent { id: u64, v: Value },
    #[serde(rename = "rpc-end")]
    RpcEnd {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

/// The message, or `None` for anything that is not exactly one of the shapes above.
pub fn parse_message(text: &str) -> Option<ManageMessage> {
    let message: ManageMessage = serde_json::from_str(text).ok()?;
    let valid = match &message {
        ManageMessage::RpcCall { m, .. } | ManageMessage::RpcSub { m, .. } => !m.is_empty(),
        ManageMessage::RpcResult {
            ok, code, message, ..
        } => *ok || (code.as_deref().is_some_and(|c| !c.is_empty()) && message.is_some()),
        _ => true,
    };
    valid.then_some(message)
}

/// A subscription's raw bytes: `[kind u8][subscription u32 BE][bytes]`.
pub fn encode_stream(subscription: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(STREAM_HEADER + payload.len());
    frame.push(STREAM_KIND);
    frame.extend_from_slice(&subscription.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn decode_stream(frame: &[u8]) -> Option<(u32, &[u8])> {
    if frame.len() < STREAM_HEADER || frame[0] != STREAM_KIND {
        return None;
    }
    let id = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
    Some((id, &frame[STREAM_HEADER..]))
}
