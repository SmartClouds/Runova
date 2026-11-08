//! Relay frames: AES-256-GCM with the direction's key, as `[counter u64][ciphertext][tag]`, the
//! nonce being four zero bytes then the counter. Each frame must carry exactly the next counter.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use thiserror::Error;

const COUNTER_BYTES: usize = 8;
const TAG_BYTES: usize = 16;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CipherError {
    #[error("a relay frame too short to open")]
    TooShort,
    #[error("a relay frame out of order, or played again")]
    OutOfOrder,
    #[error("a relay frame that does not open")]
    Forged,
    #[error("this link has sealed all the frames it can")]
    Exhausted,
}

pub struct FrameCipher {
    send: Aes256Gcm,
    receive: Aes256Gcm,
    sent: u64,
    expected: u64,
}

fn nonce_bytes(counter: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

impl FrameCipher {
    pub fn new(send_key: [u8; 32], receive_key: [u8; 32]) -> Self {
        Self {
            send: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&send_key)),
            receive: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&receive_key)),
            sent: 0,
            expected: 0,
        }
    }

    pub fn seal(&mut self, frame: &[u8]) -> Result<Vec<u8>, CipherError> {
        let counter = self.sent;
        self.sent = counter.checked_add(1).ok_or(CipherError::Exhausted)?;
        let nonce = nonce_bytes(counter);
        let sealed = self
            .send
            .encrypt(Nonce::from_slice(&nonce), frame)
            .map_err(|_| CipherError::Forged)?;
        let mut output = Vec::with_capacity(COUNTER_BYTES + sealed.len());
        output.extend_from_slice(&counter.to_be_bytes());
        output.extend_from_slice(&sealed);
        Ok(output)
    }

    pub fn open(&mut self, sealed: &[u8]) -> Result<Vec<u8>, CipherError> {
        if sealed.len() < COUNTER_BYTES + TAG_BYTES {
            return Err(CipherError::TooShort);
        }
        let (counter_bytes, body) = sealed.split_at(COUNTER_BYTES);
        let counter = u64::from_be_bytes(
            counter_bytes
                .try_into()
                .map_err(|_| CipherError::TooShort)?,
        );
        if counter != self.expected {
            return Err(CipherError::OutOfOrder);
        }
        let nonce = nonce_bytes(counter);
        let plain = self
            .receive
            .decrypt(Nonce::from_slice(&nonce), body)
            .map_err(|_| CipherError::Forged)?;
        self.expected = counter.checked_add(1).ok_or(CipherError::Exhausted)?;
        Ok(plain)
    }
}
