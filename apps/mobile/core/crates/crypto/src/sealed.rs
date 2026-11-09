//! Opens items a computer sealed for this phone. The computer only ever has the public half.
//!
//! Bytes: 0x01, the sender's fresh public key (32), the nonce (12), then AES-256-GCM ciphertext and
//! tag. `packages/protocol/test-vectors/sealed-item-v1.json` holds this to the desktop's side.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

const VERSION: u8 = 1;
const INFO: &[u8] = b"runova-sealed-item-v1";
const KEY_INFO: &[u8] = b"runova-notification-key-v1";
const HEADER: usize = 1 + 32 + 12;
const TAG: usize = 16;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SealedError {
    #[error("this item is too short")]
    TooShort,
    #[error("this item uses a format this app doesn't know")]
    UnknownVersion,
    #[error("this item can't be opened with this key")]
    NotForThisKey,
}

fn item_key(shared: &[u8; 32], sender: &[u8; 32], recipient: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(sender);
    salt[32..].copy_from_slice(recipient);
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), shared)
        .expand(INFO, key.as_mut())
        .expect("32 bytes is a valid length");
    key
}

/// The phone's half of sealing, worked out from its identity seed so there's nothing new to store.
pub struct SealKey {
    secret: StaticSecret,
    public: [u8; 32],
}

impl SealKey {
    pub fn from_identity_seed(seed: &[u8; 32]) -> Self {
        let mut bytes = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, seed)
            .expand(KEY_INFO, bytes.as_mut())
            .expect("32 bytes is a valid length");
        let secret = StaticSecret::from(*bytes);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    /// For push handlers, which run without the rest of the app and can't reach the identity seed.
    pub fn from_secret(bytes: [u8; 32]) -> Self {
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }

    /// The short name the server uses to give this phone its own copy of an item.
    pub fn key_id(&self) -> String {
        URL_SAFE_NO_PAD.encode(&Sha256::digest(self.public)[..9])
    }

    /// `context` has to be what the sender bound the item to, so an item can't be passed off as
    /// a different one.
    pub fn open(&self, sealed: &[u8], context: &str) -> Result<Vec<u8>, SealedError> {
        if sealed.len() < HEADER + TAG {
            return Err(SealedError::TooShort);
        }
        if sealed[0] != VERSION {
            return Err(SealedError::UnknownVersion);
        }
        let sender: [u8; 32] = sealed[1..33].try_into().expect("32 bytes");
        let shared = self.secret.diffie_hellman(&PublicKey::from(sender));
        if !shared.was_contributory() {
            return Err(SealedError::NotForThisKey);
        }
        let key = item_key(shared.as_bytes(), &sender, &self.public);
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()))
            .decrypt(
                Nonce::from_slice(&sealed[33..45]),
                Payload {
                    msg: &sealed[HEADER..],
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| SealedError::NotForThisKey)
    }
}

/// The sender's side, with its randomness passed in. Only the vectors and tests seal on the phone.
pub fn seal_with(
    recipient: &[u8; 32],
    ephemeral: [u8; 32],
    nonce: [u8; 12],
    plaintext: &[u8],
    context: &str,
) -> Vec<u8> {
    let secret = StaticSecret::from(ephemeral);
    let sender = PublicKey::from(&secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(*recipient));
    let key = item_key(shared.as_bytes(), &sender, recipient);
    let body = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()))
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: context.as_bytes(),
            },
        )
        .expect("a short item always encrypts");
    let mut out = Vec::with_capacity(HEADER + body.len());
    out.push(VERSION);
    out.extend_from_slice(&sender);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    out
}
