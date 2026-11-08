//! Connecting to a computer, with the hub and the network faked and the handshake real.

use async_trait::async_trait;
use runova_crypto::handshake::{Identity, Mode, base64url, os_random};
use runova_link::opener::{Direct, Relay};
use runova_link::secure::{HostConfig, LinkEvent, SecureLink};
use runova_link::testing::{MemoryTransport, memory_pair};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_protocol::manage::{ManageMessage, parse_message};
use runova_session::connect::{
    ConnectError, ConnectTarget, DirectLink, Phase, PinStore, Transports, connect_to,
};
use runova_session::hub::{ConnectResult, HostInfo, HubEvent, HubPort, RelayTicket};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

const PHONE_SEED: [u8; 32] = [2; 32];
const HOST_SEED: [u8; 32] = [1; 32];
const WAIT: Duration = Duration::from_secs(10);

fn host_key() -> String {
    base64url(&Identity::from_seed(HOST_SEED).public_key())
}

struct FakeHub {
    result: Mutex<Option<Result<ConnectResult, String>>>,
    requests: Mutex<Vec<(String, i64)>>,
    signals: Mutex<Vec<(String, String)>>,
    ended: Mutex<Vec<String>>,
    tickets: Mutex<u32>,
}

impl FakeHub {
    fn ringing(key: String) -> Arc<Self> {
        Arc::new(Self {
            result: Mutex::new(Some(Ok(ConnectResult {
                status: "ringing".into(),
                session_id: Some("s1".into()),
                host: Some(HostInfo {
                    name: "Sam's desk".into(),
                    identity_key: key,
                    kind: runova_session::hub::HostKind::App,
                }),
            }))),
            requests: Mutex::default(),
            signals: Mutex::default(),
            ended: Mutex::default(),
            tickets: Mutex::new(0),
        })
    }

    fn answering(status: &str) -> Arc<Self> {
        let hub = Self::ringing(String::new());
        *hub.result.lock().unwrap() = Some(Ok(ConnectResult {
            status: status.into(),
            session_id: None,
            host: None,
        }));
        hub
    }
}

#[async_trait]
impl HubPort for FakeHub {
    async fn request_connect(
        &self,
        remote_id: &str,
        device_id: i64,
        _intent: runova_session::hub::Intent,
        _mode: runova_session::hub::AccessMode,
    ) -> Result<ConnectResult, String> {
        self.requests
            .lock()
            .unwrap()
            .push((remote_id.to_owned(), device_id));
        self.result.lock().unwrap().take().expect("one request")
    }

    async fn signal(&self, session_id: &str, payload: &str) {
        self.signals
            .lock()
            .unwrap()
            .push((session_id.to_owned(), payload.to_owned()));
    }

    async fn relay_ticket(&self, _session_id: &str) -> Result<RelayTicket, String> {
        *self.tickets.lock().unwrap() += 1;
        Ok(RelayTicket {
            path: "/relay/remote/s1".into(),
            ticket: "t".into(),
        })
    }

    async fn end(&self, session_id: &str) {
        self.ended.lock().unwrap().push(session_id.to_owned());
    }
}

#[derive(Default)]
struct MemoryPins(Mutex<HashMap<String, String>>);

impl PinStore for MemoryPins {
    fn pinned(&self, remote_id: &str) -> Option<String> {
        self.0.lock().unwrap().get(remote_id).cloned()
    }

    fn pin(&self, remote_id: &str, key: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(remote_id.to_owned(), key.to_owned());
    }
}

/// A computer at the other end of the link that does the real handshake and says it is ready.
fn computer(transport: MemoryTransport, ready: Option<u32>, encrypted: bool) {
    tokio::spawn(async move {
        let phone = Identity::from_seed(PHONE_SEED).public_key();
        let Ok(mut link) = SecureLink::as_host(
            Box::new(transport),
            HostConfig {
                session_id: "s1".into(),
                mode: Mode::Ask,
                identity: Identity::from_seed(HOST_SEED),
                expected_controller_key: phone,
                password_secret: None,
                local_fingerprint: if encrypted {
                    String::new()
                } else {
                    "sha-256 BB".to_owned()
                },
                remote_fingerprint: if encrypted {
                    String::new()
                } else {
                    "sha-256 AA".to_owned()
                },
            },
            encrypted,
            &mut os_random,
        )
        .await
        else {
            return;
        };
        if let Some(version) = ready {
            let hello = ManageMessage::ManageReady {
                v: version,
                device_name: "Sam's desk".into(),
                scopes: vec!["core".into()],
            };
            link.send_text(&serde_json::to_string(&hello).unwrap())
                .await
                .unwrap();
        }
        // Answers every call with its own method name.
        while let Ok(event) = link.next().await {
            if let LinkEvent::Text(text) = event
                && let Some(ManageMessage::RpcCall { id, m, .. }) = parse_message(&text)
            {
                let reply = ManageMessage::RpcResult {
                    id,
                    ok: true,
                    v: Some(json!(m)),
                    code: None,
                    message: None,
                };
                let _ = link
                    .send_text(&serde_json::to_string(&reply).unwrap())
                    .await;
            }
        }
    });
}

struct FakeDirect {
    transport: Mutex<Option<MemoryTransport>>,
    delivered: Mutex<Vec<String>>,
    never: bool,
}

#[async_trait]
impl Direct for FakeDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        if self.never {
            return std::future::pending().await;
        }
        let transport = self.transport.lock().unwrap().take().expect("one connect");
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
impl DirectLink for FakeDirect {
    async fn deliver_signal(&self, payload: String) {
        self.delivered.lock().unwrap().push(payload);
    }
}

struct FakeRelay(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Relay for FakeRelay {
    async fn connect(&self) -> Result<Box<dyn LinkTransport>, String> {
        Ok(Box::new(
            self.0.lock().unwrap().take().expect("one relay connect"),
        ))
    }
}

struct FakeTransports {
    direct: Arc<FakeDirect>,
    relay: Mutex<Option<MemoryTransport>>,
}

impl Transports for FakeTransports {
    fn direct(&self, _signals: mpsc::Sender<String>) -> Arc<dyn DirectLink> {
        self.direct.clone()
    }

    fn relay(&self, _ticket: RelayTicket) -> Box<dyn Relay + Send> {
        Box::new(FakeRelay(Mutex::new(self.relay.lock().unwrap().take())))
    }
}

fn direct_transports(ready: Option<u32>) -> FakeTransports {
    let (phone, host) = memory_pair();
    computer(host, ready, false);
    FakeTransports {
        direct: Arc::new(FakeDirect {
            transport: Mutex::new(Some(phone)),
            delivered: Mutex::default(),
            never: false,
        }),
        relay: Mutex::new(None),
    }
}

fn target() -> ConnectTarget {
    ConnectTarget {
        remote_id: "111222333".into(),
        device_id: 7,
        identity_seed: PHONE_SEED,
    }
}

fn accepted() -> HubEvent {
    HubEvent::Resolved {
        session_id: "s1".into(),
        accepted: true,
        reason: None,
    }
}

fn phases() -> (Arc<Mutex<Vec<Phase>>>, impl Fn(Phase) + Send + Sync) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = seen.clone();
    (seen, move |phase| recorder.lock().unwrap().push(phase))
}

#[tokio::test]
async fn a_computer_that_accepts_ends_in_a_working_session() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();
    let (seen, on_phase) = phases();

    let session = timeout(
        WAIT,
        connect_to(
            target(),
            hub.as_ref(),
            &transports,
            &pins,
            &mut queue,
            &on_phase,
        ),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(hub.requests.lock().unwrap()[0], ("111222333".to_owned(), 7));
    assert_eq!(session.client.device_name(), "Sam's desk");
    assert_eq!(
        session.client.call("projects.list", None).await,
        Ok(json!("projects.list"))
    );
    assert_eq!(session.safety_code.len(), 6);
    let phases = seen.lock().unwrap().clone();
    assert_eq!(
        phases[..4],
        [
            Phase::Requesting,
            Phase::WaitingForApproval,
            Phase::Connecting,
            Phase::Securing
        ]
    );
    assert!(matches!(phases[4], Phase::Connected { direct: true, .. }));
}

#[tokio::test]
async fn the_computers_key_is_pinned_the_first_time() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();
    let (_seen, on_phase) = phases();

    connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await
    .unwrap();

    assert_eq!(pins.pinned("111222333"), Some(host_key()));
}

#[tokio::test]
async fn a_computer_whose_key_changed_is_refused_and_the_request_ended() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let pins = MemoryPins::default();
    pins.pin("111222333", "an-older-key");
    let (_events, mut queue) = mpsc::channel(32);
    let (_seen, on_phase) = phases();

    let result = connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await;

    assert_eq!(result.err(), Some(ConnectError::KeyChanged));
    assert_eq!(hub.ended.lock().unwrap().as_slice(), ["s1"]);
}

#[tokio::test]
async fn each_answer_from_the_hub_says_something_a_person_can_use() {
    for (status, expected) in [
        ("offline", ConnectError::Offline),
        ("unavailable", ConnectError::Unavailable),
        ("rate-limited", ConnectError::RateLimited),
    ] {
        let hub = FakeHub::answering(status);
        let transports = direct_transports(None);
        let pins = MemoryPins::default();
        let (_events, mut queue) = mpsc::channel(32);
        let (_seen, on_phase) = phases();

        let result = connect_to(
            target(),
            hub.as_ref(),
            &transports,
            &pins,
            &mut queue,
            &on_phase,
        )
        .await;

        assert_eq!(result.err(), Some(expected));
    }
}

#[tokio::test]
async fn declining_on_the_computer_is_reported() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events
        .send(HubEvent::Resolved {
            session_id: "s1".into(),
            accepted: false,
            reason: Some("declined".into()),
        })
        .await
        .unwrap();
    let (_seen, on_phase) = phases();

    let result = connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await;

    assert_eq!(result.err(), Some(ConnectError::Declined));
}

#[tokio::test(start_paused = true)]
async fn no_answer_in_time_is_reported_and_ends_the_request() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let pins = MemoryPins::default();
    let (_events, mut queue) = mpsc::channel(32);
    let (_seen, on_phase) = phases();

    let result = connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await;

    assert_eq!(result.err(), Some(ConnectError::NoAnswer));
    assert_eq!(hub.ended.lock().unwrap().as_slice(), ["s1"]);
}

#[tokio::test]
async fn an_older_computer_is_told_to_update() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(2));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();
    let (_seen, on_phase) = phases();

    let result = connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await;

    assert_eq!(result.err(), Some(ConnectError::NeedsUpdate));
}

#[tokio::test]
async fn events_for_other_sessions_are_ignored() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events
        .send(HubEvent::Resolved {
            session_id: "someone-else".into(),
            accepted: false,
            reason: None,
        })
        .await
        .unwrap();
    events.send(accepted()).await.unwrap();
    let (_seen, on_phase) = phases();

    let result = connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn signals_for_this_session_reach_the_direct_link() {
    let hub = FakeHub::ringing(host_key());
    let transports = direct_transports(Some(1));
    let direct = transports.direct.clone();
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();
    events
        .send(HubEvent::Signal {
            session_id: "s1".into(),
            payload: "{\"k\":\"ice\"}".into(),
        })
        .await
        .unwrap();
    let (_seen, on_phase) = phases();

    connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await
    .unwrap();

    assert_eq!(
        direct.delivered.lock().unwrap().as_slice(),
        ["{\"k\":\"ice\"}"]
    );
}

#[tokio::test(start_paused = true)]
async fn when_direct_fails_the_relay_carries_it_sealed() {
    let hub = FakeHub::ringing(host_key());
    let (phone, host) = memory_pair();
    computer(host, Some(1), true);
    let transports = FakeTransports {
        direct: Arc::new(FakeDirect {
            transport: Mutex::new(None),
            delivered: Mutex::default(),
            never: true,
        }),
        relay: Mutex::new(Some(phone)),
    };
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();
    let (seen, on_phase) = phases();

    connect_to(
        target(),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &on_phase,
    )
    .await
    .unwrap();

    assert_eq!(*hub.tickets.lock().unwrap(), 1);
    assert!(
        hub.signals
            .lock()
            .unwrap()
            .iter()
            .any(|(_, p)| p == "{\"k\":\"relay\"}")
    );
    assert!(matches!(
        seen.lock().unwrap().last(),
        Some(Phase::Connected { direct: false, .. })
    ));
}
