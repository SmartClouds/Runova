//! A whole app against a scripted computer. The handshake and management protocol are real; only
//! the server and the network are stood in for.
#![allow(dead_code)]

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::Session;
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use runova_crypto::handshake::{Identity, Mode, base64url, os_random};
use runova_ffi::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use runova_ffi::engine::{Dependencies, Engine, HubConnector};
use runova_ffi::secure::{SecureStore, SecureTokens};
use runova_ffi::view::{AppView, AuthState, ConnectionPhase, ViewListener};
use runova_link::opener::{Direct, Relay};
use runova_link::secure::{HostConfig, LinkEvent, SecureLink};
use runova_link::testing::{MemoryTransport, memory_pair};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_protocol::manage::{ManageMessage, encode_stream, parse_message};
use runova_session::connect::{DirectLink, Transports};
use runova_session::hub::{ConnectResult, HostInfo, HubEvent, HubPort, RelayTicket};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

const PHONE_SEED: [u8; 32] = [2; 32];
const HOST_SEED: [u8; 32] = [1; 32];

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

struct FakeBackend;

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
        }])
    }
}

struct FakeHub {
    events: mpsc::Sender<HubEvent>,
}

#[async_trait]
impl HubPort for FakeHub {
    async fn request_connect(&self, _: &str, _: i64) -> Result<ConnectResult, String> {
        self.events
            .send(HubEvent::Resolved {
                session_id: "s1".into(),
                accepted: true,
                reason: None,
            })
            .await
            .map_err(|e| e.to_string())?;
        Ok(ConnectResult {
            status: "ringing".into(),
            session_id: Some("s1".into()),
            host: Some(HostInfo {
                name: "Sam's desk".into(),
                identity_key: base64url(&Identity::from_seed(HOST_SEED).public_key()),
            }),
        })
    }

    async fn signal(&self, _: &str, _: &str) {}

    async fn relay_ticket(&self, _: &str) -> Result<RelayTicket, String> {
        Err("no relay".into())
    }

    async fn end(&self, _: &str) {}
}

struct FakeConnector;

#[async_trait]
impl HubConnector for FakeConnector {
    async fn connect(
        &self,
        _token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String> {
        let (events, receiver) = mpsc::channel(8);
        Ok((Arc::new(FakeHub { events }), receiver))
    }
}

struct MemoryDirect(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Direct for MemoryDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        let transport = self.0.lock().unwrap().take().ok_or("already used")?;
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

impl Transports for MemoryTransports {
    fn direct(&self, _signals: mpsc::Sender<String>) -> Arc<dyn DirectLink> {
        let (phone, host) = memory_pair();
        self.0.clone().serve(host);
        Arc::new(MemoryDirect(Mutex::new(Some(phone))))
    }

    fn relay(&self, _ticket: RelayTicket) -> Box<dyn Relay + Send> {
        unreachable!("direct always works here")
    }
}

type Answer = Result<Value, (String, String)>;

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

    fn serve(self: Arc<Self>, transport: MemoryTransport) {
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
    pub views: Arc<Views>,
    pub computer: Arc<Computer>,
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

/// An app already signed in and connected to the scripted computer.
pub async fn connected() -> World {
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
    let session = Arc::new(Session::new(
        "https://runovahq.test",
        Arc::new(OneToken),
        Arc::new(SecureTokens(store.clone())),
        Box::new(|| 1_000),
    ));
    let engine = Engine::start(Dependencies {
        site: "https://runovahq.test".into(),
        platform: "android".into(),
        app_version: "1.0.0".into(),
        secure: store,
        listener: views.clone(),
        session,
        backend: Arc::new(FakeBackend),
        hub: Arc::new(FakeConnector),
        transports: Arc::new(MemoryTransports(computer.clone())),
        refresh_every: Duration::from_millis(20),
    });
    let world = World {
        views,
        computer,
        engine,
    };
    world
        .until(
            |v| v.auth == AuthState::SignedIn && !v.systems.is_empty(),
            "the computers",
        )
        .await;
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
