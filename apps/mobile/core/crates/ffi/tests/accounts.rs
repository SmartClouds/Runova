//! Several accounts on one phone (E118): adding, switching, signing out of one or all, a session
//! that ended, and push for every account. The server is faked per access token, so each check
//! also shows which account's tokens were used.

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::Session;
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use runova_ffi::accounts::push_account_label;
use runova_ffi::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use runova_ffi::engine::{Dependencies, Engine, HubConnector};
use runova_ffi::secure::{AccountTokens, SecureStore};
use runova_ffi::view::ViewListener;
use runova_ffi::view::{AppView, AuthState};
use runova_session::hub::{ConnectResult, HubEvent, HubPort, RelayTicket};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

const WORK: &str = "sam@work.test";
const HOME: &str = "sam@home.test";
const PUSH: &str = "/api/v1/accounts/me/push-devices/current";
const CURRENT: &str = "/api/v1/sessions/current";

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);

impl MemoryStore {
    fn has(&self, key: &str) -> bool {
        self.0.lock().unwrap().contains_key(key)
    }

    fn json(&self, key: &str) -> Option<Value> {
        self.get(key.to_owned())
            .map(|text| serde_json::from_str(&text).unwrap())
    }

    fn keys(&self) -> Vec<String> {
        self.0.lock().unwrap().keys().cloned().collect()
    }
}

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

/// The token endpoint: each sign-in takes the next queued pair.
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

fn tokens(number: u32) -> HttpReply {
    HttpReply {
        status: 200,
        body: json!({
            "accessToken": format!("rd1.{number}"),
            "refreshToken": format!("rr1.{number}"),
            "expiresIn": 900,
            "sessionId": number,
        })
        .to_string(),
    }
}

/// The website, answering for whichever account's token the call carries.
#[derive(Default)]
struct FakeBackend {
    session: OnceLock<Arc<Session>>,
    /// Access token to the account it belongs to.
    me: Mutex<HashMap<String, Value>>,
    /// Access tokens the website no longer takes.
    ended: Mutex<HashSet<String>>,
    /// (token, method, path, body) for every change.
    calls: Mutex<Vec<(String, String, String, Value)>>,
    /// Access tokens whose directory answers late.
    slow: Mutex<HashSet<String>>,
}

impl FakeBackend {
    async fn token(&self) -> Result<String, BackendError> {
        let token = self
            .session
            .get()
            .unwrap()
            .access_token()
            .await
            .map_err(|_| BackendError::SignedOut)?;
        if self.ended.lock().unwrap().contains(&token) {
            return Err(BackendError::SignedOut);
        }
        Ok(token)
    }

    fn calls(&self) -> Vec<(String, String, String, Value)> {
        self.calls.lock().unwrap().clone()
    }

    fn calls_to(&self, path: &str) -> Vec<(String, String, Value)> {
        self.calls()
            .into_iter()
            .filter(|(_, _, p, _)| p == path)
            .map(|(token, method, _, body)| (token, method, body))
            .collect()
    }
}

#[async_trait]
impl Backend for FakeBackend {
    async fn register_phone(&self, _phone: PhoneRegistration) -> Result<i64, BackendError> {
        self.token().await?;
        Ok(77)
    }

    async fn systems(&self) -> Result<Vec<SystemEntry>, BackendError> {
        let token = self.token().await?;
        if self.slow.lock().unwrap().contains(&token) {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Ok(vec![SystemEntry {
            id: 5,
            remote_id: "111222333".into(),
            name: format!("Desk of {token}"),
            platform: "windows".into(),
            kind: "app".into(),
            online: true,
            own: true,
            unattended: false,
            features: None,
        }])
    }

    async fn get_json(&self, path: &str) -> Result<Value, BackendError> {
        let token = self.token().await?;
        match path {
            "/api/v1/accounts/me" => self
                .me
                .lock()
                .unwrap()
                .get(&token)
                .cloned()
                .ok_or_else(|| BackendError::Failed("no account".into())),
            _ => Err(BackendError::Failed(format!("nothing at {path}"))),
        }
    }

    async fn send_json(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, BackendError> {
        let token = self.token().await?;
        self.send_json_as(&token, method, path, body).await
    }

    async fn send_json_as(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<Value, BackendError> {
        if self.ended.lock().unwrap().contains(token) {
            return Err(BackendError::SignedOut);
        }
        self.calls.lock().unwrap().push((
            token.to_owned(),
            method.to_owned(),
            path.to_owned(),
            body,
        ));
        Ok(Value::Null)
    }
}

struct NoHub;

#[async_trait]
impl HubPort for NoHub {
    async fn request_connect(
        &self,
        _: &str,
        _: i64,
        _: runova_session::hub::Intent,
        _: runova_session::hub::AccessMode,
    ) -> Result<ConnectResult, String> {
        Err("not here".into())
    }

    async fn signal(&self, _: &str, _: &str) {}

    async fn relay_ticket(&self, _: &str) -> Result<RelayTicket, String> {
        Err("no relay".into())
    }

    async fn end(&self, _: &str) {}
}

/// Remembers the token each hub connection was opened with.
#[derive(Default)]
struct FakeConnector {
    tokens: Mutex<Vec<String>>,
    open: Mutex<Vec<mpsc::Sender<HubEvent>>>,
}

#[async_trait]
impl HubConnector for FakeConnector {
    async fn connect(
        &self,
        token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String> {
        self.tokens.lock().unwrap().push(token);
        let (sender, receiver) = mpsc::channel(8);
        self.open.lock().unwrap().push(sender);
        Ok((Arc::new(NoHub), receiver))
    }
}

struct NoTransports;

impl runova_session::connect::Transports for NoTransports {
    fn direct(
        &self,
        _signals: mpsc::Sender<String>,
    ) -> Arc<dyn runova_session::connect::DirectLink> {
        unreachable!("no computer is connected in these tests")
    }

    fn relay(&self, _ticket: RelayTicket) -> Box<dyn runova_link::opener::Relay + Send> {
        unreachable!("no computer is connected in these tests")
    }
}

struct World {
    store: Arc<MemoryStore>,
    views: Arc<Views>,
    http: Arc<FakeHttp>,
    backend: Arc<FakeBackend>,
    connector: Arc<FakeConnector>,
    engine: Engine,
}

impl World {
    fn latest(&self) -> AppView {
        self.views
            .0
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a view")
    }

    async fn until(&self, check: impl Fn(&AppView) -> bool, label: &str) -> AppView {
        for _ in 0..600 {
            if let Some(view) = self.views.0.lock().unwrap().last().cloned()
                && check(&view)
            {
                return view;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!(
            "timed out waiting for {label}; last view: {:?}",
            self.views
                .0
                .lock()
                .unwrap()
                .last()
                .map(|v| (&v.auth, &v.accounts, &v.notice))
        );
    }

    /// Signs in through the browser, as the account the website gives `number`'s tokens to.
    async fn sign_in(&self, number: u32) {
        self.http.replies.lock().unwrap().push_back(tokens(number));
        let link = self.engine.begin_sign_in("Runova app".into());
        self.engine.finish_sign_in(format!(
            "com.runovahq.app:/auth/callback?code=c{number}&state={}",
            link.state
        ));
    }

    fn active(&self) -> Option<i64> {
        self.store
            .json("accounts")
            .and_then(|index| index["active"].as_i64())
    }

    fn tag_of(&self, id: i64) -> String {
        let index = self.store.json("accounts").unwrap();
        index["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()["tag"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn hub_tokens(&self) -> Vec<String> {
        self.connector.tokens.lock().unwrap().clone()
    }
}

fn world_with(store: Arc<MemoryStore>) -> World {
    let views = Arc::new(Views::default());
    let http = Arc::new(FakeHttp::default());
    let backend = Arc::new(FakeBackend::default());
    backend.me.lock().unwrap().extend([
        (
            "rd1.1".to_owned(),
            json!({"id": 11, "email": WORK, "displayName": "Sam Rivera"}),
        ),
        (
            "rd1.2".to_owned(),
            json!({"id": 22, "email": HOME, "displayName": "sam"}),
        ),
        // The work account again, from a second sign-in.
        (
            "rd1.3".to_owned(),
            json!({"id": 11, "email": WORK, "displayName": "Sam Rivera"}),
        ),
    ]);
    let connector = Arc::new(FakeConnector::default());
    let tokens = AccountTokens::new(store.clone());
    let session = Arc::new(Session::new(
        "https://runovahq.test",
        http.clone(),
        tokens.clone(),
        Box::new(|| 1_000),
    ));
    let _ = backend.session.set(session.clone());
    let engine = Engine::start(Dependencies {
        refresh_every: Duration::from_secs(3600),
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
        engine,
    }
}

fn phone_store() -> Arc<MemoryStore> {
    let store = Arc::new(MemoryStore::default());
    store.set("identity-seed".into(), URL_SAFE_NO_PAD.encode([2u8; 32]));
    store
}

fn in_use(view: &AppView, email: &str) -> bool {
    view.auth == AuthState::SignedIn
        && view.accounts.switching.is_none()
        && view
            .accounts
            .items
            .iter()
            .any(|item| item.active && item.email == email)
        && !view.systems_loading
        && !view.systems.is_empty()
}

/// Signed in to the work account, then the home account added and in use.
async fn two_accounts() -> World {
    let world = world_with(phone_store());
    world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;
    world.sign_in(1).await;
    world.until(|v| in_use(v, WORK), "the work account").await;
    world.engine.add_account();
    world.until(|v| v.accounts.adding, "adding").await;
    world.sign_in(2).await;
    world.until(|v| in_use(v, HOME), "the home account").await;
    world
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_sign_in_becomes_the_phone_s_first_account() {
    let world = world_with(phone_store());
    world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;

    world.sign_in(1).await;
    let view = world.until(|v| in_use(v, WORK), "the work account").await;

    let item = &view.accounts.items[0];
    assert_eq!(view.accounts.items.len(), 1);
    assert_eq!((item.id, item.name.as_str()), (11, "Sam Rivera"));
    assert_eq!(item.initials, "SR");
    assert!(!item.needs_sign_in);
    assert_eq!(world.active(), Some(11));
    assert!(world.store.has("tokens:11"));
    assert!(!world.store.has("tokens:pending"));
    assert!(!world.store.has("tokens"));
    assert_eq!(view.notice, None, "nothing to say about a first account");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_signed_in_before_this_update_keeps_its_account() {
    let store = phone_store();
    store.set(
        "tokens".into(),
        json!({"access_token": "rd1.1", "refresh_token": "rr1.1", "expires_at": 4_000_000_000u64, "session_id": 1})
            .to_string(),
    );

    let world = world_with(store);
    world.until(|v| in_use(v, WORK), "the work account").await;

    assert!(!world.store.has("tokens"));
    assert!(world.store.has("tokens:11"));
    assert_eq!(world.active(), Some(11));
    assert_eq!(world.hub_tokens(), vec!["rd1.1".to_owned()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn adding_an_account_keeps_the_first_one_until_the_second_signs_in() {
    let world = world_with(phone_store());
    world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;
    world.sign_in(1).await;
    world.until(|v| in_use(v, WORK), "the work account").await;

    world.engine.add_account();
    let adding = world.until(|v| v.accounts.adding, "adding").await;
    assert_eq!(adding.auth, AuthState::SignedIn);
    assert!(adding.hub_connected, "the work account stays connected");

    world.sign_in(2).await;
    let view = world.until(|v| in_use(v, HOME), "the home account").await;

    assert!(!view.accounts.adding);
    assert_eq!(view.accounts.items.len(), 2);
    assert_eq!(view.notice.as_deref(), Some("Added sam@home.test."));
    assert_eq!(world.active(), Some(22));
    assert_eq!(
        world.hub_tokens(),
        vec!["rd1.1".to_owned(), "rd1.2".to_owned()]
    );
    let work: Value = world.store.json("tokens:11").unwrap();
    assert_eq!(work["access_token"], "rd1.1");
    assert_ne!(world.tag_of(11), world.tag_of(22));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_an_add_leaves_everything_as_it_was() {
    let world = world_with(phone_store());
    world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;
    world.sign_in(1).await;
    world.until(|v| in_use(v, WORK), "the work account").await;
    world.engine.add_account();
    world.until(|v| v.accounts.adding, "adding").await;

    world.engine.cancel_add_account();
    let view = world.until(|v| !v.accounts.adding, "back").await;

    assert!(in_use(&view, WORK));
    assert_eq!(view.accounts.items.len(), 1);
    assert_eq!(world.hub_tokens().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn switching_uses_the_other_account_s_tokens_and_starts_its_screens_afresh() {
    let world = two_accounts().await;
    let seed = world.store.get("identity-seed".into());

    world.engine.switch_account(11);
    let view = world.until(|v| in_use(v, WORK), "back to work").await;

    assert_eq!(world.hub_tokens().last().unwrap(), "rd1.1");
    assert_eq!(view.systems[0].name, "Desk of rd1.1");
    assert_eq!(view.notice.as_deref(), Some("Now using sam@work.test."));
    assert_eq!(world.active(), Some(11));
    assert_eq!(world.store.get("identity-seed".into()), seed);
    assert!(
        world.store.has("tokens:22"),
        "the home account stays signed in"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn while_switching_the_phone_shows_who_it_is_switching_to() {
    let world = two_accounts().await;
    world.backend.slow.lock().unwrap().insert("rd1.1".into());

    world.engine.switch_account(11);
    let view = world
        .until(|v| v.accounts.switching.is_some(), "switching")
        .await;

    assert_eq!(view.accounts.switching.as_ref().unwrap().email, WORK);
    world.until(|v| in_use(v, WORK), "back to work").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_answer_for_the_account_left_behind_counts_for_nothing() {
    let world = two_accounts().await;
    world.backend.slow.lock().unwrap().insert("rd1.1".into());

    world.engine.switch_account(11);
    world
        .until(|v| v.accounts.switching.is_some(), "switching")
        .await;
    world.engine.switch_account(22);
    world.until(|v| in_use(v, HOME), "home again").await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    let view = world.latest();
    assert!(in_use(&view, HOME));
    assert_eq!(view.systems[0].name, "Desk of rd1.2");
    assert_eq!(world.active(), Some(22));
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_of_an_account_not_in_use_ends_its_own_session_only() {
    let world = two_accounts().await;

    world.engine.sign_out_account(11);
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert_eq!(asked.confirm.unwrap().action, "Sign out");
    world.engine.confirm();
    let view = world
        .until(|v| v.accounts.items.len() == 1, "one account left")
        .await;

    assert!(in_use(&view, HOME));
    assert_eq!(
        world.backend.calls_to(CURRENT),
        vec![("rd1.1".to_owned(), "DELETE".to_owned(), json!({}))]
    );
    assert!(!world.store.has("tokens:11"));
    assert_eq!(
        world.hub_tokens().len(),
        2,
        "the home account was not touched"
    );
    assert_eq!(view.notice.as_deref(), Some("Signed out of sam@work.test."));
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_of_the_account_in_use_moves_to_the_other_one() {
    let world = two_accounts().await;

    world.engine.sign_out();
    let view = world.until(|v| in_use(v, WORK), "the work account").await;

    assert_eq!(view.accounts.items.len(), 1);
    assert_eq!(
        world.backend.calls_to(CURRENT),
        vec![("rd1.2".to_owned(), "DELETE".to_owned(), json!({}))]
    );
    assert!(!world.store.has("tokens:22"));
    assert!(
        world.store.has("identity-seed"),
        "the phone keeps its identity"
    );
    assert_eq!(world.active(), Some(11));
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_of_the_only_account_left_clears_the_phone() {
    let world = two_accounts().await;
    world.engine.sign_out();
    world.until(|v| in_use(v, WORK), "the work account").await;

    world.engine.sign_out();
    let view = world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;

    assert!(view.accounts.items.is_empty());
    assert!(!world.store.has("identity-seed"));
    assert!(!world.store.has("accounts"));
    assert!(
        world.store.keys().iter().all(|k| !k.starts_with("tokens")),
        "{:?}",
        world.store.keys()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_of_every_account_ends_each_session_and_clears_the_phone() {
    let world = two_accounts().await;

    world.engine.sign_out_all();
    let asked = world.until(|v| v.confirm.is_some(), "the question").await;
    assert!(asked.confirm.as_ref().unwrap().danger);
    world.engine.confirm();
    let view = world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;

    let mut ended: Vec<String> = world
        .backend
        .calls_to(CURRENT)
        .into_iter()
        .map(|(token, _, _)| token)
        .collect();
    ended.sort();
    assert_eq!(ended, vec!["rd1.1".to_owned(), "rd1.2".to_owned()]);
    assert!(view.accounts.items.is_empty());
    assert!(!world.store.has("identity-seed"));
    assert!(world.store.keys().iter().all(|k| !k.starts_with("tokens")));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_whose_session_ended_asks_to_be_signed_in_again() {
    let world = two_accounts().await;
    world.backend.ended.lock().unwrap().insert("rd1.2".into());

    world.engine.refresh();
    let view = world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;

    assert_eq!(view.accounts.reauth.as_ref().unwrap().email, HOME);
    let home = view.accounts.items.iter().find(|i| i.id == 22).unwrap();
    assert!(home.needs_sign_in);
    assert!(
        world.store.has("tokens:11"),
        "the work account is still there"
    );

    world.engine.switch_account(11);
    let back = world.until(|v| in_use(v, WORK), "the work account").await;
    assert!(back.accounts.reauth.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_in_again_to_an_account_already_on_the_phone_replaces_its_tokens() {
    let world = two_accounts().await;

    world.engine.add_account();
    world.until(|v| v.accounts.adding, "adding").await;
    world.sign_in(3).await;
    let view = world.until(|v| in_use(v, WORK), "the work account").await;

    assert_eq!(view.accounts.items.len(), 2);
    assert_eq!(
        view.notice.as_deref(),
        Some("You were already signed in to sam@work.test.")
    );
    let work: Value = world.store.json("tokens:11").unwrap();
    assert_eq!(work["access_token"], "rd1.3");
}

#[tokio::test(flavor = "multi_thread")]
async fn adding_waits_until_the_account_in_use_is_known() {
    let store = phone_store();
    store.set(
        "tokens".into(),
        json!({"access_token": "rd1.9", "refresh_token": "rr1.9", "expires_at": 4_000_000_000u64, "session_id": 9})
            .to_string(),
    );
    let world = world_with(store);
    world
        .until(
            |v| v.auth == AuthState::SignedIn && !v.systems.is_empty(),
            "signed in",
        )
        .await;

    world.engine.add_account();
    let view = world.until(|v| v.notice.is_some(), "a notice").await;

    assert!(!view.accounts.adding);
    assert!(world.store.has("tokens:pending"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_push_token_reaches_the_server_for_every_account_with_its_own_tag() {
    let world = two_accounts().await;

    world.engine.register_push_token("fcm-1".into());
    for _ in 0..200 {
        if world.backend.calls_to(PUSH).len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let mut sent: Vec<(String, Value)> = world
        .backend
        .calls_to(PUSH)
        .into_iter()
        .map(|(token, _, body)| (token, body))
        .collect();
    sent.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(sent.len(), 2, "{sent:?}");
    assert_eq!(sent[0].0, "rd1.1");
    assert_eq!(sent[0].1["pushToken"], "fcm-1");
    assert_eq!(sent[0].1["accountTag"], world.tag_of(11).as_str());
    assert_eq!(sent[1].0, "rd1.2");
    assert_eq!(sent[1].1["accountTag"], world.tag_of(22).as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_push_token_is_not_sent_again_for_an_account_that_has_it() {
    let world = two_accounts().await;
    world.engine.register_push_token("fcm-1".into());
    for _ in 0..200 {
        if world.backend.calls_to(PUSH).len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    world.engine.switch_account(11);
    world.until(|v| in_use(v, WORK), "the work account").await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let for_work = world
        .backend
        .calls_to(PUSH)
        .into_iter()
        .filter(|(token, _, _)| token == "rd1.1")
        .count();
    // The active account's start sends it again, which is cheap and keeps the row fresh; the
    // account in the background is never sent it twice for the same token.
    assert!(for_work <= 2, "sent {for_work} times");
    let for_home = world
        .backend
        .calls_to(PUSH)
        .into_iter()
        .filter(|(token, _, _)| token == "rd1.2")
        .count();
    assert_eq!(for_home, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tapped_push_for_another_account_switches_to_it() {
    let world = two_accounts().await;
    let work = world.tag_of(11);

    world
        .engine
        .notification_tapped(Some(5), "monitors".into(), None, Some(work));

    world.until(|v| in_use(v, WORK), "the work account").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tapped_push_for_the_account_in_use_stays_put() {
    let world = two_accounts().await;
    let home = world.tag_of(22);

    world
        .engine
        .notification_tapped(Some(5), "monitors".into(), None, Some(home));
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(in_use(&world.latest(), HOME));
    assert_eq!(world.hub_tokens().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_account_has_its_initials_and_a_steady_colour() {
    let world = two_accounts().await;
    let view = world.latest();

    let work = view.accounts.items.iter().find(|i| i.id == 11).unwrap();
    let home = view.accounts.items.iter().find(|i| i.id == 22).unwrap();
    assert_eq!(work.initials, "SR");
    assert_eq!(home.initials, "S");
    assert!(work.tone < 6 && home.tone < 6);
    assert_ne!(work.tone, home.tone);
    assert_eq!(
        view.accounts.items[0].id, 11,
        "kept in the order they were added"
    );
    assert_eq!(view.accounts.push_labels.len(), 2);
}

#[test]
fn a_push_names_its_account_only_when_the_phone_holds_more_than_one() {
    let two = json!({
        "active": 22,
        "items": [
            {"id": 11, "email": WORK, "name": "Sam Rivera", "tag": "work-tag-123", "added_ms": 1, "used_ms": 1, "push_sent": null, "signed_out": false},
            {"id": 22, "email": HOME, "name": "sam", "tag": "home-tag-456", "added_ms": 2, "used_ms": 2, "push_sent": null, "signed_out": false},
        ]
    })
    .to_string();
    let one = json!({
        "active": 11,
        "items": [
            {"id": 11, "email": WORK, "name": "Sam Rivera", "tag": "work-tag-123", "added_ms": 1, "used_ms": 1, "push_sent": null, "signed_out": false},
        ]
    })
    .to_string();

    assert_eq!(
        push_account_label(Some(two.clone()), Some("work-tag-123".into())),
        Some(WORK.to_owned())
    );
    assert_eq!(
        push_account_label(Some(one), Some("work-tag-123".into())),
        None
    );
    assert_eq!(push_account_label(Some(two.clone()), None), None);
    assert_eq!(
        push_account_label(Some(two), Some("someone-else".into())),
        None
    );
    assert_eq!(push_account_label(None, Some("work-tag-123".into())), None);
}
