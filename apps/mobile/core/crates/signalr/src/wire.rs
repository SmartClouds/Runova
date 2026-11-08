//! The JSON hub protocol's messages, each ended by the record separator.

use serde_json::{Value, json};
use thiserror::Error;

pub const RS: char = '\u{1e}';

const INVOCATION: u64 = 1;
const COMPLETION: u64 = 3;
const PING: u64 = 6;
const CLOSE: u64 = 7;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("the hub sent something that is not its protocol: {0}")]
pub struct WireError(pub String);

#[derive(Debug, Clone, PartialEq)]
pub enum HubMessage {
    Invocation {
        invocation_id: Option<String>,
        target: String,
        arguments: Vec<Value>,
    },
    Completion {
        invocation_id: String,
        result: Option<Value>,
        error: Option<String>,
    },
    Ping,
    Close {
        error: Option<String>,
        allow_reconnect: bool,
    },
}

pub fn handshake_request() -> String {
    format!("{{\"protocol\":\"json\",\"version\":1}}{RS}")
}

/// The handshake answer and whatever followed it, or `None` when it has not all arrived.
pub fn read_handshake(text: &str) -> Option<(Result<(), String>, &str)> {
    let (first, rest) = text.split_once(RS)?;
    let result = match serde_json::from_str::<Value>(first) {
        Ok(value) => match value.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        },
        Err(_) => Err("the hub's handshake answer was not JSON".to_owned()),
    };
    Some((result, rest))
}

pub fn encode(message: &HubMessage) -> String {
    let value = match message {
        HubMessage::Invocation {
            invocation_id,
            target,
            arguments,
        } => {
            let mut value = json!({"type": INVOCATION, "target": target, "arguments": arguments});
            if let Some(id) = invocation_id {
                value["invocationId"] = json!(id);
            }
            value
        }
        HubMessage::Completion {
            invocation_id,
            result,
            error,
        } => {
            let mut value = json!({"type": COMPLETION, "invocationId": invocation_id});
            if let Some(result) = result {
                value["result"] = result.clone();
            }
            if let Some(error) = error {
                value["error"] = json!(error);
            }
            value
        }
        HubMessage::Ping => json!({"type": PING}),
        HubMessage::Close {
            error,
            allow_reconnect,
        } => {
            let mut value = json!({"type": CLOSE, "allowReconnect": allow_reconnect});
            if let Some(error) = error {
                value["error"] = json!(error);
            }
            value
        }
    };
    format!("{value}{RS}")
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn decode_one(part: &str) -> Result<Option<HubMessage>, WireError> {
    let value: Value = serde_json::from_str(part).map_err(|e| WireError(e.to_string()))?;
    let kind = value
        .get("type")
        .and_then(Value::as_u64)
        .ok_or_else(|| WireError("a message with no type".to_owned()))?;
    Ok(match kind {
        INVOCATION => Some(HubMessage::Invocation {
            invocation_id: text_of(&value, "invocationId"),
            target: text_of(&value, "target")
                .ok_or_else(|| WireError("an invocation with no target".to_owned()))?,
            arguments: value
                .get("arguments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }),
        COMPLETION => Some(HubMessage::Completion {
            invocation_id: text_of(&value, "invocationId")
                .ok_or_else(|| WireError("a completion with no id".to_owned()))?,
            result: value.get("result").cloned(),
            error: text_of(&value, "error"),
        }),
        PING => Some(HubMessage::Ping),
        CLOSE => Some(HubMessage::Close {
            error: text_of(&value, "error"),
            allow_reconnect: value
                .get("allowReconnect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        _ => None,
    })
}

/// Every hub message in one WebSocket message. Kinds this client never asks for are skipped.
pub fn decode_frames(text: &str) -> Result<Vec<HubMessage>, WireError> {
    let mut messages = Vec::new();
    for part in text.split(RS).filter(|part| !part.is_empty()) {
        if let Some(message) = decode_one(part)? {
            messages.push(message);
        }
    }
    Ok(messages)
}
