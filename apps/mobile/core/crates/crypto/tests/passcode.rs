//! The app lock's passcode hash: what is stored never holds the code, and only the code opens it.

use runova_crypto::passcode::{hash_passcode, verify_passcode};

const SALT: [u8; 16] = [7; 16];

#[test]
fn the_right_code_verifies() {
    let stored = hash_passcode("1234", &SALT);
    assert!(verify_passcode("1234", &stored));
}

#[test]
fn a_wrong_code_does_not() {
    let stored = hash_passcode("1234", &SALT);
    assert!(!verify_passcode("1235", &stored));
    assert!(!verify_passcode("", &stored));
    assert!(!verify_passcode("12345", &stored));
}

#[test]
fn the_stored_form_names_its_parameters_and_hides_the_code() {
    let stored = hash_passcode("letmein", &SALT);
    assert!(stored.starts_with("scrypt$15$8$1$"), "{stored}");
    assert_eq!(stored.split('$').count(), 6);
    assert!(!stored.contains("letmein"));
}

#[test]
fn a_different_salt_gives_a_different_hash() {
    let one = hash_passcode("1234", &SALT);
    let two = hash_passcode("1234", &[8; 16]);
    assert_ne!(one, two);
    assert!(verify_passcode("1234", &two));
}

#[test]
fn equivalent_unicode_forms_are_the_same_password() {
    // "é" as one code point, then as "e" and a combining accent.
    let stored = hash_passcode("caf\u{e9}", &SALT);
    assert!(verify_passcode("cafe\u{301}", &stored));
}

#[test]
fn anything_malformed_never_verifies() {
    let stored = hash_passcode("1234", &SALT);
    let flipped = {
        let mut parts: Vec<String> = stored.split('$').map(str::to_owned).collect();
        parts[5] = parts[5].chars().rev().collect();
        parts.join("$")
    };
    for bad in [
        "",
        "1234",
        "scrypt$15$8$1$",
        "argon2$15$8$1$AAAA$AAAA",
        "scrypt$99$8$1$AAAA$AAAA",
        "scrypt$15$8$1$not base64!$AAAA",
        flipped.as_str(),
    ] {
        assert!(!verify_passcode("1234", bad), "{bad}");
    }
}
