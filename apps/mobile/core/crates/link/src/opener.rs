//! Finding a way to the computer: a direct WebRTC link first, then the relay. The timing and the
//! relay message are the desktop's, so the two sides agree.

use crate::transport::{Fingerprints, LinkTransport};
use async_trait::async_trait;
use std::time::Duration;
use thiserror::Error;
use tokio::time::timeout;

pub const DIRECT_TIMEOUT: Duration = Duration::from_secs(8);
const RELAY_SIGNAL: &str = "{\"k\":\"relay\"}";

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum OpenError {
    #[error("could not reach the computer: {0}")]
    Unreachable(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Direct,
    Relay,
}

pub struct OpenedLink {
    pub transport: Box<dyn LinkTransport>,
    pub kind: LinkKind,
    pub fingerprints: Fingerprints,
}

#[async_trait]
pub trait Direct: Sync {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String>;
    async fn cancel(&self);
}

#[async_trait]
pub trait Relay: Sync {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String>;
}

#[async_trait]
pub trait RelaySignal: Sync {
    /// Sends a signaling message to the other side of the session.
    async fn tell_other_side(&self, payload: &str);
}

async fn over_relay(relay: &dyn Relay, signal: &dyn RelaySignal) -> Result<OpenedLink, OpenError> {
    signal.tell_other_side(RELAY_SIGNAL).await;
    let transport = relay.connect().await.map_err(OpenError::Unreachable)?;
    Ok(OpenedLink {
        transport,
        kind: LinkKind::Relay,
        fingerprints: Fingerprints::default(),
    })
}

/// A direct link if one comes up in time, otherwise the relay. The controller makes this decision
/// and the computer follows its word.
pub async fn open_link(
    direct: &dyn Direct,
    relay: &dyn Relay,
    signal: &dyn RelaySignal,
    relay_only: bool,
) -> Result<OpenedLink, OpenError> {
    if relay_only {
        return over_relay(relay, signal).await;
    }
    if let Ok(Ok((transport, fingerprints))) = timeout(DIRECT_TIMEOUT, direct.connect()).await {
        return Ok(OpenedLink {
            transport,
            kind: LinkKind::Direct,
            fingerprints,
        });
    }
    direct.cancel().await;
    over_relay(relay, signal).await
}
