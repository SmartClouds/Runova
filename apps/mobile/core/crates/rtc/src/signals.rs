//! Signaling messages, as the desktop's `linkPeer.ts` writes them.

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    Sdp { kind: String, sdp: String },
    Ice { candidate: String },
}

impl Signal {
    pub fn to_json(&self) -> String {
        match self {
            Signal::Sdp { kind, sdp } => json!({"k": "sdp", "type": kind, "sdp": sdp}),
            Signal::Ice { candidate } => {
                json!({"k": "ice", "candidate": candidate, "sdpMid": null, "sdpMLineIndex": 0})
            }
        }
        .to_string()
    }

    /// A signal, or `None` for anything else, including the relay message.
    pub fn parse(payload: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(payload).ok()?;
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        match value.get("k")?.as_str()? {
            "sdp" => Some(Signal::Sdp {
                kind: text("type")?,
                sdp: text("sdp")?,
            }),
            "ice" => Some(Signal::Ice {
                candidate: text("candidate")?,
            }),
            _ => None,
        }
    }
}

/// The DTLS fingerprint in an SDP, written the same way on both sides: `sha-256 AB:CD:...`.
pub fn fingerprint_of(sdp: &str) -> String {
    sdp.lines()
        .find_map(|line| line.strip_prefix("a=fingerprint:"))
        .and_then(|rest| rest.trim().split_once(' '))
        .map(|(algorithm, value)| format!("{} {}", algorithm.to_lowercase(), value.to_uppercase()))
        .unwrap_or_default()
}
