//! The app lock's passcode, kept as an scrypt hash so the phone never stores the code itself.
//!
//! Stored form: `scrypt$<log n>$<r>$<p>$<salt>$<hash>`, salt and hash in unpadded URL-safe base64.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

const SCHEME: &str = "scrypt";
const LOG_N: u8 = 15;
const R: u32 = 8;
const P: u32 = 1;
const LENGTH: usize = 32;

fn derive(code: &str, salt: &[u8], params: &scrypt::Params) -> Zeroizing<[u8; LENGTH]> {
    let normalized = Zeroizing::new(code.nfkc().collect::<String>());
    let mut hash = Zeroizing::new([0u8; LENGTH]);
    scrypt::scrypt(normalized.as_bytes(), salt, params, hash.as_mut())
        .expect("32 bytes is a valid scrypt length");
    hash
}

fn params() -> scrypt::Params {
    scrypt::Params::new(LOG_N, R, P).expect("fixed scrypt parameters are valid")
}

/// Hashes `code` with `salt`, which should be 16 fresh random bytes.
pub fn hash_passcode(code: &str, salt: &[u8; 16]) -> String {
    let hash = derive(code, salt, &params());
    format!(
        "{SCHEME}${LOG_N}${R}${P}${}${}",
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(hash.as_ref())
    )
}

/// Whether `code` is the one `stored` was made from. A malformed `stored` never matches.
pub fn verify_passcode(code: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    let [scheme, log_n, r, p, salt, hash] = parts[..] else {
        return false;
    };
    // Only the parameters this app writes, so a planted value can't make a check slow or weak.
    if scheme != SCHEME || log_n != LOG_N.to_string() || r != R.to_string() || p != P.to_string() {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (URL_SAFE_NO_PAD.decode(salt), URL_SAFE_NO_PAD.decode(hash))
    else {
        return false;
    };
    if salt.is_empty() || expected.len() != LENGTH {
        return false;
    }
    let actual = derive(code, &salt, &params());
    actual.as_slice().ct_eq(&expected).into()
}
