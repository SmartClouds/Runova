//! Everything secret goes through one small store native code provides: Android Keystore or the
//! iOS Keychain. Tokens, the identity seed and the pinned computer keys all live in it. The
//! identity seed and device id belong to the phone and are shared by every account on it.

use crate::accounts;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use runova_api::auth::{StoredTokens, TokenStore};
use runova_crypto::handshake::{Identity, base64url, os_random};
use runova_session::connect::PinStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// Where the one account a phone held before E118 kept its tokens.
const LEGACY_TOKENS: &str = "tokens";
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

fn load_from(store: &dyn SecureStore, key: &str) -> Option<StoredTokens> {
    let json: TokensJson = serde_json::from_str(&store.get(key.to_owned())?).ok()?;
    Some(StoredTokens {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: json.expires_at,
        session_id: json.session_id,
    })
}

fn save_to(store: &dyn SecureStore, key: &str, tokens: &StoredTokens) {
    let json = TokensJson {
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at: tokens.expires_at,
        session_id: tokens.session_id,
    };
    if let Ok(text) = serde_json::to_string(&json) {
        store.set(key.to_owned(), text);
    }
}

/// The tokens of the account the phone is using (E118). Each account keeps its own in
/// `tokens:{id}`; a sign-in not yet matched to an account waits in `tokens:pending`. The slot only
/// changes through [`AccountTokens::point_at`] and [`AccountTokens::rename`], both under the same
/// lock as every read and write, so a refresh that lands mid-change still saves to the account it
/// belongs to.
pub struct AccountTokens {
    secure: Arc<dyn SecureStore>,
    slot: Mutex<String>,
}

impl AccountTokens {
    /// Opens the store on the account last in use, moving the one set of tokens a phone held
    /// before E118 to the pending slot so the next start finds out whose it is.
    pub fn new(secure: Arc<dyn SecureStore>) -> Arc<Self> {
        if secure.get(accounts::INDEX.to_owned()).is_none()
            && let Some(old) = secure.get(LEGACY_TOKENS.to_owned())
        {
            secure.set(accounts::PENDING.to_owned(), old);
            secure.remove(LEGACY_TOKENS.to_owned());
        }
        let slot = accounts::slot_of(accounts::read_index(secure.as_ref()).active);
        Arc::new(Self {
            secure,
            slot: Mutex::new(slot),
        })
    }

    /// Reads and writes `slot` from now on. Call it inside `Session::switch` so no refresh is
    /// half done.
    pub(crate) fn point_at(&self, slot: String) {
        *self.slot.lock().expect("token slot") = slot;
    }

    /// Moves the tokens in use to `to`, which they belong in now that the account is known.
    pub(crate) fn rename(&self, to: String) {
        let mut slot = self.slot.lock().expect("token slot");
        if *slot == to {
            return;
        }
        match self.secure.get(slot.clone()) {
            Some(text) => {
                self.secure.set(to.clone(), text);
                self.secure.remove(slot.clone());
            }
            None => self.secure.remove(to.clone()),
        }
        *slot = to;
    }
}

impl TokenStore for AccountTokens {
    fn load(&self) -> Option<StoredTokens> {
        let slot = self.slot.lock().expect("token slot");
        load_from(self.secure.as_ref(), &slot)
    }

    fn save(&self, tokens: &StoredTokens) {
        let slot = self.slot.lock().expect("token slot");
        save_to(self.secure.as_ref(), &slot, tokens);
    }

    fn clear(&self) {
        let slot = self.slot.lock().expect("token slot");
        self.secure.remove(slot.clone());
    }
}

/// One fixed slot, for a sign-in on its way or an account the phone is not using right now.
pub struct SlotTokens {
    secure: Arc<dyn SecureStore>,
    key: String,
}

impl SlotTokens {
    pub fn new(secure: Arc<dyn SecureStore>, key: String) -> Arc<Self> {
        Arc::new(Self { secure, key })
    }
}

impl TokenStore for SlotTokens {
    fn load(&self) -> Option<StoredTokens> {
        load_from(self.secure.as_ref(), &self.key)
    }

    fn save(&self, tokens: &StoredTokens) {
        save_to(self.secure.as_ref(), &self.key, tokens);
    }

    fn clear(&self) {
        self.secure.remove(self.key.clone());
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
