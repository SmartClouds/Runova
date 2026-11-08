//! One connection to a hub. A single task owns the socket; the handle only queues work for it.

use crate::wire::{HubMessage, decode_frames, encode, handshake_request, read_handshake};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, interval, timeout, timeout_at};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Bytes of one WebSocket message: the hub's own limit on signals is well under this.
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_QUEUE: usize = 32;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HubError {
    #[error("the hub turned that down: {0}")]
    Refused(String),
    #[error("could not reach the hub: {0}")]
    Connect(String),
    #[error("the connection to the hub closed")]
    Closed,
}

#[derive(Debug, Clone)]
pub struct HubOptions {
    /// How often to ping when there is nothing else to send.
    pub keep_alive: Duration,
    /// Silence from the server for this long ends the connection.
    pub server_timeout: Duration,
    /// Events waiting for the app. Past this the newest are dropped, so replies never stall.
    pub event_buffer: usize,
}

impl Default for HubOptions {
    fn default() -> Self {
        Self {
            keep_alive: Duration::from_secs(15),
            server_timeout: Duration::from_secs(30),
            event_buffer: 256,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HubEvent {
    pub target: String,
    pub arguments: Vec<Value>,
}

enum Command {
    Invoke {
        id: String,
        target: String,
        arguments: Vec<Value>,
        reply: oneshot::Sender<Result<Value, HubError>>,
    },
    Send {
        target: String,
        arguments: Vec<Value>,
    },
}

/// Cheap to clone. The connection ends when the last handle is dropped.
#[derive(Clone)]
pub struct HubClient {
    commands: mpsc::Sender<Command>,
    next_id: Arc<AtomicU64>,
}

/// A hub's WebSocket address from a site's `http(s)` address and the hub's path.
pub fn hub_url(site: &str, path: &str) -> String {
    let site = site.trim_end_matches('/');
    let socket = site
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            site.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .unwrap_or_else(|| site.to_owned());
    format!("{socket}{path}")
}

async fn open(url: &str, token: &str) -> Result<Socket, HubError> {
    // Only the ring provider is compiled in, so a second install can only be a repeat of this one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut request = url
        .into_client_request()
        .map_err(|e| HubError::Connect(e.to_string()))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|e| HubError::Connect(e.to_string()))?;
    // The server's token handler reads this header and not a query string.
    request.headers_mut().insert(AUTHORIZATION, bearer);
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    let (socket, _) = timeout(
        CONNECT_TIMEOUT,
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| HubError::Connect("timed out".to_owned()))?
    .map_err(|e| HubError::Connect(e.to_string()))?;
    Ok(socket)
}

async fn shake_hands(socket: &mut Socket) -> Result<String, HubError> {
    socket
        .send(Message::text(handshake_request()))
        .await
        .map_err(|e| HubError::Connect(e.to_string()))?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut received = String::new();
    loop {
        let message = timeout_at(deadline, socket.next())
            .await
            .map_err(|_| HubError::Connect("no handshake answer".to_owned()))?
            .ok_or(HubError::Closed)?
            .map_err(|e| HubError::Connect(e.to_string()))?;
        if let Message::Text(text) = message {
            received.push_str(text.as_str());
            if let Some((result, rest)) = read_handshake(&received) {
                result.map_err(HubError::Refused)?;
                return Ok(rest.to_owned());
            }
        }
    }
}

impl HubClient {
    /// Connects with the WebSocket transport directly, which the hubs accept without negotiating.
    pub async fn connect(
        url: &str,
        token: &str,
        options: HubOptions,
    ) -> Result<(Self, mpsc::Receiver<HubEvent>), HubError> {
        let mut socket = open(url, token).await?;
        let leftover = shake_hands(&mut socket).await?;
        let (commands, command_queue) = mpsc::channel(COMMAND_QUEUE);
        let (events, event_queue) = mpsc::channel(options.event_buffer.max(1));
        tokio::spawn(run(socket, command_queue, events, options, leftover));
        Ok((
            Self {
                commands,
                next_id: Arc::new(AtomicU64::new(1)),
            },
            event_queue,
        ))
    }

    /// Calls a hub method and waits for its answer.
    pub async fn invoke(&self, target: &str, arguments: Vec<Value>) -> Result<Value, HubError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Invoke {
                id,
                target: target.to_owned(),
                arguments,
                reply,
            })
            .await
            .map_err(|_| HubError::Closed)?;
        answer.await.map_err(|_| HubError::Closed)?
    }

    /// Calls a hub method without waiting for an answer.
    pub async fn send(&self, target: &str, arguments: Vec<Value>) -> Result<(), HubError> {
        self.commands
            .send(Command::Send {
                target: target.to_owned(),
                arguments,
            })
            .await
            .map_err(|_| HubError::Closed)
    }
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, HubError>>>;

/// False once the server has asked to close.
fn handle_incoming(text: &str, pending: &mut Pending, events: &mpsc::Sender<HubEvent>) -> bool {
    let Ok(messages) = decode_frames(text) else {
        return false;
    };
    for message in messages {
        match message {
            HubMessage::Invocation {
                target, arguments, ..
            } => {
                // Never waits: a full queue must not hold up the replies behind these events.
                let _ = events.try_send(HubEvent { target, arguments });
            }
            HubMessage::Completion {
                invocation_id,
                result,
                error,
            } => {
                if let Some(reply) = pending.remove(&invocation_id) {
                    let answer = match error {
                        Some(error) => Err(HubError::Refused(error)),
                        None => Ok(result.unwrap_or(Value::Null)),
                    };
                    let _ = reply.send(answer);
                }
            }
            HubMessage::Ping => {}
            HubMessage::Close { .. } => return false,
        }
    }
    true
}

async fn run(
    mut socket: Socket,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<HubEvent>,
    options: HubOptions,
    leftover: String,
) {
    let mut pending = Pending::new();
    if !leftover.is_empty() && !handle_incoming(&leftover, &mut pending, &events) {
        return;
    }
    let mut pings = interval(options.keep_alive);
    pings.reset();
    let mut heard_at = Instant::now();
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break };
                heard_at = Instant::now();
                match message {
                    Message::Text(text) => {
                        if !handle_incoming(text.as_str(), &mut pending, &events) {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break };
                let message = match command {
                    Command::Invoke { id, target, arguments, reply } => {
                        pending.insert(id.clone(), reply);
                        HubMessage::Invocation { invocation_id: Some(id), target, arguments }
                    }
                    Command::Send { target, arguments } => {
                        HubMessage::Invocation { invocation_id: None, target, arguments }
                    }
                };
                if socket.send(Message::text(encode(&message))).await.is_err() {
                    break;
                }
            }
            _ = pings.tick() => {
                if heard_at.elapsed() >= options.server_timeout {
                    break;
                }
                if socket.send(Message::text(encode(&HubMessage::Ping))).await.is_err() {
                    break;
                }
            }
        }
    }
    // Dropping `pending` and `events` tells every waiter that the connection ended.
    let _ = socket.close(None).await;
}
