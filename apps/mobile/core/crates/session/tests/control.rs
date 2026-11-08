//! Opening a remote-control link: what the hub is asked for, passwords, and background agents.

use async_trait::async_trait;
use runova_crypto::handshake::{Identity, Mode, base64url, derive_password_secret, os_random};
use runova_link::opener::{Direct, Relay};
use runova_link::secure::{HostConfig, SecureLink};
use runova_link::testing::{MemoryTransport, memory_pair};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_session::connect::{
    ConnectError, ConnectTarget, DirectLink, Phase, PinStore, Transports, connect_control,
};
use runova_session::hub::{
    AccessMode, ConnectResult, HostInfo, HostKind, HubEvent, HubPort, Intent, RelayTicket,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

const PHONE_SEED: [u8; 32] = [2; 32];
const HOST_SEED: [u8; 32] = [1; 32];

fn host_key() -> String {
    base64url(&Identity::from_seed(HOST_SEED).public_key())
}

struct FakeHub {
    kind: HostKind,
    requests: Mutex<Vec<(Intent, AccessMode)>>,
    signals: Mutex<Vec<String>>,
    ended: Mutex<Vec<String>>,
}

impl FakeHub {
    fn new(kind: HostKind) -> Arc<Self> {
        Arc::new(Self {
            kind,
            requests: Mutex::default(),
            signals: Mutex::default(),
            ended: Mutex::default(),
        })
    }
}

#[async_trait]
impl HubPort for FakeHub {
    async fn request_connect(
        &self,
        _remote_id: &str,
        _device_id: i64,
        intent: Intent,
        mode: AccessMode,
    ) -> Result<ConnectResult, String> {
        self.requests.lock().unwrap().push((intent, mode));
        Ok(ConnectResult {
            status: "ringing".into(),
            session_id: Some("s1".into()),
            host: Some(HostInfo {
                name: "Sam's desk".into(),
                identity_key: host_key(),
                kind: self.kind,
            }),
        })
    }

    async fn signal(&self, _session_id: &str, payload: &str) {
        self.signals.lock().unwrap().push(payload.to_owned());
    }

    async fn relay_ticket(&self, _session_id: &str) -> Result<RelayTicket, String> {
        Ok(RelayTicket {
            path: "/relay/s1".into(),
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

fn computer(transport: MemoryTransport, mode: Mode, password: Option<&str>, sealed: bool) {
    let secret = password.map(|p| derive_password_secret(p, &host_key()).expect("the key"));
    tokio::spawn(async move {
        let phone = Identity::from_seed(PHONE_SEED).public_key();
        let Ok(mut link) = SecureLink::as_host(
            Box::new(transport),
            HostConfig {
                session_id: "s1".into(),
                mode,
                identity: Identity::from_seed(HOST_SEED),
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
        // Keep the link open as a host would.
        while link.next().await.is_ok() {}
    });
}

struct ReadyDirect(Mutex<Option<MemoryTransport>>);

#[async_trait]
impl Direct for ReadyDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        let transport = self.0.lock().unwrap().take();
        match transport {
            Some(transport) => Ok((
                Box::new(transport),
                Fingerprints {
                    local: "sha-256 AA".into(),
                    remote: "sha-256 BB".into(),
                },
            )),
            None => std::future::pending().await,
        }
    }

    async fn cancel(&self) {}
}

#[async_trait]
impl DirectLink for ReadyDirect {
    async fn deliver_signal(&self, _payload: String) {}
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
    direct: Arc<ReadyDirect>,
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

fn direct_to(mode: Mode, password: Option<&str>) -> FakeTransports {
    let (phone, host) = memory_pair();
    computer(host, mode, password, false);
    FakeTransports {
        direct: Arc::new(ReadyDirect(Mutex::new(Some(phone)))),
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

fn no_phases(_: Phase) {}

#[tokio::test]
async fn a_viewer_asks_for_control_and_gets_a_secured_link() {
    let hub = FakeHub::new(HostKind::App);
    let transports = direct_to(Mode::Ask, None);
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();

    let link = connect_control(
        target(),
        None,
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &no_phases,
    )
    .await
    .expect("connected");

    assert_eq!(
        hub.requests.lock().unwrap().as_slice(),
        [(Intent::Control, AccessMode::Ask)]
    );
    assert_eq!(link.session_id, "s1");
    assert!(link.direct);
    assert_eq!(link.safety_code.len(), 6);
    assert_eq!(pins.pinned("111222333"), Some(host_key()));
}

#[tokio::test]
async fn a_password_is_turned_into_cpace_and_the_right_one_connects() {
    let hub = FakeHub::new(HostKind::App);
    let transports = direct_to(Mode::Password, Some("correct horse"));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();

    connect_control(
        target(),
        Some("correct horse".into()),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &no_phases,
    )
    .await
    .expect("connected");

    assert_eq!(
        hub.requests.lock().unwrap().as_slice(),
        [(Intent::Control, AccessMode::Password)]
    );
}

#[tokio::test]
async fn a_wrong_password_is_reported_as_one() {
    let hub = FakeHub::new(HostKind::App);
    let transports = direct_to(Mode::Password, Some("correct horse"));
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();

    let result = connect_control(
        target(),
        Some("wrong horse".into()),
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &no_phases,
    )
    .await;

    assert_eq!(result.err(), Some(ConnectError::WrongPassword));
    assert_eq!(hub.ended.lock().unwrap().as_slice(), ["s1"]);
    assert_eq!(pins.pinned("111222333"), None);
}

#[tokio::test(start_paused = true)]
async fn an_agent_is_reached_over_the_relay_as_soon_as_it_says_so() {
    let hub = FakeHub::new(HostKind::Agent);
    let (phone, host) = memory_pair();
    computer(host, Mode::Ask, None, true);
    let transports = FakeTransports {
        direct: Arc::new(ReadyDirect(Mutex::new(None))),
        relay: Mutex::new(Some(phone)),
    };
    let pins = MemoryPins::default();
    let (events, mut queue) = mpsc::channel(32);
    events.send(accepted()).await.unwrap();
    events
        .send(HubEvent::Signal {
            session_id: "s1".into(),
            payload: "{\"k\":\"relay\"}".into(),
        })
        .await
        .unwrap();

    let started = tokio::time::Instant::now();
    let link = connect_control(
        target(),
        None,
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &no_phases,
    )
    .await
    .expect("connected");

    assert_eq!(link.host_kind, HostKind::Agent);
    assert!(!link.direct);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    // The agent has its own key, remembered apart from the app's.
    assert_eq!(pins.pinned("111222333#agent"), Some(host_key()));
    assert_eq!(pins.pinned("111222333"), None);
}

#[tokio::test]
async fn a_changed_agent_key_is_refused_without_touching_the_apps_pin() {
    let hub = FakeHub::new(HostKind::Agent);
    let transports = direct_to(Mode::Ask, None);
    let pins = MemoryPins::default();
    pins.pin("111222333#agent", "an-older-key");
    let (_events, mut queue) = mpsc::channel(32);

    let result = connect_control(
        target(),
        None,
        hub.as_ref(),
        &transports,
        &pins,
        &mut queue,
        &no_phases,
    )
    .await;

    assert_eq!(result.err(), Some(ConnectError::KeyChanged));
}
