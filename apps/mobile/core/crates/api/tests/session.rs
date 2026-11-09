//! Trading the code for tokens and keeping them fresh, against a recording fake of the server.

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::{
    AuthError, DeviceInfo, QrPoll, Session, StoredTokens, TokenStore, read_qr_code,
};
use runova_api::http::{HttpError, HttpReply, HttpTransport};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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

const QR_CODE: &str = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

fn phone() -> DeviceInfo {
    DeviceInfo {
        device_id: "4b2c0c0e-1111-4222-8333-944444444444".into(),
        name: "Runova app".into(),
        platform: "android".into(),
        app_version: "3.4.0".into(),
    }
}

fn sevens(length: usize) -> Vec<u8> {
    vec![7; length]
}

#[test]
fn a_qr_code_is_read_only_when_it_is_ours() {
    assert_eq!(
        read_qr_code(&format!("rq1.{QR_CODE}")).as_deref(),
        Some(QR_CODE)
    );
    assert_eq!(
        read_qr_code(&format!("  rq1.{QR_CODE}\n")).as_deref(),
        Some(QR_CODE)
    );
    assert_eq!(read_qr_code(QR_CODE), None);
    assert_eq!(read_qr_code("rq1.short"), None);
    assert_eq!(read_qr_code(&format!("rq2.{QR_CODE}")), None);
    assert_eq!(read_qr_code("https://example.com/"), None);
    assert_eq!(read_qr_code(&format!("rq1.{}!", &QR_CODE[1..])), None);
}

#[tokio::test]
async fn claiming_a_qr_code_sends_a_challenge_for_a_kept_verifier() {
    let world = world();
    world.http.answer(
        200,
        json!({ "matchCode": "0420", "expiresAt": "2026-11-09T12:00:00Z" }),
    );

    let claim = world
        .session
        .claim_qr(QR_CODE, &phone(), &mut sevens)
        .await
        .expect("claimed");

    assert_eq!(claim.match_code, "0420");
    let (url, body) = world.http.calls().remove(0);
    assert_eq!(url, "https://runovahq.com/api/v1/qr-sign-in-claims");
    assert_eq!(body["code"], QR_CODE);
    assert_eq!(body["codeChallengeMethod"], "S256");
    assert_eq!(body["platform"], "android");
    assert_eq!(body["appVersion"], "3.4.0");
    assert_eq!(body["deviceId"], "4b2c0c0e-1111-4222-8333-944444444444");
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(claim.verifier.as_bytes()));
    assert_eq!(body["codeChallenge"], challenge.as_str());
}

#[tokio::test]
async fn a_refused_claim_is_signed_out_and_a_busy_server_is_not() {
    let world = world();
    world.http.answer(401, json!({}));
    world.http.answer(429, json!({}));

    assert_eq!(
        world
            .session
            .claim_qr(QR_CODE, &phone(), &mut sevens)
            .await
            .err(),
        Some(AuthError::SignedOut)
    );
    assert!(matches!(
        world
            .session
            .claim_qr(QR_CODE, &phone(), &mut sevens)
            .await
            .err(),
        Some(AuthError::Network(_))
    ));
}

#[tokio::test]
async fn polling_reads_each_answer() {
    let world = world();
    world
        .http
        .answer(200, json!({ "status": "waiting", "code": null }));
    world
        .http
        .answer(200, json!({ "status": "approved", "code": "one-time" }));
    world
        .http
        .answer(200, json!({ "status": "declined", "code": null }));
    world.http.answer(401, json!({}));

    assert_eq!(
        world.session.poll_qr(QR_CODE, "v").await,
        Ok(QrPoll::Waiting)
    );
    assert_eq!(
        world.session.poll_qr(QR_CODE, "v").await,
        Ok(QrPoll::Approved("one-time".into()))
    );
    assert_eq!(
        world.session.poll_qr(QR_CODE, "v").await,
        Ok(QrPoll::Declined)
    );
    assert_eq!(
        world.session.poll_qr(QR_CODE, "v").await,
        Err(AuthError::SignedOut)
    );

    let (url, body) = world.http.calls().remove(0);
    assert_eq!(url, "https://runovahq.com/api/v1/qr-sign-in-polls");
    assert_eq!(body, json!({ "code": QR_CODE, "codeVerifier": "v" }));
}
