//! The handshake and relay cipher against the vectors the desktop and the agent also pass.

use runova_crypto::cipher::FrameCipher;
use runova_crypto::handshake::{
    ControllerHandshake, HandshakeError, HostHandshake, Identity, Mode, base64url,
    derive_password_secret,
};
use runova_protocol::handshake::HandshakeMessage;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/test-vectors/anywhere-v1.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file")).expect("json")
}

fn bytes32(text: &str) -> [u8; 32] {
    hex::decode(text).unwrap().try_into().unwrap()
}

fn message(value: &Value) -> HandshakeMessage {
    serde_json::from_value(value.clone()).unwrap()
}

/// Hands out the case's recorded random values in order, as the desktop's generator did.
fn recorded(case: &Value) -> impl FnMut(usize) -> Vec<u8> {
    let values: Vec<Vec<u8>> = case["controllerRandom"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| hex::decode(v.as_str().unwrap()).unwrap())
        .collect();
    let mut next = values.into_iter();
    move |length| {
        let value = next.next().expect("a recorded value");
        assert_eq!(value.len(), length);
        value
    }
}

fn mode_of(case: &Value) -> Mode {
    if case["mode"] == "password" {
        Mode::Password
    } else {
        Mode::Ask
    }
}

fn controller_for(case: &Value) -> ControllerHandshake {
    let host = Identity::from_seed(bytes32(case["hostSeed"].as_str().unwrap()));
    let identity = Identity::from_seed(bytes32(case["controllerSeed"].as_str().unwrap()));
    let secret = case["passwordSecret"].as_str().map(bytes32);
    ControllerHandshake::new(
        case["sessionId"].as_str().unwrap(),
        mode_of(case),
        identity,
        host.public_key(),
        secret,
        case["controllerFingerprint"].as_str().unwrap(),
        case["hostFingerprint"].as_str().unwrap(),
        &mut recorded(case),
    )
    .unwrap()
}

#[test]
fn both_modes_produce_the_recorded_messages_and_keys() {
    for case in vectors()["handshake"].as_array().unwrap() {
        let mut controller = controller_for(case);
        let hello = serde_json::to_value(controller.hello()).unwrap();
        assert_eq!(hello, case["hello"], "hello in {}", case["mode"]);

        let (finish, keys) = controller.complete(&message(&case["reply"])).unwrap();

        assert_eq!(
            serde_json::to_value(&finish).unwrap(),
            case["finish"],
            "finish in {}",
            case["mode"]
        );
        assert_eq!(
            hex::encode(keys.send()),
            case["controllerToHost"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(keys.receive()),
            case["hostToController"].as_str().unwrap()
        );
        assert_eq!(keys.safety_code(), case["safetyCode"].as_str().unwrap());
        assert_eq!(
            hex::encode(keys.transcript()),
            case["transcript"].as_str().unwrap()
        );
    }
}

#[test]
fn hello_keeps_the_field_order_the_desktop_writes() {
    let case = &vectors()["handshake"][1];
    let text = serde_json::to_string(controller_for(case).hello()).unwrap();

    assert!(text.starts_with(r#"{"t":"hs-hello","v":1,"eph":"#));
    assert!(text.contains(r#","fp":"sha-256 AA:BB","cpace":"#));
}

#[test]
fn the_password_secret_matches() {
    let case = &vectors()["handshake"][1];
    let host = Identity::from_seed(bytes32(case["hostSeed"].as_str().unwrap()));

    let secret = derive_password_secret(
        case["password"].as_str().unwrap(),
        &base64url(&host.public_key()),
    )
    .unwrap();

    assert_eq!(
        hex::encode(secret),
        case["passwordSecret"].as_str().unwrap()
    );
}

fn reply_with(case: &Value, field: &str, value: Value) -> HandshakeMessage {
    let mut reply = case["reply"].clone();
    reply[field] = value;
    message(&reply)
}

fn other_value_b64(text: &Value) -> Value {
    let original = text.as_str().unwrap();
    let flipped = if original.starts_with('A') { "B" } else { "A" };
    Value::String(format!("{flipped}{}", &original[1..]))
}

#[test]
fn a_host_with_another_identity_is_refused() {
    let case = &vectors()["handshake"][0];
    let stranger = base64url(&Identity::from_seed([9; 32]).public_key());

    let result = controller_for(case).complete(&reply_with(case, "id", stranger.into()));

    assert_eq!(result.err(), Some(HandshakeError::Identity));
}

#[test]
fn a_changed_fingerprint_is_refused() {
    let case = &vectors()["handshake"][0];

    let result = controller_for(case).complete(&reply_with(case, "fp", "sha-256 00:00".into()));

    assert_eq!(result.err(), Some(HandshakeError::Fingerprint));
}

#[test]
fn a_forged_signature_is_refused() {
    let case = &vectors()["handshake"][0];
    let forged = other_value_b64(&case["reply"]["sig"]);

    let result = controller_for(case).complete(&reply_with(case, "sig", forged));

    assert_eq!(result.err(), Some(HandshakeError::Signature));
}

#[test]
fn a_wrong_confirmation_is_a_protocol_error_or_a_wrong_password() {
    let cases = vectors();
    let ask = &cases["handshake"][0];
    let password = &cases["handshake"][1];
    let wrong_ask = other_value_b64(&ask["reply"]["confirm"]);
    let wrong_password = other_value_b64(&password["reply"]["confirm"]);

    assert_eq!(
        controller_for(ask)
            .complete(&reply_with(ask, "confirm", wrong_ask))
            .err(),
        Some(HandshakeError::Protocol)
    );
    assert_eq!(
        controller_for(password)
            .complete(&reply_with(password, "confirm", wrong_password))
            .err(),
        Some(HandshakeError::WrongPassword)
    );
}

#[test]
fn a_hosts_abort_carries_its_reason() {
    let case = &vectors()["handshake"][0];
    let abort = HandshakeMessage {
        t: "hs-abort".into(),
        reason: Some("wrong-password".into()),
        ..HandshakeMessage::default()
    };

    assert_eq!(
        controller_for(case).complete(&abort).err(),
        Some(HandshakeError::WrongPassword)
    );
}

#[test]
fn a_short_field_is_a_protocol_error() {
    let case = &vectors()["handshake"][0];

    let result = controller_for(case).complete(&reply_with(case, "eph", "AAAA".into()));

    assert_eq!(result.err(), Some(HandshakeError::Protocol));
}

#[test]
fn a_cpace_share_outside_password_mode_is_refused() {
    let cases = vectors();
    let ask = &cases["handshake"][0];
    let share = cases["handshake"][1]["reply"]["cpace"].clone();

    let result = controller_for(ask).complete(&reply_with(ask, "cpace", share));

    assert_eq!(result.err(), Some(HandshakeError::Protocol));
}

fn recorded_host(case: &Value) -> impl FnMut(usize) -> Vec<u8> {
    let values: Vec<Vec<u8>> = case["hostRandom"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| hex::decode(v.as_str().unwrap()).unwrap())
        .collect();
    let mut next = values.into_iter();
    move |length| {
        let value = next.next().expect("a recorded value");
        assert_eq!(value.len(), length);
        value
    }
}

fn host_for(case: &Value) -> HostHandshake {
    let controller = Identity::from_seed(bytes32(case["controllerSeed"].as_str().unwrap()));
    HostHandshake::new(
        case["sessionId"].as_str().unwrap(),
        mode_of(case),
        Identity::from_seed(bytes32(case["hostSeed"].as_str().unwrap())),
        controller.public_key(),
        case["passwordSecret"].as_str().map(bytes32),
        case["hostFingerprint"].as_str().unwrap(),
        case["controllerFingerprint"].as_str().unwrap(),
    )
}

#[test]
fn the_host_produces_the_recorded_reply_and_the_same_keys() {
    for case in vectors()["handshake"].as_array().unwrap() {
        let mut host = host_for(case);

        let reply = host
            .respond(&message(&case["hello"]), &mut recorded_host(case))
            .unwrap();
        let keys = host.complete(&message(&case["finish"])).unwrap();

        assert_eq!(
            serde_json::to_value(&reply).unwrap(),
            case["reply"],
            "reply in {}",
            case["mode"]
        );
        assert_eq!(
            hex::encode(keys.send()),
            case["hostToController"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(keys.receive()),
            case["controllerToHost"].as_str().unwrap()
        );
        assert_eq!(keys.safety_code(), case["safetyCode"].as_str().unwrap());
    }
}

#[test]
fn the_host_refuses_a_controller_it_does_not_expect() {
    let case = &vectors()["handshake"][0];
    let mut hello = case["hello"].clone();
    hello["id"] = base64url(&Identity::from_seed([9; 32]).public_key()).into();

    let result = host_for(case).respond(&message(&hello), &mut recorded_host(case));

    assert_eq!(result.err(), Some(HandshakeError::Identity));
}

#[test]
fn the_host_refuses_a_forged_finish() {
    let case = &vectors()["handshake"][0];
    let mut host = host_for(case);
    host.respond(&message(&case["hello"]), &mut recorded_host(case))
        .unwrap();
    let mut finish = case["finish"].clone();
    finish["sig"] = other_value_b64(&finish["sig"]);

    assert_eq!(
        host.complete(&message(&finish)).err(),
        Some(HandshakeError::Signature)
    );
}

fn cipher_case() -> (FrameCipher, Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let cipher = &vectors()["cipher"];
    let key = bytes32(cipher["key"].as_str().unwrap());
    let decode = |name: &str| -> Vec<Vec<u8>> {
        cipher[name]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| hex::decode(v.as_str().unwrap()).unwrap())
            .collect()
    };
    (
        FrameCipher::new(key, key),
        decode("frames"),
        decode("sealed"),
    )
}

#[test]
fn frames_seal_exactly_as_recorded() {
    let (mut cipher, frames, sealed) = cipher_case();

    for (frame, expected) in frames.iter().zip(&sealed) {
        assert_eq!(&cipher.seal(frame).unwrap(), expected);
    }
}

#[test]
fn sealed_frames_open_in_order() {
    let (mut cipher, frames, sealed) = cipher_case();

    for (frame, expected) in sealed.iter().zip(&frames) {
        assert_eq!(&cipher.open(frame).unwrap(), expected);
    }
}

#[test]
fn a_frame_out_of_order_or_played_again_is_refused() {
    let (mut cipher, _, sealed) = cipher_case();

    assert!(cipher.open(&sealed[1]).is_err());
    cipher.open(&sealed[0]).unwrap();
    assert!(cipher.open(&sealed[0]).is_err());
}

#[test]
fn a_changed_or_short_frame_is_refused() {
    let (mut cipher, _, sealed) = cipher_case();
    let mut changed = sealed[0].clone();
    *changed.last_mut().unwrap() ^= 1;

    assert!(cipher.open(&changed).is_err());
    assert!(cipher.open(&[0; 10]).is_err());
}
