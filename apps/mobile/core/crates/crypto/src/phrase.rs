//! Recovery phrases (E107, E108): 24 BIP39 English words for 32 random bytes, which the desktop
//! makes in place of a typed secret and shows as a QR code. The phone reads that code and keeps
//! the phrase. A phrase is used in one canonical form, lowercase words with single spaces;
//! anything that is not exactly 24 list words with a valid checksum is a passphrase and is left
//! as typed. `packages/protocol/test-vectors/recovery-phrase-v1.json` pins all of it.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const WORD_COUNT: usize = 24;
const ENTROPY_BYTES: usize = 32;
const QR_PREFIX: &str = "RUNOVA-PHRASE";
const QR_VERSION: &str = "1";

/// What a phrase opens, as the desktop names it in its QR code.
pub const PURPOSES: [&str; 6] = [
    "sync",
    "sync-recovery",
    "vault",
    "server-backup",
    "app-backup",
    "servers-passkey",
];

fn words() -> &'static HashMap<&'static str, u16> {
    static WORDS: OnceLock<HashMap<&'static str, u16>> = OnceLock::new();
    WORDS.get_or_init(|| {
        include_str!("phrase_words.txt")
            .lines()
            .filter(|line| !line.is_empty())
            .enumerate()
            .map(|(index, word)| (word, index as u16))
            .collect()
    })
}

/// The phrase in its one form and the bytes it stands for, or None when the text is not a phrase.
fn read(text: &str) -> Option<(Zeroizing<String>, Zeroizing<[u8; ENTROPY_BYTES]>)> {
    let folded = Zeroizing::new(text.nfkd().collect::<String>().to_lowercase());
    let parts: Vec<&str> = folded.split_whitespace().collect();
    if parts.len() != WORD_COUNT {
        return None;
    }
    // 24 words of 11 bits: 256 bits of entropy, then an 8-bit checksum.
    let mut bits = Zeroizing::new([0u8; ENTROPY_BYTES + 1]);
    for (n, word) in parts.iter().enumerate() {
        let index = *words().get(word)?;
        for bit in 0..11 {
            if index >> (10 - bit) & 1 == 1 {
                let at = n * 11 + bit;
                bits[at / 8] |= 0x80 >> (at % 8);
            }
        }
    }
    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    entropy.copy_from_slice(&bits[..ENTROPY_BYTES]);
    if Sha256::digest(entropy.as_slice())[0] != bits[ENTROPY_BYTES] {
        return None;
    }
    Some((Zeroizing::new(parts.join(" ")), entropy))
}

pub fn is_valid_phrase(text: &str) -> bool {
    read(text).is_some()
}

/// The text a key is derived from: a phrase in its one form, anything else exactly as typed.
pub fn canonical_secret(text: &str) -> Zeroizing<String> {
    read(text).map_or_else(|| Zeroizing::new(text.to_owned()), |(phrase, _)| phrase)
}

pub fn phrase_to_entropy(text: &str) -> Option<Zeroizing<[u8; ENTROPY_BYTES]>> {
    read(text).map(|(_, entropy)| entropy)
}

/// A scanned phrase code. Purpose and label are there when the desktop made the code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhraseQr {
    pub purpose: Option<String>,
    pub label: Option<String>,
    pub phrase: Zeroizing<String>,
}

/// Reads a scanned code: Runova's own payload, or just the 24 words from another tool. None for
/// anything else, including a phrase whose checksum is wrong.
pub fn parse_phrase_qr(payload: &str) -> Option<PhraseQr> {
    let text = payload.trim();
    let Some(rest) = text
        .strip_prefix(QR_PREFIX)
        .and_then(|r| r.strip_prefix(':'))
    else {
        return read(text).map(|(phrase, _)| PhraseQr {
            purpose: None,
            label: None,
            phrase,
        });
    };
    let parts: Vec<&str> = rest.splitn(4, ':').collect();
    let [version, purpose, label, words] = parts.as_slice() else {
        return None;
    };
    if *version != QR_VERSION || !PURPOSES.contains(purpose) || words.contains(':') {
        return None;
    }
    let label = String::from_utf8(URL_SAFE_NO_PAD.decode(label).ok()?).ok()?;
    let (phrase, _) = read(words)?;
    Some(PhraseQr {
        purpose: Some((*purpose).to_owned()),
        label: Some(label),
        phrase,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_the_whole_word_list() {
        assert_eq!(words().len(), 2048);
        assert_eq!(words()["abandon"], 0);
        assert_eq!(words()["zoo"], 2047);
    }
}
