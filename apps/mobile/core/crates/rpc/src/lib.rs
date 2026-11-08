//! Calling and following methods on a computer over a secure link. One task owns the link, and
//! everything else talks to it through bounded queues, so a slow screen can not fill memory.

use runova_link::secure::{LinkEvent, SecureLink};
use runova_protocol::manage::{MANAGE_VERSION, ManageMessage, decode_stream, parse_message};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

const READY_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_QUEUE: usize = 64;
/// Events waiting for one screen. Past this it has fallen behind and starts over.
const STREAM_QUEUE: usize = 256;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RpcError {
    #[error("the connection to the computer closed")]
    Closed,
    #[error("{message}")]
    Refused { code: String, message: String },
    #[error("Runova on this computer needs an update")]
    VersionMismatch,
    #[error("the phone fell behind this stream")]
    FellBehind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    Value(Value),
    Bytes(Vec<u8>),
    /// The stream is over. With an error, it ended badly.
    Ended(Option<RpcError>),
}

enum Command {
    Call {
        id: u64,
        method: String,
        params: Option<Value>,
        reply: oneshot::Sender<Result<Value, RpcError>>,
    },
    Subscribe {
        id: u64,
        method: String,
        params: Option<Value>,
        events: StreamSender,
    },
    Unsubscribe {
        id: u64,
    },
    Close,
}

struct StreamSender {
    events: mpsc::Sender<StreamEvent>,
    overrun: Arc<AtomicBool>,
}

/// Cheap to clone. The link closes when the last handle and subscription are gone.
#[derive(Clone)]
pub struct ManageClient {
    commands: mpsc::Sender<Command>,
    next_id: Arc<AtomicU64>,
    device_name: Arc<str>,
    scopes: Arc<HashSet<String>>,
}

pub struct Subscription {
    id: u64,
    events: mpsc::Receiver<StreamEvent>,
    overrun: Arc<AtomicBool>,
    commands: mpsc::Sender<Command>,
}

impl Subscription {
    /// The next event, or `None` once the stream is over and has been read to its end.
    pub async fn next(&mut self) -> Option<StreamEvent> {
        match self.events.recv().await {
            Some(event) => Some(event),
            None if self.overrun.swap(false, Ordering::SeqCst) => {
                Some(StreamEvent::Ended(Some(RpcError::FellBehind)))
            }
            None => None,
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.commands.try_send(Command::Unsubscribe { id: self.id });
    }
}

async fn wait_for_ready(link: &mut SecureLink) -> Result<(String, Vec<String>), RpcError> {
    // A computer without this feature waits for a different first message and says nothing.
    let event = timeout(READY_TIMEOUT, link.next())
        .await
        .map_err(|_| RpcError::VersionMismatch)?
        .map_err(|_| RpcError::Closed)?;
    let LinkEvent::Text(text) = event else {
        return Err(RpcError::VersionMismatch);
    };
    match parse_message(&text) {
        Some(ManageMessage::ManageReady {
            v,
            device_name,
            scopes,
        }) if v == MANAGE_VERSION => Ok((device_name, scopes)),
        _ => Err(RpcError::VersionMismatch),
    }
}

impl ManageClient {
    /// Waits for the computer to say what this phone may do, then starts serving calls.
    pub async fn start(mut link: SecureLink) -> Result<Self, RpcError> {
        let (device_name, scopes) = match wait_for_ready(&mut link).await {
            Ok(ready) => ready,
            Err(error) => {
                link.close().await;
                return Err(error);
            }
        };
        let (commands, queue) = mpsc::channel(COMMAND_QUEUE);
        tokio::spawn(run(link, queue));
        Ok(Self {
            commands,
            next_id: Arc::new(AtomicU64::new(1)),
            device_name: device_name.into(),
            scopes: Arc::new(scopes.into_iter().collect()),
        })
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.contains(scope)
    }

    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn call(&self, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(Command::Call {
                id: self.id(),
                method: method.to_owned(),
                params,
                reply,
            })
            .await
            .map_err(|_| RpcError::Closed)?;
        answer.await.map_err(|_| RpcError::Closed)?
    }

    pub async fn subscribe(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Subscription, RpcError> {
        let id = self.id();
        let (events, receiver) = mpsc::channel(STREAM_QUEUE);
        let overrun = Arc::new(AtomicBool::new(false));
        self.commands
            .send(Command::Subscribe {
                id,
                method: method.to_owned(),
                params,
                events: StreamSender {
                    events,
                    overrun: overrun.clone(),
                },
            })
            .await
            .map_err(|_| RpcError::Closed)?;
        Ok(Subscription {
            id,
            events: receiver,
            overrun,
            commands: self.commands.clone(),
        })
    }

    pub async fn close(&self) {
        let _ = self.commands.send(Command::Close).await;
    }
}

struct Engine {
    link: SecureLink,
    pending: HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>,
    streams: HashMap<u64, StreamSender>,
}

impl Engine {
    async fn send(&mut self, message: &ManageMessage) -> bool {
        match serde_json::to_string(message) {
            Ok(text) => self.link.send_text(&text).await.is_ok(),
            Err(_) => false,
        }
    }

    /// Hands an event to its stream. A stream with no room has fallen behind and is cut off.
    async fn deliver(&mut self, id: u64, event: StreamEvent) -> bool {
        let Some(stream) = self.streams.get(&id) else {
            return true;
        };
        if stream.events.try_send(event).is_ok() {
            return true;
        }
        stream.overrun.store(true, Ordering::SeqCst);
        self.streams.remove(&id);
        self.send(&ManageMessage::RpcUnsub { id }).await
    }

    async fn on_command(&mut self, command: Command) -> bool {
        match command {
            Command::Call {
                id,
                method,
                params,
                reply,
            } => {
                self.pending.insert(id, reply);
                self.send(&ManageMessage::RpcCall {
                    id,
                    m: method,
                    p: params,
                })
                .await
            }
            Command::Subscribe {
                id,
                method,
                params,
                events,
            } => {
                self.streams.insert(id, events);
                self.send(&ManageMessage::RpcSub {
                    id,
                    m: method,
                    p: params,
                })
                .await
            }
            Command::Unsubscribe { id } => {
                if self.streams.remove(&id).is_none() {
                    return true;
                }
                self.send(&ManageMessage::RpcUnsub { id }).await
            }
            Command::Close => false,
        }
    }

    async fn on_text(&mut self, text: &str) -> bool {
        match parse_message(text) {
            Some(ManageMessage::RpcResult {
                id,
                ok,
                v,
                code,
                message,
            }) => {
                if let Some(reply) = self.pending.remove(&id) {
                    let answer = if ok {
                        Ok(v.unwrap_or(Value::Null))
                    } else {
                        Err(RpcError::Refused {
                            code: code.unwrap_or_default(),
                            message: message.unwrap_or_default(),
                        })
                    };
                    let _ = reply.send(answer);
                }
                true
            }
            Some(ManageMessage::RpcEvent { id, v }) => {
                self.deliver(id, StreamEvent::Value(v)).await
            }
            Some(ManageMessage::RpcEnd { id, code, message }) => {
                let error = code.map(|code| RpcError::Refused {
                    code,
                    message: message.unwrap_or_default(),
                });
                let delivered = self.deliver(id, StreamEvent::Ended(error)).await;
                self.streams.remove(&id);
                delivered
            }
            // Anything else means the computer and this phone no longer agree.
            _ => false,
        }
    }

    async fn on_link(&mut self, event: LinkEvent) -> bool {
        match event {
            LinkEvent::Text(text) => self.on_text(&text).await,
            LinkEvent::Binary(frame) => match decode_stream(&frame) {
                Some((id, payload)) => {
                    self.deliver(u64::from(id), StreamEvent::Bytes(payload.to_vec()))
                        .await
                }
                None => false,
            },
        }
    }
}

async fn run(link: SecureLink, mut commands: mpsc::Receiver<Command>) {
    let mut engine = Engine {
        link,
        pending: HashMap::new(),
        streams: HashMap::new(),
    };
    loop {
        let keep_going = tokio::select! {
            event = engine.link.next() => match event {
                Ok(event) => engine.on_link(event).await,
                Err(_) => false,
            },
            command = commands.recv() => match command {
                Some(command) => engine.on_command(command).await,
                None => false,
            },
        };
        if !keep_going {
            break;
        }
    }
    engine.link.close().await;
    // Dropping the queue first turns away calls made from now on; the maps tell those waiting.
    drop(commands);
}
