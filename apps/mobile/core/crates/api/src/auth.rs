//! Signing a phone in with PKCE (RFC 8252, RFC 7636), and keeping its tokens fresh.
//!
//! Refresh tokens rotate on every use and the server ends a session when an old one comes back
//! after a short grace. So there is only ever one refresh at a time, and a new pair is saved
//! before anyone uses it. When an answer is lost the old pair stays, and the retry sends the same
//! token, which the grace exists for.

use crate::http::{HttpReply, HttpTransport};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const PHONE_CLIENT: &str = "runova-mobile";
pub const PHONE_REDIRECT: &str = "com.runovahq.app:/auth/callback";

/// What a sign-in QR code starts with, so a stray code is never sent to the server.
const QR_PREFIX: &str = "rq1.";
/// 32 random bytes in base64url.
const QR_CODE_LENGTH: usize = 43;

/// A token this close to its end is replaced before use, seconds.
const EXPIRY_MARGIN: u64 = 60;

/// Everything but RFC 3986's unreserved characters.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AuthError {
    #[error("signed out")]
    SignedOut,
    #[error("this sign-in did not start here")]
    StateMismatch,
    #[error("sign-in was declined in the browser")]
    Declined,
    #[error("that is not a sign-in link")]
    BadCallback,
    #[error("could not reach Runova: {0}")]
    Network(String),
    #[error("that passkey was not accepted")]
    PasskeyRefused,
    /// The site has that provider switched off.
    #[error("that sign-in provider is not available")]
    ProviderOff,
    /// The ID token from Google's or Apple's sheet was not accepted.
    #[error("that sign-in was not accepted")]
    ProviderRefused,
    /// A confirmed account already has the email; it links the provider from the website.
    #[error("an account with that email already exists")]
    LinkNeeded,
    /// The provider has not confirmed the email address.
    #[error("that email address is not confirmed")]
    EmailUnverified,
    /// The account has two-step sign-in, which only the browser sign-in asks for.
    #[error("finish signing in in the browser")]
    ContinueInBrowser,
}

/// A nonce for Google's or Apple's own sign-in sheet (E117), which puts it in the ID token. For
/// Google, the web client id Credential Manager asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderNonce {
    pub provider: String,
    pub nonce: String,
    pub client_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NonceReply {
    nonce: String,
    client_id: Option<String>,
}

#[derive(Deserialize)]
struct ProblemReply {
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// Whether a problem answer has the given type, such as `two-factor-required`.
fn is_problem(reply: &HttpReply, slug: &str) -> bool {
    serde_json::from_str::<ProblemReply>(&reply.body)
        .ok()
        .and_then(|p| p.kind)
        .is_some_and(|kind| kind.rsplit('/').next() == Some(slug))
}

/// A passkey sign-in to show the platform's prompt for (E115): the WebAuthn request options as
/// JSON, as Credential Manager and AuthenticationServices take them, and the id to answer with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasskeyChallenge {
    pub id: String,
    pub options_json: String,
}

#[derive(Deserialize)]
struct PasskeyChallengeReply {
    id: String,
    options: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
}

pub struct SignInRequest {
    /// Open this in the system browser.
    pub url: String,
    pub verifier: String,
    pub state: String,
}

fn escape(value: &str) -> String {
    utf8_percent_encode(value, COMPONENT).to_string()
}

/// Makes the link that starts a sign-in, with a fresh verifier and state.
pub fn begin_sign_in(
    site: &str,
    device: &DeviceInfo,
    random: &mut dyn FnMut(usize) -> Vec<u8>,
) -> SignInRequest {
    begin_sign_in_with_provider(site, device, None, random)
}

/// The same link with a provider hint (E117): signed out, the website goes straight to that
/// provider's sign-in instead of showing its own page.
pub fn begin_sign_in_with_provider(
    site: &str,
    device: &DeviceInfo,
    provider: Option<&str>,
    random: &mut dyn FnMut(usize) -> Vec<u8>,
) -> SignInRequest {
    let verifier = URL_SAFE_NO_PAD.encode(random(32));
    let state = URL_SAFE_NO_PAD.encode(random(16));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let query = [
        ("client_id", PHONE_CLIENT),
        ("redirect_uri", PHONE_REDIRECT),
        ("response_type", "code"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
        ("device_name", &device.name),
        ("platform", &device.platform),
        ("app_version", &device.app_version),
        ("device_id", &device.device_id),
    ]
    .iter()
    .map(|(key, value)| format!("{key}={}", escape(value)))
    .collect::<Vec<_>>()
    .join("&");
    let query = match provider {
        Some(provider) => format!("{query}&provider={}", escape(provider)),
        None => query,
    };
    SignInRequest {
        url: format!("{}/account/authorize?{query}", site.trim_end_matches('/')),
        verifier,
        state,
    }
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode_str(value).decode_utf8_lossy().into_owned())
    })
}

/// The code from the link the browser came back with.
pub fn read_callback(url: &str, expected_state: &str) -> Result<String, AuthError> {
    let query = url
        .strip_prefix(PHONE_REDIRECT)
        .and_then(|rest| rest.strip_prefix('?'))
        .ok_or(AuthError::BadCallback)?;
    if query_value(query, "state").as_deref() != Some(expected_state) {
        return Err(AuthError::StateMismatch);
    }
    if query_value(query, "error").is_some() {
        return Err(AuthError::Declined);
    }
    query_value(query, "code").ok_or(AuthError::BadCallback)
}

/// The code in a sign-in QR, or `None` for any other QR.
pub fn read_qr_code(text: &str) -> Option<String> {
    let code = text.trim().strip_prefix(QR_PREFIX)?;
    let valid = code.len() == QR_CODE_LENGTH
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then(|| code.to_owned())
}

/// A QR code this phone has claimed: the digits to show, and the proof that it was this phone.
#[derive(Debug)]
pub struct QrClaim {
    pub match_code: String,
    pub verifier: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrPoll {
    Waiting,
    /// Carries the one-time code for [`Session::complete_sign_in`].
    Approved(String),
    Declined,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QrClaimReply {
    match_code: String,
}

#[derive(Deserialize)]
struct QrPollReply {
    status: String,
    code: Option<String>,
}

/// A session's tokens. Only the platform's secure storage should ever hold these outside memory.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Seconds since the epoch.
    pub expires_at: u64,
    pub session_id: i64,
}

/// The platform's secure storage: Android Keystore or the iOS Keychain.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Option<StoredTokens>;
    fn save(&self, tokens: &StoredTokens);
    fn clear(&self);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenReply {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    session_id: i64,
}

struct State {
    loaded: bool,
    tokens: Option<StoredTokens>,
}

pub struct Session {
    site: String,
    token_url: String,
    http: Arc<dyn HttpTransport>,
    store: Arc<dyn TokenStore>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Held across a refresh, which is what makes it single-flight.
    state: Mutex<State>,
}

impl Session {
    pub fn new(
        site: &str,
        http: Arc<dyn HttpTransport>,
        store: Arc<dyn TokenStore>,
        clock: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        let site = site.trim_end_matches('/').to_owned();
        Self {
            token_url: format!("{site}/api/v1/device-tokens"),
            site,
            http,
            store,
            clock: Arc::from(clock),
            state: Mutex::new(State {
                loaded: false,
                tokens: None,
            }),
        }
    }

    /// Another session on the same site, network and clock, keeping its tokens in `store`. Used to
    /// add an account, or to act as one that is not the phone's active account.
    pub fn sibling(&self, store: Arc<dyn TokenStore>) -> Session {
        Session {
            site: self.site.clone(),
            token_url: self.token_url.clone(),
            http: self.http.clone(),
            store,
            clock: self.clock.clone(),
            state: Mutex::new(State {
                loaded: false,
                tokens: None,
            }),
        }
    }

    /// Forgets the tokens held in memory, so the next use reads the store again. The phone calls
    /// this after pointing the store at another account.
    pub async fn reload(&self) {
        self.switch(|| {}).await;
    }

    /// Runs `change` (pointing the store at another account) once no refresh is under way, then
    /// forgets the tokens held in memory. A refresh that was running saves where it began.
    pub async fn switch(&self, change: impl FnOnce()) {
        let mut state = self.state.lock().await;
        change();
        state.loaded = false;
        state.tokens = None;
    }

    /// The server's id for this sign-in, while there is one.
    pub async fn session_id(&self) -> Option<i64> {
        let mut state = self.state.lock().await;
        self.ensure_loaded(&mut state);
        state.tokens.as_ref().map(|t| t.session_id)
    }

    fn ensure_loaded(&self, state: &mut State) {
        if !state.loaded {
            state.tokens = self.store.load();
            state.loaded = true;
        }
    }

    fn accept(&self, state: &mut State, reply: &HttpReply) -> Result<(), AuthError> {
        let parsed: TokenReply = serde_json::from_str(&reply.body)
            .map_err(|_| AuthError::Network("an answer that could not be read".to_owned()))?;
        let tokens = StoredTokens {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            expires_at: (self.clock)() + parsed.expires_in,
            session_id: parsed.session_id,
        };
        self.store.save(&tokens);
        state.tokens = Some(tokens);
        Ok(())
    }

    /// Trades the browser's code for the first pair of tokens.
    pub async fn complete_sign_in(&self, code: &str, verifier: &str) -> Result<(), AuthError> {
        let mut state = self.state.lock().await;
        let reply = self
            .http
            .post_json(
                &self.token_url,
                json!({
                    "grantType": "authorization_code",
                    "code": code,
                    "codeVerifier": verifier,
                    "redirectUri": PHONE_REDIRECT,
                    "refreshToken": null,
                }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            200 => {
                state.loaded = true;
                self.accept(&mut state, &reply)
            }
            401 => Err(AuthError::SignedOut),
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    /// A `sign-in` passkey challenge. It needs no session: the passkey says whose account it is.
    pub async fn begin_passkey_sign_in(&self) -> Result<PasskeyChallenge, AuthError> {
        let reply = self
            .http
            .post_json(
                &format!("{}/api/v1/passkey-challenges", self.site),
                json!({ "purpose": "sign-in" }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        if reply.status != 201 {
            return Err(AuthError::Network(format!("status {}", reply.status)));
        }
        let parsed: PasskeyChallengeReply = serde_json::from_str(&reply.body)
            .map_err(|_| AuthError::Network("an answer that could not be read".to_owned()))?;
        Ok(PasskeyChallenge {
            id: parsed.id,
            options_json: parsed.options.to_string(),
        })
    }

    /// Trades the platform's answer to a passkey challenge for the first pair of tokens. No
    /// two-factor code follows: the passkey's own check (fingerprint, face or PIN) is the second.
    pub async fn finish_passkey_sign_in(
        &self,
        challenge_id: &str,
        credential_json: &str,
        device: &DeviceInfo,
    ) -> Result<(), AuthError> {
        let credential: serde_json::Value =
            serde_json::from_str(credential_json).map_err(|_| AuthError::PasskeyRefused)?;
        if !credential.is_object() {
            return Err(AuthError::PasskeyRefused);
        }
        let mut state = self.state.lock().await;
        let reply = self
            .http
            .post_json(
                &self.token_url,
                json!({
                    "grantType": "passkey",
                    "challengeId": challenge_id,
                    "credential": credential,
                    "platform": device.platform,
                    "appVersion": device.app_version,
                    "deviceId": device.device_id,
                }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            200 => {
                state.loaded = true;
                self.accept(&mut state, &reply)
            }
            400 | 401 => Err(AuthError::PasskeyRefused),
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    /// A nonce for `provider`'s own sign-in sheet (`google` or `apple`). It needs no session.
    pub async fn begin_provider_sign_in(&self, provider: &str) -> Result<ProviderNonce, AuthError> {
        let reply = self
            .http
            .post_json(
                &format!("{}/api/v1/sign-in-nonces", self.site),
                json!({ "provider": provider }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            201 => {
                let parsed: NonceReply = serde_json::from_str(&reply.body).map_err(|_| {
                    AuthError::Network("an answer that could not be read".to_owned())
                })?;
                Ok(ProviderNonce {
                    provider: provider.to_owned(),
                    nonce: parsed.nonce,
                    client_id: parsed.client_id,
                })
            }
            404 => Err(AuthError::ProviderOff),
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    /// Trades the ID token the sheet gave for the first pair of tokens. Apple also gives an
    /// authorization code, and the person's name the very first time only.
    pub async fn finish_provider_sign_in(
        &self,
        provider: &str,
        nonce: &str,
        id_token: &str,
        authorization_code: Option<&str>,
        name: Option<&str>,
        device: &DeviceInfo,
    ) -> Result<(), AuthError> {
        let mut state = self.state.lock().await;
        let reply = self
            .http
            .post_json(
                &self.token_url,
                json!({
                    "grantType": "id_token",
                    "provider": provider,
                    "idToken": id_token,
                    "nonce": nonce,
                    "authorizationCode": authorization_code,
                    "name": name,
                    "platform": device.platform,
                    "appVersion": device.app_version,
                    "deviceId": device.device_id,
                }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            200 => {
                state.loaded = true;
                self.accept(&mut state, &reply)
            }
            409 => Err(AuthError::LinkNeeded),
            403 => Err(AuthError::EmailUnverified),
            401 if is_problem(&reply, "two-factor-required") => Err(AuthError::ContinueInBrowser),
            400 | 401 => Err(AuthError::ProviderRefused),
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    /// Takes a scanned code for this phone. The verifier it comes back with proves that later.
    pub async fn claim_qr(
        &self,
        code: &str,
        device: &DeviceInfo,
        random: &mut (dyn FnMut(usize) -> Vec<u8> + Send),
    ) -> Result<QrClaim, AuthError> {
        let verifier = URL_SAFE_NO_PAD.encode(random(32));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let reply = self
            .http
            .post_json(
                &format!("{}/api/v1/qr-sign-in-claims", self.site),
                json!({
                    "code": code,
                    "codeChallenge": challenge,
                    "codeChallengeMethod": "S256",
                    "platform": device.platform,
                    "appVersion": device.app_version,
                    "deviceId": device.device_id,
                }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            200 => {
                let parsed: QrClaimReply = serde_json::from_str(&reply.body).map_err(|_| {
                    AuthError::Network("an answer that could not be read".to_owned())
                })?;
                Ok(QrClaim {
                    match_code: parsed.match_code,
                    verifier,
                })
            }
            401 => Err(AuthError::SignedOut),
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    /// Whether the signed-in side has answered a claimed code yet.
    pub async fn poll_qr(&self, code: &str, verifier: &str) -> Result<QrPoll, AuthError> {
        let reply = self
            .http
            .post_json(
                &format!("{}/api/v1/qr-sign-in-polls", self.site),
                json!({ "code": code, "codeVerifier": verifier }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            200 => {
                let parsed: QrPollReply = serde_json::from_str(&reply.body).map_err(|_| {
                    AuthError::Network("an answer that could not be read".to_owned())
                })?;
                match (parsed.status.as_str(), parsed.code) {
                    ("approved", Some(code)) => Ok(QrPoll::Approved(code)),
                    ("declined", _) => Ok(QrPoll::Declined),
                    _ => Ok(QrPoll::Waiting),
                }
            }
            401 => Err(AuthError::SignedOut),
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    /// A valid access token, refreshing first if the current one is at its end.
    pub async fn access_token(&self) -> Result<String, AuthError> {
        let mut state = self.state.lock().await;
        self.ensure_loaded(&mut state);
        let tokens = state.tokens.as_ref().ok_or(AuthError::SignedOut)?;
        if (self.clock)() + EXPIRY_MARGIN < tokens.expires_at {
            return Ok(tokens.access_token.clone());
        }
        let refresh_token = tokens.refresh_token.clone();
        let reply = self
            .http
            .post_json(
                &self.token_url,
                json!({
                    "grantType": "refresh_token",
                    "code": null,
                    "codeVerifier": null,
                    "redirectUri": null,
                    "refreshToken": refresh_token,
                }),
            )
            .await
            .map_err(|e| AuthError::Network(e.0))?;
        match reply.status {
            200 => {
                self.accept(&mut state, &reply)?;
                state
                    .tokens
                    .as_ref()
                    .map(|t| t.access_token.clone())
                    .ok_or(AuthError::SignedOut)
            }
            401 => {
                state.tokens = None;
                self.store.clear();
                Err(AuthError::SignedOut)
            }
            status => Err(AuthError::Network(format!("status {status}"))),
        }
    }

    pub async fn is_signed_in(&self) -> bool {
        let mut state = self.state.lock().await;
        self.ensure_loaded(&mut state);
        state.tokens.is_some()
    }

    pub async fn sign_out(&self) {
        let mut state = self.state.lock().await;
        state.loaded = true;
        state.tokens = None;
        self.store.clear();
    }
}
