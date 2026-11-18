//! Recovery phrases (E108) against the vectors the desktop writes, so a phrase made there and
//! scanned here is read the same.

use runova_crypto::phrase::{
    PhraseQr, canonical_secret, is_valid_phrase, parse_phrase_qr, phrase_to_entropy,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/test-vectors/recovery-phrase-v1.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file")).expect("json")
}

fn list<'a>(file: &'a Value, name: &str) -> &'a Vec<Value> {
    file[name].as_array().expect(name)
}

fn text<'a>(case: &'a Value, name: &str) -> &'a str {
    case[name].as_str().expect(name)
}

#[test]
fn reads_the_bytes_behind_each_vector_phrase() {
    let file = vectors();
    for case in list(&file, "entropy") {
        let entropy = phrase_to_entropy(text(case, "phrase")).expect("a phrase");
        assert_eq!(hex::encode(entropy.as_slice()), text(case, "entropy"));
        assert!(is_valid_phrase(text(case, "phrase")));
    }
}

#[test]
fn writes_a_phrase_one_way_and_leaves_a_passphrase_as_typed() {
    let file = vectors();
    for case in list(&file, "canonical") {
        let input = text(case, "input");
        assert_eq!(
            canonical_secret(input).as_str(),
            text(case, "output"),
            "{}",
            text(case, "about")
        );
        assert_eq!(
            is_valid_phrase(input),
            case["isPhrase"].as_bool().unwrap(),
            "{}",
            text(case, "about")
        );
    }
}

#[test]
fn reads_runova_phrase_qr_codes() {
    let file = vectors();
    for case in list(&file, "qr") {
        let read = parse_phrase_qr(text(case, "payload")).expect("a phrase code");
        assert_eq!(read.purpose.as_deref(), Some(text(case, "purpose")));
        assert_eq!(read.label.as_deref(), Some(text(case, "label")));
        assert_eq!(read.phrase.as_str(), text(case, "phrase"));
    }
}

#[test]
fn reads_a_code_of_just_the_words() {
    let file = vectors();
    for case in list(&file, "bareQr") {
        let read: PhraseQr = parse_phrase_qr(text(case, "payload")).expect("a phrase code");
        assert_eq!(read.purpose, None);
        assert_eq!(read.label, None);
        assert_eq!(read.phrase.as_str(), text(case, "phrase"));
    }
}

#[test]
fn refuses_codes_that_are_not_a_phrase() {
    let file = vectors();
    for case in list(&file, "badQr") {
        assert!(
            parse_phrase_qr(text(case, "payload")).is_none(),
            "{}",
            text(case, "about")
        );
    }
}
