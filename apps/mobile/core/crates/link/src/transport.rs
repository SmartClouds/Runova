//! One way to carry link frames between two devices: a WebRTC data channel, or the relay.

use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
#[error("the transport closed")]
pub struct TransportClosed;

#[async_trait]
pub trait LinkTransport: Send {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), TransportClosed>;
    /// The next frame, or `None` once the transport has closed.
    async fn recv(&mut self) -> Option<Vec<u8>>;
    async fn close(&mut self);
}

/// The DTLS fingerprints of a direct link, signed in the handshake. Empty on the relay.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fingerprints {
    pub local: String,
    pub remote: String,
}
