//! The app's behavior as native code sees it, with the server and the computer faked.

use async_trait::async_trait;
use runova_api::auth::Session;
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use runova_ffi::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use runova_ffi::engine::{AppLifecycle, Dependencies, Engine, HubConnector};
use runova_ffi::secure::{AccountTokens, SecureStore};
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
        features: Some(vec!["receive-files".into()]),
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
    let tokens = AccountTokens::new(store.clone());
    let session = Arc::new(Session::new(
        "https://runovahq.test",
        http.clone(),
        tokens.clone(),
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
        tokens,
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

fn reply(status: u16, body: Value) -> HttpReply {
    HttpReply {
        status,
        body: body.to_string(),
    }
}

const QR: &str = "rq1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

#[tokio::test(flavor = "multi_thread")]
async fn a_scanned_and_approved_qr_code_signs_in() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    {
        let mut replies = world.http.replies.lock().unwrap();
        replies.push_back(reply(200, json!({ "matchCode": "0420" })));
        replies.push_back(reply(200, json!({ "status": "approved", "code": "c" })));
        replies.push_back(tokens());
    }

    world.engine.scan_sign_in(QR.into());

    let view = until(&world, |v| v.auth == AuthState::SignedIn, "signed in").await;
    assert_eq!(view.qr_sign_in, None);
    until(&world, |v| !v.systems_loading, "the first load").await;
    assert_eq!(world.connector.connects.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_digits_show_while_waiting_and_cancelling_stops() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    {
        let mut replies = world.http.replies.lock().unwrap();
        replies.push_back(reply(200, json!({ "matchCode": "0420" })));
        replies.push_back(reply(200, json!({ "status": "waiting", "code": null })));
    }

    world.engine.scan_sign_in(QR.into());
    let view = until(
        &world,
        |v| {
            v.qr_sign_in
                .as_ref()
                .is_some_and(|q| q.match_code.is_some())
        },
        "the digits",
    )
    .await;
    assert_eq!(view.qr_sign_in.unwrap().match_code.as_deref(), Some("0420"));

    world.engine.cancel_qr_sign_in();
    let view = until(&world, |v| v.qr_sign_in.is_none(), "cancelled").await;
    assert_eq!(view.auth, AuthState::SignedOut);
    assert_eq!(view.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stray_qr_code_says_so_and_asks_nothing() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;

    world.engine.scan_sign_in("https://example.com".into());

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert_eq!(
        view.error.as_deref(),
        Some("That isn't a Runova sign-in code.")
    );
    assert_eq!(view.qr_sign_in, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_used_qr_code_says_so() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(reply(401, json!({})));

    world.engine.scan_sign_in(QR.into());

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("no longer valid"));
    assert_eq!(view.qr_sign_in, None);
    assert_eq!(view.auth, AuthState::SignedOut);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_qr_code_stays_signed_out_and_says_so() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    {
        let mut replies = world.http.replies.lock().unwrap();
        replies.push_back(reply(200, json!({ "matchCode": "0420" })));
        replies.push_back(reply(200, json!({ "status": "declined", "code": null })));
    }

    world.engine.scan_sign_in(QR.into());

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("declined"));
    assert_eq!(view.auth, AuthState::SignedOut);
}

// Passkey sign-in (E115): the core asks for the challenge and shows it in the view, the platform's
// prompt answers it, and the core trades the answer for tokens.

fn passkey_challenge() -> HttpReply {
    reply(
        201,
        json!({
            "id": "challenge-1",
            "options": { "challenge": "AQID", "rpId": "runovahq.com" },
            "expiresAt": "2026-11-19T10:05:00Z",
        }),
    )
}

async fn passkey_prompt(world: &World) -> runova_ffi::view::PasskeySignInView {
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(passkey_challenge());
    world.engine.begin_passkey_sign_in();
    until(
        world,
        |v| {
            v.passkey_sign_in
                .as_ref()
                .is_some_and(|p| p.options_json.is_some())
        },
        "the passkey prompt",
    )
    .await
    .passkey_sign_in
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_passkey_answer_signs_in_with_no_code() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    let prompt = passkey_prompt(&world).await;
    assert_eq!(prompt.challenge_id, "challenge-1");
    let options: Value = serde_json::from_str(prompt.options_json.as_deref().unwrap()).unwrap();
    assert_eq!(options["rpId"], "runovahq.com");
    world.http.replies.lock().unwrap().push_back(tokens());

    world
        .engine
        .finish_passkey_sign_in(prompt.challenge_id, r#"{"id":"AQI","rawId":"AQI"}"#.into());

    let view = until(&world, |v| v.auth == AuthState::SignedIn, "signed in").await;
    assert_eq!(view.passkey_sign_in, None);
    assert_eq!(view.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_passkey_stays_signed_out_and_says_so() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    let prompt = passkey_prompt(&world).await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(reply(401, json!({})));

    world
        .engine
        .finish_passkey_sign_in(prompt.challenge_id, r#"{"id":"AQI"}"#.into());

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("wasn't accepted"));
    assert_eq!(view.passkey_sign_in, None);
    assert_eq!(view.auth, AuthState::SignedOut);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_the_passkey_prompt_says_nothing() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    passkey_prompt(&world).await;

    world.engine.cancel_passkey_sign_in(false);

    let view = until(&world, |v| v.passkey_sign_in.is_none(), "cancelled").await;
    assert_eq!(view.error, None);
    assert_eq!(view.auth, AuthState::SignedOut);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_with_no_passkey_for_runova_says_how_to_get_one() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    passkey_prompt(&world).await;

    world.engine.cancel_passkey_sign_in(true);

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("Security page"));
    assert_eq!(view.passkey_sign_in, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_challenge_means_no_prompt_and_a_message() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(reply(503, json!({})));

    world.engine.begin_passkey_sign_in();

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("Couldn't start"));
    assert_eq!(view.passkey_sign_in, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_to_an_old_prompt_counts_for_nothing() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    passkey_prompt(&world).await;

    world
        .engine
        .finish_passkey_sign_in("some-other-challenge".into(), r#"{"id":"AQI"}"#.into());

    let view = until(&world, |v| v.passkey_sign_in.is_none(), "dropped").await;
    assert_eq!(view.auth, AuthState::SignedOut);
    assert!(world.http.replies.lock().unwrap().is_empty());
}

// Google's and Apple's own sheets (E117): the core asks for a nonce and shows it in the view, the
// sheet answers with an ID token, and the core trades it for tokens.

fn nonce(client_id: Option<&str>) -> HttpReply {
    reply(
        201,
        json!({ "nonce": "nonce-1", "expiresAt": "2026-11-19T10:05:00Z", "clientId": client_id }),
    )
}

fn problem(status: u16, slug: &str) -> HttpReply {
    reply(
        status,
        json!({ "type": format!("https://runovahq.com/problems/{slug}"), "title": "no" }),
    )
}

async fn provider_sheet(
    world: &World,
    provider: &str,
    client_id: Option<&str>,
) -> runova_ffi::view::ProviderSignInView {
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(nonce(client_id));
    world.engine.begin_provider_sign_in(provider.into());
    until(
        world,
        |v| {
            v.provider_sign_in
                .as_ref()
                .is_some_and(|p| p.nonce.is_some())
        },
        "the sheet",
    )
    .await
    .provider_sign_in
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_from_google_s_sheet_signs_in() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    let sheet = provider_sheet(&world, "google", Some("web.apps.googleusercontent.com")).await;
    assert_eq!(sheet.provider, "google");
    assert_eq!(
        sheet.client_id.as_deref(),
        Some("web.apps.googleusercontent.com")
    );
    world.http.replies.lock().unwrap().push_back(tokens());

    world
        .engine
        .finish_provider_sign_in("nonce-1".into(), "eyJ".into(), None, None);

    let view = until(&world, |v| v.auth == AuthState::SignedIn, "signed in").await;
    assert_eq!(view.provider_sign_in, None);
    assert_eq!(view.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_with_that_email_is_told_to_link_the_provider_on_the_website() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    provider_sheet(&world, "apple", None).await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(problem(409, "conflict"));

    world.engine.finish_provider_sign_in(
        "nonce-1".into(),
        "eyJ".into(),
        Some("code".into()),
        Some("Sam".into()),
    );

    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("link Apple under Security"));
    assert_eq!(view.auth, AuthState::SignedOut);
    assert_eq!(view.provider_sign_in, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_step_sign_in_sends_the_person_on_to_the_browser_for_that_provider() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    provider_sheet(&world, "google", Some("web")).await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(problem(401, "two-factor-required"));

    world
        .engine
        .finish_provider_sign_in("nonce-1".into(), "eyJ".into(), None, None);

    let view = until(&world, |v| v.continue_in_browser.is_some(), "the browser").await;
    assert_eq!(view.continue_in_browser.as_deref(), Some("google"));
    assert!(view.error.unwrap().contains("browser"));

    // Starting again clears it, so the app opens the browser once per refusal.
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(nonce(Some("web")));
    world.engine.begin_provider_sign_in("google".into());
    let view = until(&world, |v| v.continue_in_browser.is_none(), "cleared").await;
    assert_eq!(view.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_token_says_so_and_closing_the_sheet_says_nothing() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    provider_sheet(&world, "google", Some("web")).await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(problem(401, "unauthorized"));
    world
        .engine
        .finish_provider_sign_in("nonce-1".into(), "eyJ".into(), None, None);
    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("wasn't accepted"));

    provider_sheet(&world, "google", Some("web")).await;
    world.engine.cancel_provider_sign_in();

    let view = until(&world, |v| v.provider_sign_in.is_none(), "cancelled").await;
    assert_eq!(view.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_provider_the_site_has_off_or_cannot_reach_gives_a_message_and_no_sheet() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(problem(404, "not-found"));
    world.engine.begin_provider_sign_in("apple".into());
    let view = until(&world, |v| v.error.is_some(), "the message").await;
    assert!(view.error.unwrap().contains("isn't available"));
    assert_eq!(view.provider_sign_in, None);

    world
        .http
        .replies
        .lock()
        .unwrap()
        .push_back(reply(503, json!({})));
    world.engine.begin_provider_sign_in("apple".into());
    let view = until(
        &world,
        |v| {
            v.error
                .as_deref()
                .is_some_and(|e| e.contains("Couldn't start"))
        },
        "the other message",
    )
    .await;
    assert!(view.error.unwrap().contains("with Apple"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_for_a_sheet_the_phone_moved_on_from_counts_for_nothing() {
    let world = world();
    until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    provider_sheet(&world, "google", Some("web")).await;

    world
        .engine
        .finish_provider_sign_in("some-other-nonce".into(), "eyJ".into(), None, None);

    let view = until(&world, |v| v.provider_sign_in.is_none(), "dropped").await;
    assert_eq!(view.auth, AuthState::SignedOut);
    assert!(world.http.replies.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_browser_sign_in_can_go_straight_to_a_provider() {
    let world = world();

    let link = world
        .engine
        .begin_sign_in_with_provider("Runova app".into(), "microsoft".into());

    assert!(link.url.contains("/account/authorize?"));
    assert!(link.url.ends_with("&provider=microsoft"));
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
            features: Some(Vec::new()),
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

#[tokio::test(flavor = "multi_thread")]
async fn the_intro_plays_once_and_stays_gone_after_a_restart() {
    let store = Arc::new(MemoryStore::default());
    let world = world_with(store.clone());

    let first = until(&world, |v| v.auth == AuthState::SignedOut, "signed out").await;
    assert!(first.show_intro);
    assert!(!first.app_version.is_empty());

    world.engine.intro_done();
    until(&world, |v| !v.show_intro, "intro finished").await;

    let again = world_with(store);
    let next = until(
        &again,
        |v| v.auth == AuthState::SignedOut,
        "signed out again",
    )
    .await;
    assert!(!next.show_intro);
}
