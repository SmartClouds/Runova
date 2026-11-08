//! The website's relay, for when two devices can not reach each other directly. It carries sealed
//! binary frames it can not read: open a socket with a one-time ticket, wait for `ready`, and from
//! then on only binary messages are allowed.

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use runova_link::transport::{LinkTransport, TransportClosed};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The relay waits 30 seconds for the other side to arrive.
const READY_TIMEOUT: Duration = Duration::from_secs(35);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The relay's own limit on one message.
const MAX_MESSAGE_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayError {
    Connect(String),
    ClosedEarly,
    TimedOut,
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::Connect(reason) => write!(f, "could not reach the relay: {reason}"),
            RelayError::ClosedEarly => write!(f, "the relay closed before the other side arrived"),
            RelayError::TimedOut => write!(f, "the other side did not arrive at the relay"),
        }
    }
}

impl std::error::Error for RelayError {}

/// The WebSocket address for a relay ticket.
pub fn relay_url(site: &str, path: &str, ticket: &str) -> String {
    let site = site.trim_end_matches('/');
    let socket = site
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            site.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .unwrap_or_else(|| site.to_owned());
    let ticket = utf8_percent_encode(ticket, NON_ALPHANUMERIC);
    format!("{socket}{path}?ticket={ticket}")
}

pub struct RelayTransport {
    socket: Option<Socket>,
    end_reason: Option<String>,
}

impl RelayTransport {
    /// Why the relay ended the session, when it said.
    pub fn end_reason(&self) -> Option<&str> {
        self.end_reason.as_deref()
    }
}

/// Opens the relay and waits until the other side has arrived too.
pub async fn connect_relay(
    site: &str,
    path: &str,
    ticket: &str,
) -> Result<RelayTransport, RelayError> {
    // Only the ring provider is compiled in, so a second install can only be a repeat of this one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    let url = relay_url(site, path, ticket);
    let (mut socket, _) = timeout(
        CONNECT_TIMEOUT,
        connect_async_with_config(url.as_str(), Some(config), false),
    )
    .await
    .map_err(|_| RelayError::TimedOut)?
    .map_err(|e| RelayError::Connect(e.to_string()))?;

    loop {
        let message = timeout(READY_TIMEOUT, socket.next())
            .await
            .map_err(|_| RelayError::TimedOut)?;
        match message {
            Some(Ok(Message::Text(text))) if text.as_str() == "ready" => break,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            _ => return Err(RelayError::ClosedEarly),
        }
    }
    Ok(RelayTransport {
        socket: Some(socket),
        end_reason: None,
    })
}

#[async_trait]
impl LinkTransport for RelayTransport {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), TransportClosed> {
        let socket = self.socket.as_mut().ok_or(TransportClosed)?;
        socket
            .send(Message::binary(frame))
            .await
            .map_err(|_| TransportClosed)
    }

    async fn recv(&mut self) -> Option<Vec<u8>> {
        loop {
            let socket = self.socket.as_mut()?;
            match socket.next().await {
                Some(Ok(Message::Binary(frame))) => return Some(frame.to_vec()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    self.end_reason = frame
                        .filter(|f| f.code == CloseCode::Policy && !f.reason.is_empty())
                        .map(|f| f.reason.as_str().to_owned());
                    self.socket = None;
                    return None;
                }
                // Anything but a binary message is not the computers' own, and ends the session.
                _ => {
                    self.socket = None;
                    return None;
                }
            }
        }
    }

    async fn close(&mut self) {
        if let Some(mut socket) = self.socket.take() {
            let _ = socket.close(None).await;
        }
    }
}
