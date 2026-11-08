//! A whole app against a scripted computer. The handshake and management protocol are real; only
//! the server and the network are stood in for.
#![allow(dead_code)]

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::Session;
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use runova_crypto::handshake::{Identity, Mode, base64url, derive_password_secret, os_random};
use runova_ffi::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use runova_ffi::engine::{Dependencies, Engine, HubConnector};
use runova_ffi::notifications::{FeedConnector, FeedEvent};
use runova_ffi::secure::{SecureStore, SecureTokens};
use runova_ffi::view::{AppView, AuthState, ConnectionPhase, ViewListener};
use runova_link::opener::{Direct, Relay};
use runova_link::secure::{HostConfig, LinkEvent, SecureLink};
use runova_link::testing::{MemoryTransport, memory_pair};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_protocol::manage::{ManageMessage, encode_stream, parse_message};
use runova_protocol::remote::{ControlMessage, parse_control};
use runova_session::connect::{DirectLink, Transports};
use runova_session::hub::{
    AccessMode, ConnectResult, HostInfo, HostKind, HubEvent, HubPort, Intent, RelayTicket,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

const PHONE_SEED: [u8; 32] = [2; 32];
const HOST_SEED: [u8; 32] = [1; 32];
/// The background agent has a key of its own.
const AGENT_SEED: [u8; 32] = [3; 32];

#[derive(Default)]
pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: String) -> Option<String> {
        self.0.lock().unwrap().get(&key).cloned()
    }

    fn set(&self, key: String, value: String) {
        self.0.lock().unwrap().insert(key, value);
    }

    fn remove(&self, key: String) {
        self.0.lock().unwrap().remove(&key);
    }
}

#[derive(Default)]
pub struct Views(pub Mutex<Vec<AppView>>);

impl ViewListener for Views {
    fn on_view(&self, view: AppView) {
        self.0.lock().unwrap().push(view);
    }
}

struct OneToken;

#[async_trait]
impl HttpTransport for OneToken {
    async fn post_json(&self, _url: &str, _body: Value) -> Result<HttpReply, HttpError> {
        Err(HttpError("not used".into()))
    }
}

/// The website, answering from a table and remembering what was changed.
#[derive(Default)]
pub struct FakeBackend {
    rest: Mutex<HashMap<String, Value>>,
    changes: Mutex<Vec<(String, String, Value)>>,
    unattended: AtomicBool,
}

impl FakeBackend {
    pub fn answer(&self, path: &str, value: Value) {
        self.rest.lock().unwrap().insert(path.to_owned(), value);
    }

    /// The next change to this path is turned down.
    pub fn refuse(&self, path: &str) {
        self.rest.lock().unwrap().remove(path);
    }

    pub fn sent(&self) -> Vec<(String, String, Value)> {
        self.changes.lock().unwrap().clone()
    }
}

#[async_trait]
impl Backend for FakeBackend {
    async fn register_phone(&self, _phone: PhoneRegistration) -> Result<i64, BackendError> {
        Ok(77)
    }

    async fn systems(&self) -> Result<Vec<SystemEntry>, BackendError> {
        Ok(vec![SystemEntry {
            id: 5,
            remote_id: "111222333".into(),
            name: "Sam's desk".into(),
            platform: "windows".into(),
            kind: "app".into(),
            online: true,
            own: true,
            unattended: self.unattended.load(Ordering::SeqCst),
        }])
    }

    async fn get_json(&self, path: &str) -> Result<Value, BackendError> {
        self.rest
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| BackendError::Failed(format!("nothing at {path}")))
    }

    async fn send_json(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, BackendError> {
        self.changes
            .lock()
            .unwrap()
            .push((method.to_owned(), path.to_owned(), body));
        self.get_json(path).await
    }
}

struct FakeHub {
    events: mpsc::Sender<HubEvent>,
    computer: Arc<Computer>,
}

#[async_trait]
impl HubPort for FakeHub {
    async fn request_connect(
        &self,
        _: &str,
        _: i64,
        intent: Intent,
        mode: AccessMode,
    ) -> Result<ConnectResult, String> {
        self.computer.intents.lock().unwrap().push((intent, mode));
        let agent = self.computer.agent.load(Ordering::SeqCst);
        let accepted =
            mode == AccessMode::Password || !self.computer.declines.load(Ordering::SeqCst);
        let answers =
            mode == AccessMode::Password || !self.computer.keeps_ringing.load(Ordering::SeqCst);
        if answers {
            self.events
                .send(HubEvent::Resolved {
                    session_id: "s1".into(),
                    accepted,
                    reason: None,
                })
                .await
                .map_err(|e| e.to_string())?;
        }
        if answers && agent && accepted {
            // The agent has no WebRTC, and says so straight away.
            self.events
                .send(HubEvent::Signal {
                    session_id: "s1".into(),
                    payload: "{\"k\":\"relay\"}".into(),
                })
                .await
                .map_err(|e| e.to_string())?;
        }
        let seed = if agent { AGENT_SEED } else { HOST_SEED };
        Ok(ConnectResult {
            status: "ringing".into(),
            session_id: Some("s1".into()),
            host: Some(HostInfo {
                name: "Sam's desk".into(),
                identity_key: base64url(&Identity::from_seed(seed).public_key()),
                kind: if agent {
                    HostKind::Agent
                } else {
                    HostKind::App
                },
            }),
        })
    }

    async fn signal(&self, _: &str, _: &str) {}

    async fn relay_ticket(&self, _: &str) -> Result<RelayTicket, String> {
        Ok(RelayTicket {
            path: "/relay/remote/s1".into(),
            ticket: "t".into(),
        })
    }

    async fn end(&self, _: &str) {}
}

/// The notifications hub, pushing whatever a test asks.
#[derive(Default)]
pub struct FakeFeed {
    sender: Mutex<Option<mpsc::Sender<FeedEvent>>>,
}

impl FakeFeed {
    fn send(&self, event: FeedEvent) {
        let sender = self.sender.lock().unwrap().clone().expect("connected");
        sender.try_send(event).ok();
    }

    pub fn notification(&self, value: Value) {
        self.send(FeedEvent::Notification(value));
    }

    pub fn monitor_changed(&self) {
        self.send(FeedEvent::MonitorChanged);
    }
}

#[async_trait]
impl FeedConnector for FakeFeed {
    async fn connect(&self, _token: String) -> Result<mpsc::Receiver<FeedEvent>, String> {
        let (sender, queue) = mpsc::channel(32);
        *self.sender.lock().unwrap() = Some(sender);
        Ok(queue)
    }
}

struct FakeConnector(Arc<Computer>);

#[async_trait]
impl HubConnector for FakeConnector {
    async fn connect(
        &self,
        _token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String> {
        let (events, receiver) = mpsc::channel(8);
        let hub = FakeHub {
            events,
            computer: self.0.clone(),
        };
        Ok((Arc::new(hub), receiver))
    }
}

struct MemoryDirect(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Direct for MemoryDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        let transport = self.0.lock().unwrap().take();
        let Some(transport) = transport else {
            return std::future::pending().await;
        };
        Ok((
            Box::new(transport),
            Fingerprints {
                local: "sha-256 AA".into(),
                remote: "sha-256 BB".into(),
            },
        ))
    }

    async fn cancel(&self) {}
}

#[async_trait]
impl DirectLink for MemoryDirect {
    async fn deliver_signal(&self, _payload: String) {}
}

struct MemoryTransports(Arc<Computer>);

struct MemoryRelay(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Relay for MemoryRelay {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String> {
        let transport = self.0.lock().unwrap().take();
        transport
            .map(|t| Box::new(t) as Box<dyn LinkTransport>)
            .ok_or_else(|| "relay used twice".to_owned())
    }
}

impl Transports for MemoryTransports {
    fn direct(&self, _signals: mpsc::Sender<String>) -> Arc<dyn DirectLink> {
        if self.0.agent.load(Ordering::SeqCst) {
            // An agent can only be reached through the relay.
            return Arc::new(MemoryDirect(Mutex::new(None)));
        }
        let (phone, host) = memory_pair();
        self.0.clone().serve(host, false);
        Arc::new(MemoryDirect(Mutex::new(Some(phone))))
    }

    fn relay(&self, _ticket: RelayTicket) -> Box<dyn Relay + Send> {
        let (phone, host) = memory_pair();
        self.0.clone().serve(host, true);
        Box::new(MemoryRelay(Mutex::new(Some(phone))))
    }
}

type Answer = Result<Value, (String, String)>;

/// What a scripted computer's remote-control side sends.
enum ControlPush {
    Binary(Vec<u8>),
    Text(String),
    Hangup,
}

enum Push {
    Event(u64, Value),
    Bytes(u64, Vec<u8>),
    End(u64, Option<(String, String)>),
}

/// Answers calls from its table and remembers everything a phone asked for.
#[derive(Default)]
pub struct Computer {
    answers: Mutex<HashMap<String, Answer>>,
    pub calls: Mutex<Vec<(String, Option<Value>)>>,
    subscriptions: Mutex<HashMap<String, u64>>,
    pub unsubscribed: Mutex<Vec<u64>>,
    push: Mutex<Option<mpsc::UnboundedSender<Push>>>,
    /// Every intent and mode a connection asked for, in order.
    pub intents: Mutex<Vec<(Intent, AccessMode)>>,
    /// Only the background agent is answering, over the relay and with its own key.
    pub agent: AtomicBool,
    /// Says no to requests that ask the person at the computer.
    pub declines: AtomicBool,
    /// No one at the computer answers requests that ask them.
    pub keeps_ringing: AtomicBool,
    /// The unattended-access password, for password connections.
    pub password: Mutex<Option<String>>,
    /// Everything the remote-control side was sent.
    pub control_received: Mutex<Vec<ControlMessage>>,
    control_push: Mutex<Option<mpsc::UnboundedSender<ControlPush>>>,
}

impl Computer {
    pub fn answer(&self, method: &str, value: Value) {
        self.answers
            .lock()
            .unwrap()
            .insert(method.to_owned(), Ok(value));
    }

    pub fn refuse(&self, method: &str, code: &str, message: &str) {
        self.answers.lock().unwrap().insert(
            method.to_owned(),
            Err((code.to_owned(), message.to_owned())),
        );
    }

    pub fn params_of(&self, method: &str) -> Vec<Option<Value>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, p)| p.clone())
            .collect()
    }

    pub fn subscription(&self, method: &str) -> Option<u64> {
        self.subscriptions.lock().unwrap().get(method).copied()
    }

    fn send(&self, push: Push) {
        self.push
            .lock()
            .unwrap()
            .as_ref()
            .expect("connected")
            .send(push)
            .ok();
    }

    pub fn event(&self, method: &str, value: Value) {
        let id = self.subscription(method).expect("subscribed");
        self.send(Push::Event(id, value));
    }

    pub fn bytes(&self, method: &str, bytes: &[u8]) {
        let id = self.subscription(method).expect("subscribed");
        self.send(Push::Bytes(id, bytes.to_vec()));
    }

    pub fn end(&self, method: &str) {
        let id = self.subscription(method).expect("subscribed");
        self.send(Push::End(id, None));
    }

    pub fn end_with(&self, method: &str, code: &str, message: &str) {
        let id = self.subscription(method).expect("subscribed");
        self.send(Push::End(id, Some((code.to_owned(), message.to_owned()))));
    }

    /// Sends a screen tile, as the host's control connection would.
    pub fn control_tile(&self, x: u16, y: u16, w: u16, h: u16, jpeg: &[u8]) {
        let mut frame = vec![0x01u8, 0, 0, 0, 1];
        for value in [x, y, w, h] {
            frame.extend_from_slice(&value.to_be_bytes());
        }
        frame.extend_from_slice(jpeg);
        self.control(ControlPush::Binary(frame));
    }

    pub fn control_text(&self, text: &str) {
        self.control(ControlPush::Text(text.to_owned()));
    }

    pub fn hang_up_control(&self) {
        self.control(ControlPush::Hangup);
    }

    fn control(&self, push: ControlPush) {
        self.control_push
            .lock()
            .unwrap()
            .as_ref()
            .expect("a remote-control connection")
            .send(push)
            .ok();
    }

    /// Serves one remote-control connection: the same protocol the desktop or agent speaks.
    fn serve_control(self: Arc<Self>, transport: MemoryTransport, sealed: bool, mode: AccessMode) {
        let (push, mut pushes) = mpsc::unbounded_channel();
        *self.control_push.lock().unwrap() = Some(push);
        let agent = self.agent.load(Ordering::SeqCst);
        let seed = if agent { AGENT_SEED } else { HOST_SEED };
        let secret = (mode == AccessMode::Password).then(|| {
            let key = base64url(&Identity::from_seed(seed).public_key());
            derive_password_secret(
                self.password
                    .lock()
                    .unwrap()
                    .as_deref()
                    .expect("a password"),
                &key,
            )
            .expect("the password secret")
        });
        tokio::spawn(async move {
            let phone = Identity::from_seed(PHONE_SEED).public_key();
            let host_mode = if secret.is_some() {
                Mode::Password
            } else {
                Mode::Ask
            };
            let Ok(mut link) = SecureLink::as_host(
                Box::new(transport),
                HostConfig {
                    session_id: "s1".into(),
                    mode: host_mode,
                    identity: Identity::from_seed(seed),
                    expected_controller_key: phone,
                    password_secret: secret,
                    local_fingerprint: if sealed {
                        String::new()
                    } else {
                        "sha-256 BB".into()
                    },
                    remote_fingerprint: if sealed {
                        String::new()
                    } else {
                        "sha-256 AA".into()
                    },
                },
                sealed,
                &mut os_random,
            )
            .await
            else {
                return;
            };
            loop {
                tokio::select! {
                    event = link.next() => {
                        let Ok(LinkEvent::Text(text)) = event else { break };
                        let Some(message) = parse_control(&text) else { continue };
                        let said_hello = matches!(message, ControlMessage::Hello { .. });
                        self.control_received.lock().unwrap().push(message);
                        if said_hello {
                            let ok = r#"{"t":"auth-ok","deviceName":"Sam's desk","screen":{"width":1280,"height":720}}"#;
                            let _ = link.send_text(ok).await;
                        }
                    }
                    Some(push) = pushes.recv() => {
                        match push {
                            ControlPush::Binary(frame) => {
                                let _ = link.send_binary(&frame).await;
                            }
                            ControlPush::Text(text) => {
                                let _ = link.send_text(&text).await;
                            }
                            ControlPush::Hangup => {
                                link.close().await;
                                break;
                            }
                        }
                    }
                }
            }
        });
    }

    fn serve(self: Arc<Self>, transport: MemoryTransport, sealed: bool) {
        let last = *self.intents.lock().unwrap().last().expect("a request");
        if last.0 == Intent::Control {
            self.serve_control(transport, sealed, last.1);
            return;
        }
        let (push, mut pushes) = mpsc::unbounded_channel();
        *self.push.lock().unwrap() = Some(push);
        tokio::spawn(async move {
            let phone = Identity::from_seed(PHONE_SEED).public_key();
            let mut link = SecureLink::as_host(
                Box::new(transport),
                HostConfig {
                    session_id: "s1".into(),
                    mode: Mode::Ask,
                    identity: Identity::from_seed(HOST_SEED),
                    expected_controller_key: phone,
                    password_secret: None,
                    local_fingerprint: "sha-256 BB".into(),
                    remote_fingerprint: "sha-256 AA".into(),
                },
                false,
                &mut os_random,
            )
            .await
            .expect("the handshake");
            let ready = ManageMessage::ManageReady {
                v: 1,
                device_name: "Sam's desk".into(),
                scopes: vec!["core".into(), "terminal".into(), "git".into()],
            };
            link.send_text(&serde_json::to_string(&ready).unwrap())
                .await
                .unwrap();
            loop {
                tokio::select! {
                    event = link.next() => {
                        let Ok(LinkEvent::Text(text)) = event else { break };
                        self.on_message(&mut link, &text).await;
                    }
                    Some(push) = pushes.recv() => {
                        match push {
                            Push::Event(id, v) => {
                                let m = ManageMessage::RpcEvent { id, v };
                                link.send_text(&serde_json::to_string(&m).unwrap()).await.unwrap();
                            }
                            Push::Bytes(id, bytes) => {
                                link.send_binary(&encode_stream(id as u32, &bytes)).await.unwrap();
                            }
                            Push::End(id, why) => {
                                let (code, message) = why.unzip();
                                let m = ManageMessage::RpcEnd { id, code, message };
                                link.send_text(&serde_json::to_string(&m).unwrap()).await.unwrap();
                            }
                        }
                    }
                }
            }
        });
    }

    async fn on_message(&self, link: &mut SecureLink, text: &str) {
        match parse_message(text) {
            Some(ManageMessage::RpcCall { id, m, p }) => {
                self.calls.lock().unwrap().push((m.clone(), p));
                let answer = self
                    .answers
                    .lock()
                    .unwrap()
                    .get(&m)
                    .cloned()
                    .unwrap_or(Ok(json!([])));
                let reply = match answer {
                    Ok(value) => ManageMessage::RpcResult {
                        id,
                        ok: true,
                        v: Some(value),
                        code: None,
                        message: None,
                    },
                    Err((code, message)) => ManageMessage::RpcResult {
                        id,
                        ok: false,
                        v: None,
                        code: Some(code),
                        message: Some(message),
                    },
                };
                let _ = link
                    .send_text(&serde_json::to_string(&reply).unwrap())
                    .await;
            }
            Some(ManageMessage::RpcSub { id, m, p }) => {
                self.calls.lock().unwrap().push((m.clone(), p));
                self.subscriptions.lock().unwrap().insert(m, id);
            }
            Some(ManageMessage::RpcUnsub { id }) => self.unsubscribed.lock().unwrap().push(id),
            _ => {}
        }
    }
}

pub struct World {
    pub store: Arc<MemoryStore>,
    pub views: Arc<Views>,
    pub computer: Arc<Computer>,
    pub backend: Arc<FakeBackend>,
    pub feed: Arc<FakeFeed>,
    pub engine: Engine,
}

impl World {
    pub fn latest(&self) -> Option<AppView> {
        self.views.0.lock().unwrap().last().cloned()
    }

    pub async fn until(&self, check: impl Fn(&AppView) -> bool, label: &str) -> AppView {
        for _ in 0..800 {
            if let Some(view) = self.latest()
                && check(&view)
            {
                return view;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!(
            "timed out waiting for {label}; last view: {:?}",
            self.latest()
        );
    }
}

/// An app signed in and looking at its computers, connected to none of them.
pub async fn signed_in() -> World {
    signed_in_to(false).await
}

/// The same, with a computer that takes its unattended-access password.
pub async fn signed_in_to_unattended() -> World {
    signed_in_to(true).await
}

async fn signed_in_to(unattended: bool) -> World {
    let store = Arc::new(MemoryStore::default());
    store.set(
        "identity-seed".to_owned(),
        URL_SAFE_NO_PAD.encode(PHONE_SEED),
    );
    store.set(
        "tokens".to_owned(),
        json!({
            "access_token": "rd1.a",
            "refresh_token": "rr1.a",
            "expires_at": 4_000_000_000u64,
            "session_id": 4,
        })
        .to_string(),
    );
    let views = Arc::new(Views::default());
    let computer = Arc::new(Computer::default());
    let backend = Arc::new(FakeBackend::default());
    let feed = Arc::new(FakeFeed::default());
    backend.unattended.store(unattended, Ordering::SeqCst);
    let session = Arc::new(Session::new(
        "https://runovahq.test",
        Arc::new(OneToken),
        Arc::new(SecureTokens(store.clone())),
        Box::new(|| 1_000),
    ));
    let kept = store.clone();
    let engine = Engine::start(Dependencies {
        site: "https://runovahq.test".into(),
        platform: "android".into(),
        app_version: "1.0.0".into(),
        secure: store,
        listener: views.clone(),
        session,
        backend: backend.clone(),
        feed: feed.clone(),
        hub: Arc::new(FakeConnector(computer.clone())),
        transports: Arc::new(MemoryTransports(computer.clone())),
        refresh_every: Duration::from_millis(20),
    });
    let world = World {
        store: kept,
        views,
        computer,
        backend,
        feed,
        engine,
    };
    world
        .until(
            |v| v.auth == AuthState::SignedIn && !v.systems.is_empty(),
            "the computers",
        )
        .await;
    world
}

/// An app already signed in and connected to the scripted computer.
pub async fn connected() -> World {
    let world = signed_in().await;
    world.engine.connect(5);
    world
        .until(
            |v| {
                v.connection
                    .as_ref()
                    .is_some_and(|c| c.phase == ConnectionPhase::Connected)
            },
            "connected",
        )
        .await;
    world
}
