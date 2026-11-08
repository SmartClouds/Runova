//! Trading the code for tokens and keeping them fresh, against a recording fake of the server.

use async_trait::async_trait;
use runova_api::auth::{AuthError, Session, StoredTokens, TokenStore};
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct FakeHttp {
    replies: Mutex<VecDeque<Result<HttpReply, HttpError>>>,
    calls: Mutex<Vec<(String, Value)>>,
    delay: Mutex<Duration>,
}

impl FakeHttp {
    fn answer(&self, status: u16, body: Value) {
        self.replies.lock().unwrap().push_back(Ok(HttpReply {
            status,
            body: body.to_string(),
        }));
    }

    fn fail(&self) {
        self.replies
            .lock()
            .unwrap()
            .push_back(Err(HttpError("no network".into())));
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl HttpTransport for FakeHttp {
    async fn post_json(&self, url: &str, body: Value) -> Result<HttpReply, HttpError> {
        self.calls.lock().unwrap().push((url.to_owned(), body));
        let delay = *self.delay.lock().unwrap();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("a queued reply")
    }
}

#[derive(Default)]
struct MemoryStore {
    tokens: Mutex<Option<StoredTokens>>,
    saves: Mutex<u32>,
}

impl TokenStore for MemoryStore {
    fn load(&self) -> Option<StoredTokens> {
        self.tokens.lock().unwrap().clone()
    }

    fn save(&self, tokens: &StoredTokens) {
        *self.tokens.lock().unwrap() = Some(tokens.clone());
        *self.saves.lock().unwrap() += 1;
    }

    fn clear(&self) {
        *self.tokens.lock().unwrap() = None;
    }
}

struct World {
    http: Arc<FakeHttp>,
    store: Arc<MemoryStore>,
    now: Arc<AtomicU64>,
    session: Arc<Session>,
}

fn world() -> World {
    let http = Arc::new(FakeHttp::default());
    let store = Arc::new(MemoryStore::default());
    let now = Arc::new(AtomicU64::new(1_000));
    let clock = now.clone();
    let session = Arc::new(Session::new(
        "https://runovahq.com",
        http.clone(),
        store.clone(),
        Box::new(move || clock.load(Ordering::SeqCst)),
    ));
    World {
        http,
        store,
        now,
        session,
    }
}

fn tokens_body(number: u32) -> Value {
    json!({
        "accessToken": format!("rd1.access-{number}"),
        "refreshToken": format!("rr1.refresh-{number}"),
        "expiresIn": 900,
        "sessionId": 44,
        "account": {"email": "sam@example.com"},
    })
}

async fn signed_in(world: &World) {
    world.http.answer(200, tokens_body(1));
    world
        .session
        .complete_sign_in("code", "verifier")
        .await
        .unwrap();
}

#[tokio::test]
async fn signing_in_posts_the_code_and_saves_the_tokens() {
    let world = world();

    signed_in(&world).await;

    let (url, body) = world.http.calls().remove(0);
    assert_eq!(url, "https://runovahq.com/api/v1/device-tokens");
    assert_eq!(body["grantType"], "authorization_code");
    assert_eq!(body["code"], "code");
    assert_eq!(body["codeVerifier"], "verifier");
    assert_eq!(body["redirectUri"], "com.runovahq.app:/auth/callback");
    assert_eq!(world.store.load().unwrap().refresh_token, "rr1.refresh-1");
    assert_eq!(world.session.access_token().await.unwrap(), "rd1.access-1");
    assert_eq!(world.http.calls().len(), 1);
}

#[tokio::test]
async fn a_refused_code_is_an_error_and_saves_nothing() {
    let world = world();
    world.http.answer(401, json!({"title": "no"}));

    let result = world.session.complete_sign_in("code", "verifier").await;

    assert_eq!(result, Err(AuthError::SignedOut));
    assert!(world.store.load().is_none());
}

#[tokio::test]
async fn a_token_about_to_expire_is_refreshed_and_the_new_pair_saved() {
    let world = world();
    signed_in(&world).await;
    world.now.fetch_add(860, Ordering::SeqCst);
    world.http.answer(200, tokens_body(2));

    let token = world.session.access_token().await.unwrap();

    assert_eq!(token, "rd1.access-2");
    let (_, body) = world.http.calls().remove(1);
    assert_eq!(body["grantType"], "refresh_token");
    assert_eq!(body["refreshToken"], "rr1.refresh-1");
    assert_eq!(world.store.load().unwrap().refresh_token, "rr1.refresh-2");
}

#[tokio::test]
async fn two_callers_at_once_share_one_refresh() {
    let world = world();
    signed_in(&world).await;
    world.now.fetch_add(900, Ordering::SeqCst);
    world.http.answer(200, tokens_body(2));
    *world.http.delay.lock().unwrap() = Duration::from_millis(30);

    let one = world.session.clone();
    let two = world.session.clone();
    let (a, b) = tokio::join!(
        tokio::spawn(async move { one.access_token().await }),
        tokio::spawn(async move { two.access_token().await }),
    );

    assert_eq!(a.unwrap().unwrap(), "rd1.access-2");
    assert_eq!(b.unwrap().unwrap(), "rd1.access-2");
    assert_eq!(world.http.calls().len(), 2);
}

#[tokio::test]
async fn a_lost_answer_keeps_the_tokens_and_the_retry_sends_the_same_one() {
    let world = world();
    signed_in(&world).await;
    world.now.fetch_add(900, Ordering::SeqCst);
    world.http.fail();
    world.http.answer(200, tokens_body(2));

    let first = world.session.access_token().await;
    let second = world.session.access_token().await;

    assert!(matches!(first, Err(AuthError::Network(_))));
    assert_eq!(world.store.load().unwrap().refresh_token, "rr1.refresh-2");
    assert_eq!(second.unwrap(), "rd1.access-2");
    let calls = world.http.calls();
    assert_eq!(calls[1].1["refreshToken"], "rr1.refresh-1");
    assert_eq!(calls[2].1["refreshToken"], "rr1.refresh-1");
}

#[tokio::test]
async fn a_refused_refresh_signs_out_and_clears_the_tokens() {
    let world = world();
    signed_in(&world).await;
    world.now.fetch_add(900, Ordering::SeqCst);
    world.http.answer(401, json!({"title": "no longer valid"}));

    assert_eq!(
        world.session.access_token().await,
        Err(AuthError::SignedOut)
    );
    assert!(world.store.load().is_none());
    assert_eq!(
        world.session.access_token().await,
        Err(AuthError::SignedOut)
    );
    assert_eq!(world.http.calls().len(), 2);
}

#[tokio::test]
async fn a_server_error_during_refresh_keeps_the_session() {
    let world = world();
    signed_in(&world).await;
    world.now.fetch_add(900, Ordering::SeqCst);
    world.http.answer(503, json!({}));

    let result = world.session.access_token().await;

    assert!(matches!(result, Err(AuthError::Network(_))));
    assert!(world.store.load().is_some());
}

#[tokio::test]
async fn tokens_saved_earlier_are_used_after_a_restart() {
    let world = world();
    world.store.save(&StoredTokens {
        access_token: "rd1.old".into(),
        refresh_token: "rr1.old".into(),
        expires_at: 5_000,
        session_id: 9,
    });

    assert!(world.session.is_signed_in().await);
    assert_eq!(world.session.access_token().await.unwrap(), "rd1.old");
    assert!(world.http.calls().is_empty());
}

#[tokio::test]
async fn signing_out_forgets_the_tokens() {
    let world = world();
    signed_in(&world).await;

    world.session.sign_out().await;

    assert!(!world.session.is_signed_in().await);
    assert!(world.store.load().is_none());
}
