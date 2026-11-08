//! Everything secret goes through one small store native code provides: Android Keystore or the
//! iOS Keychain. Tokens, the identity seed and the pinned computer keys all live in it.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::{StoredTokens, TokenStore};
use runova_crypto::handshake::{Identity, base64url, os_random};
use runova_session::connect::PinStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const TOKENS: &str = "tokens";
const IDENTITY_SEED: &str = "identity-seed";
const DEVICE_ID: &str = "device-id";

#[uniffi::export(with_foreign)]
pub trait SecureStore: Send + Sync {
    fn get(&self, key: String) -> Option<String>;
    fn set(&self, key: String, value: String);
    fn remove(&self, key: String);
}

#[derive(Serialize, Deserialize)]
struct TokensJson {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    session_id: i64,
}

pub struct SecureTokens(pub Arc<dyn SecureStore>);

impl TokenStore for SecureTokens {
    fn load(&self) -> Option<StoredTokens> {
        let json: TokensJson = serde_json::from_str(&self.0.get(TOKENS.to_owned())?).ok()?;
        Some(StoredTokens {
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            expires_at: json.expires_at,
            session_id: json.session_id,
        })
    }

    fn save(&self, tokens: &StoredTokens) {
        let json = TokensJson {
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: tokens.expires_at,
            session_id: tokens.session_id,
        };
        if let Ok(text) = serde_json::to_string(&json) {
            self.0.set(TOKENS.to_owned(), text);
        }
    }

    fn clear(&self) {
        self.0.remove(TOKENS.to_owned());
    }
}

pub struct SecurePins(pub Arc<dyn SecureStore>);

impl PinStore for SecurePins {
    fn pinned(&self, remote_id: &str) -> Option<String> {
        self.0.get(format!("pin:{remote_id}"))
    }

    fn pin(&self, remote_id: &str, key: &str) {
        self.0.set(format!("pin:{remote_id}"), key.to_owned());
    }
}

/// This phone's key seed, made the first time. It outlives sign-outs, so approvals still hold.
pub fn identity_seed(store: &dyn SecureStore) -> [u8; 32] {
    if let Some(seed) = store
        .get(IDENTITY_SEED.to_owned())
        .and_then(|text| URL_SAFE_NO_PAD.decode(text).ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
    {
        return seed;
    }
    let bytes = os_random(32);
    store.set(IDENTITY_SEED.to_owned(), URL_SAFE_NO_PAD.encode(&bytes));
    bytes.try_into().expect("32 random bytes")
}

pub fn identity_key(seed: [u8; 32]) -> String {
    base64url(&Identity::from_seed(seed).public_key())
}

/// A short code for a key, compared with the one the computer shows before approving this phone.
pub fn key_fingerprint(key: &[u8]) -> String {
    let hash = Sha256::digest(key);
    format!(
        "{:02X}{:02X} {:02X}{:02X}",
        hash[0], hash[1], hash[2], hash[3]
    )
}

pub(crate) fn phone_fingerprint(seed: [u8; 32]) -> String {
    key_fingerprint(&Identity::from_seed(seed).public_key())
}

/// This install's id, in the UUID form the server expects.
pub fn device_id(store: &dyn SecureStore) -> String {
    if let Some(id) = store.get(DEVICE_ID.to_owned()) {
        return id;
    }
    let mut bytes = os_random(16);
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let id = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    store.set(DEVICE_ID.to_owned(), id.clone());
    id
}
