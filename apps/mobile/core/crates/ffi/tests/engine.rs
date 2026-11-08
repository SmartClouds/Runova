//! The app's behavior as native code sees it, with the server and the computer faked.

use async_trait::async_trait;
use runova_api::auth::Session;
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use runova_ffi::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use runova_ffi::engine::{AppLifecycle, Dependencies, Engine, HubConnector};
use runova_ffi::secure::{SecureStore, SecureTokens};
use runova_ffi::view::{AppView, AuthState, ConnectionPhase, ViewListener};
use runova_link::opener::{Direct, Relay};
use runova_link::transport::{Fingerprints, LinkTransport};
use runova_session::connect::{DirectLink, Transports};
use runova_session::hub::{ConnectResult, HostInfo, HubEvent, HubPort, RelayTicket};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);

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
struct Views(Mutex<Vec<AppView>>);

impl ViewListener for Views {
    fn on_view(&self, view: AppView) {
        self.0.lock().unwrap().push(view);
    }
}

#[derive(Default)]
struct FakeHttp {
    replies: Mutex<VecDeque<HttpReply>>,
}

#[async_trait]
impl HttpTransport for FakeHttp {
    async fn post_json(&self, _url: &str, _body: Value) -> Result<HttpReply, HttpError> {
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| HttpError("no reply queued".into()))
    }
}

fn tokens() -> HttpReply {
    HttpReply {
        status: 200,
        body: json!({
            "accessToken": "rd1.a",
            "refreshToken": "rr1.a",
            "expiresIn": 900,
            "sessionId": 4,
            "account": {},
        })
        .to_string(),
    }
}

#[derive(Default)]
struct FakeBackend {
    registered: Mutex<Vec<PhoneRegistration>>,
    systems: Mutex<Vec<SystemEntry>>,
    fail_directory: Mutex<Option<BackendError>>,
}

#[async_trait]
impl Backend for FakeBackend {
    async fn register_phone(&self, phone: PhoneRegistration) -> Result<i64, BackendError> {
        self.registered.lock().unwrap().push(phone);
        Ok(77)
    }

    async fn systems(&self) -> Result<Vec<SystemEntry>, BackendError> {
        if let Some(error) = self.fail_directory.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(self.systems.lock().unwrap().clone())
    }
}

fn desk() -> SystemEntry {
    SystemEntry {
        id: 5,
        remote_id: "111222333".into(),
        name: "Sam's desk".into(),
        platform: "windows".into(),
        kind: "app".into(),
        online: true,
        own: true,
        unattended: false,
    }
}

#[derive(Default)]
struct FakeHub {
    outcome: Mutex<Option<ConnectResult>>,
    calls: AtomicU32,
}

#[async_trait]
impl HubPort for FakeHub {
    async fn request_connect(
        &self,
        _: &str,
        _: i64,
        _: runova_session::hub::Intent,
        _: runova_session::hub::AccessMode,
    ) -> Result<ConnectResult, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self
            .outcome
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(ConnectResult {
                status: "offline".into(),
                session_id: None,
                host: None,
            }))
    }

    async fn signal(&self, _: &str, _: &str) {}

    async fn relay_ticket(&self, _: &str) -> Result<RelayTicket, String> {
        Err("no relay".into())
    }

    async fn end(&self, _: &str) {}
}

struct FakeConnector {
    hub: Arc<FakeHub>,
    events: Mutex<Option<mpsc::Sender<HubEvent>>>,
    connects: AtomicU32,
}

#[async_trait]
impl HubConnector for FakeConnector {
    async fn connect(
        &self,
        _token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel(32);
        *self.events.lock().unwrap() = Some(sender);
        Ok((self.hub.clone(), receiver))
    }
}

struct NoDirect;

#[async_trait]
impl Direct for NoDirect {
    async fn connect(&self) -> Result<(Box<dyn LinkTransport>, Fingerprints), String> {
        Err("no network here".into())
    }

    async fn cancel(&self) {}
}

#[async_trait]
impl DirectLink for NoDirect {
    async fn deliver_signal(&self, _payload: String) {}
}

struct NoTransports;

impl Transports for NoTransports {
    fn direct(&self, _signals: mpsc::Sender<String>) -> Arc<dyn DirectLink> {
        Arc::new(NoDirect)
    }

    fn relay(&self, _ticket: RelayTicket) -> Box<dyn Relay + Send> {
        unreachable!("the fake hub gives no ticket")
    }
}

struct World {
    store: Arc<MemoryStore>,
    views: Arc<Views>,
    http: Arc<FakeHttp>,
    backend: Arc<FakeBackend>,
    connector: Arc<FakeConnector>,
    hub: Arc<FakeHub>,
    engine: Engine,
}

fn world_with(store: Arc<MemoryStore>) -> World {
    let views = Arc::new(Views::default());
    let http = Arc::new(FakeHttp::default());
    let backend = Arc::new(FakeBackend::default());
    let hub = Arc::new(FakeHub::default());
    let connector = Arc::new(FakeConnector {
        hub: hub.clone(),
        events: Mutex::new(None),
        connects: AtomicU32::new(0),
    });
    let clock = Arc::new(AtomicU64::new(1_000));
    let now = clock.clone();
    let session = Arc::new(Session::new(
        "https://runovahq.test",
        http.clone(),
        Arc::new(SecureTokens(store.clone())),
        Box::new(move || now.load(Ordering::SeqCst)),
    ));
    let engine = Engine::start(Dependencies {
        refresh_every: std::time::Duration::from_secs(3600),
        feed: Arc::new(runova_ffi::notifications::NoFeed),
        site: "https://runovahq.test".into(),
        platform: "android".into(),
        app_version: "1.0.0".into(),
        secure: store.clone(),
        listener: views.clone(),
        session,
        backend: backend.clone(),
        hub: connector.clone(),
        transports: Arc::new(NoTransports),
    });
    World {
        store,
        views,
        http,
        backend,
        connector,
        hub,
        engine,
    }
}

fn world() -> World {
    world_with(Arc::new(MemoryStore::default()))
}

async fn until(world: &World, check: impl Fn(&AppView) -> bool, label: &str) -> AppView {
    for _ in 0..500 {
        if let Some(view) = world.views.0.lock().unwrap().last().cloned()
            && check(&view)
        {
            return view;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!(
        "timed out waiting for {label}; last view: {:?}",
        world.views.0.lock().unwrap().last()
    );
}

async fn signed_in(world: &World) {
    until(world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    world.http.replies.lock().unwrap().push_back(tokens());
    let link = world.engine.begin_sign_in("Runova app".into());
    world.engine.finish_sign_in(format!(
        "com.runovahq.app:/auth/callback?code=c&state={}",
        link.state
    ));
    until(world, |v| v.auth == AuthState::SignedIn, "signed in").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_install_starts_signed_out() {
    let world = world();

    let view = until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;

    assert!(view.systems.is_empty());
    assert_eq!(world.connector.connects.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_in_registers_the_phone_and_lists_the_computers() {
    let world = world();
    world.backend.systems.lock().unwrap().push(desk());

    signed_in(&world).await;
    let view = until(&world, |v| !v.systems.is_empty(), "the computers").await;

    assert_eq!(view.systems[0].name, "Sam's desk");
    assert!(view.systems[0].online);
    assert!(view.systems[0].can_manage);
    let registered = world.backend.registered.lock().unwrap();
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0].platform, "android");
    assert_eq!(registered[0].identity_key.len(), 43);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_identity_survives_a_restart_so_approval_is_not_lost() {
    let store = Arc::new(MemoryStore::default());
    let first = world_with(store.clone());
    signed_in(&first).await;
    until(
        &first,
        |_| !first.backend.registered.lock().unwrap().is_empty(),
        "registered",
    )
    .await;
    let key = first.backend.registered.lock().unwrap()[0]
        .identity_key
        .clone();
    let device = first.backend.registered.lock().unwrap()[0]
        .device_id
        .clone();

    let second = world_with(store);
    until(
        &second,
        |v| v.auth == AuthState::SignedIn,
        "still signed in",
    )
    .await;
    until(
        &second,
        |_| !second.backend.registered.lock().unwrap().is_empty(),
        "registered",
    )
    .await;

    assert_eq!(
        second.backend.registered.lock().unwrap()[0].identity_key,
        key
    );
    assert_eq!(
        second.backend.registered.lock().unwrap()[0].device_id,
        device
    );
    assert!(!second.store.0.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn saying_no_in_the_browser_stays_signed_out_and_says_so() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    let link = world.engine.begin_sign_in("Runova app".into());

    world.engine.finish_sign_in(format!(
        "com.runovahq.app:/auth/callback?error=access_denied&state={}",
        link.state
    ));

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert_eq!(view.auth, AuthState::SignedOut);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_going_offline_updates_the_list() {
    let world = world();
    world.backend.systems.lock().unwrap().push(desk());
    signed_in(&world).await;
    until(&world, |v| !v.systems.is_empty(), "the computers").await;
    let events = world.connector.events.lock().unwrap().clone().unwrap();

    events
        .send(HubEvent::Presence {
            device_id: 5,
            online: false,
        })
        .await
        .unwrap();

    until(&world, |v| !v.systems[0].online, "offline").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_only_the_agent_is_keeping_online_can_not_be_managed() {
    let world = world();
    let mut agent = desk();
    agent.kind = "agent".into();
    world.backend.systems.lock().unwrap().push(agent);

    signed_in(&world).await;
    let view = until(&world, |v| !v.systems.is_empty(), "the computers").await;

    assert!(!view.systems[0].can_manage);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_connection_says_why_and_can_be_dismissed() {
    let world = world();
    world.backend.systems.lock().unwrap().push(desk());
    signed_in(&world).await;
    until(&world, |v| !v.systems.is_empty(), "the computers").await;

    world.engine.connect(5);
    let view = until(
        &world,
        |v| {
            v.connection
                .as_ref()
                .is_some_and(|c| c.phase == ConnectionPhase::Failed)
        },
        "the failure",
    )
    .await;

    assert_eq!(
        view.connection.unwrap().error.as_deref(),
        Some("This computer is offline.")
    );
    world.engine.disconnect();
    until(&world, |v| v.connection.is_none(), "dismissed").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn while_waiting_the_phone_shows_it_is_waiting_for_approval() {
    let world = world();
    world.backend.systems.lock().unwrap().push(desk());
    *world.hub.outcome.lock().unwrap() = Some(ConnectResult {
        status: "ringing".into(),
        session_id: Some("s1".into()),
        host: Some(HostInfo {
            name: "Sam's desk".into(),
            identity_key: "k".into(),
            kind: runova_session::hub::HostKind::App,
        }),
    });
    signed_in(&world).await;
    until(&world, |v| !v.systems.is_empty(), "the computers").await;

    world.engine.connect(5);
    let view = until(
        &world,
        |v| {
            v.connection
                .as_ref()
                .is_some_and(|c| c.phase == ConnectionPhase::WaitingForApproval)
        },
        "waiting",
    )
    .await;

    assert_eq!(view.connection.unwrap().system_name, "Sam's desk");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_the_server_ended_signs_the_phone_out() {
    let world = world();
    signed_in(&world).await;
    *world.backend.fail_directory.lock().unwrap() = Some(BackendError::SignedOut);

    world.engine.refresh();

    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
}

#[test]
fn a_phones_code_is_the_start_of_its_keys_hash() {
    // The same key and the same answer as fingerprint.test.ts on the desktop.
    assert_eq!(runova_ffi::secure::key_fingerprint(&[7; 32]), "4BB0 6F8E");
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_forgets_the_tokens_and_the_phones_identity() {
    let world = world();
    signed_in(&world).await;

    world.engine.sign_out();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;

    let stored = world.store.0.lock().unwrap();
    assert!(!stored.contains_key("tokens"));
    assert!(!stored.contains_key("identity-seed"));
}

#[tokio::test(flavor = "multi_thread")]
async fn going_to_the_background_lets_go_of_the_hub_and_coming_back_reconnects() {
    let world = world();
    signed_in(&world).await;
    until(
        &world,
        |_| world.connector.connects.load(Ordering::SeqCst) == 1,
        "the hub",
    )
    .await;

    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 0 });
    until(&world, |v| !v.hub_connected, "let go").await;
    world.engine.lifecycle(AppLifecycle::Foregrounded);

    until(&world, |v| v.hub_connected, "reconnected").await;
    assert_eq!(world.connector.connects.load(Ordering::SeqCst), 2);
}
