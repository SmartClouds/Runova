//! Sealed items against the vectors the desktop's side writes.

use runova_crypto::sealed::{SealKey, SealedError, seal_with};
use serde_json::Value;

fn vectors() -> Vec<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/test-vectors/sealed-item-v1.json"
    );
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file"))
            .expect("json");
    file["cases"].as_array().expect("cases").clone()
}

fn bytes(case: &Value, name: &str) -> Vec<u8> {
    hex::decode(case[name].as_str().expect(name)).expect("hex")
}

fn fixed<const N: usize>(case: &Value, name: &str) -> [u8; N] {
    bytes(case, name).try_into().expect("length")
}

fn text<'a>(case: &'a Value, name: &str) -> &'a str {
    case[name].as_str().expect(name)
}

fn key_of(case: &Value) -> SealKey {
    SealKey::from_identity_seed(&fixed(case, "identitySeed"))
}

#[test]
fn the_phone_works_out_the_same_public_key_and_name() {
    for case in vectors() {
        let key = key_of(&case);
        assert_eq!(key.public_key().to_vec(), bytes(&case, "recipientPublic"));
        assert_eq!(key.key_id(), text(&case, "keyId"));
    }
}

#[test]
fn what_the_computer_sealed_opens_here() {
    for case in vectors() {
        let opened = key_of(&case)
            .open(&bytes(&case, "sealed"), text(&case, "context"))
            .expect("opens");
        assert_eq!(opened, bytes(&case, "plaintext"));
    }
}

#[test]
fn sealing_here_produces_the_same_bytes() {
    for case in vectors() {
        let sealed = seal_with(
            &fixed(&case, "recipientPublic"),
            fixed(&case, "ephemeralSecret"),
            fixed(&case, "nonce"),
            &bytes(&case, "plaintext"),
            text(&case, "context"),
        );
        assert_eq!(sealed, bytes(&case, "sealed"));
    }
}

#[test]
fn an_item_changed_on_the_way_is_refused() {
    let case = &vectors()[0];
    let mut sealed = bytes(case, "sealed");
    let last = sealed.len() - 1;
    sealed[last] ^= 1;
    assert_eq!(
        key_of(case).open(&sealed, text(case, "context")),
        Err(SealedError::NotForThisKey)
    );
}

#[test]
fn an_item_passed_off_as_another_kind_is_refused() {
    let case = &vectors()[0];
    assert_eq!(
        key_of(case).open(&bytes(case, "sealed"), "notification:deploys"),
        Err(SealedError::NotForThisKey)
    );
}

#[test]
fn another_phone_cannot_open_it() {
    let cases = vectors();
    assert_eq!(
        key_of(&cases[1]).open(&bytes(&cases[0], "sealed"), text(&cases[0], "context")),
        Err(SealedError::NotForThisKey)
    );
}

#[test]
fn a_format_from_the_future_says_so() {
    let case = &vectors()[0];
    let mut sealed = bytes(case, "sealed");
    sealed[0] = 2;
    assert_eq!(
        key_of(case).open(&sealed, text(case, "context")),
        Err(SealedError::UnknownVersion)
    );
}

#[test]
fn scraps_are_refused() {
    let case = &vectors()[0];
    assert_eq!(
        key_of(case).open(&[1, 2, 3], text(case, "context")),
        Err(SealedError::TooShort)
    );
}

#[test]
fn a_key_with_no_real_exchange_is_refused() {
    let case = &vectors()[0];
    let mut sealed = bytes(case, "sealed");
    sealed[1..33].fill(0);
    assert_eq!(
        key_of(case).open(&sealed, text(case, "context")),
        Err(SealedError::NotForThisKey)
    );
}
