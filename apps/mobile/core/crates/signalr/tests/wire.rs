//! The JSON hub protocol: what goes on the wire and how replies are read.

use runova_signalr::wire::{
    HubMessage, RS, decode_frames, encode, handshake_request, read_handshake,
};
use serde_json::json;

#[test]
fn the_handshake_asks_for_json_and_ends_with_the_separator() {
    assert_eq!(
        handshake_request(),
        "{\"protocol\":\"json\",\"version\":1}\u{1e}"
    );
}

#[test]
fn an_empty_handshake_answer_is_success_and_returns_what_followed_it() {
    let (result, rest) = read_handshake("{}\u{1e}{\"type\":6}\u{1e}").unwrap();

    assert_eq!(result, Ok(()));
    assert_eq!(rest, "{\"type\":6}\u{1e}");
}

#[test]
fn a_handshake_refusal_says_why() {
    let (result, _) = read_handshake("{\"error\":\"nope\"}\u{1e}").unwrap();

    assert_eq!(result, Err("nope".to_owned()));
}

#[test]
fn a_handshake_answer_cut_in_half_needs_more_data() {
    assert!(read_handshake("{\"err").is_none());
}

#[test]
fn an_invocation_is_written_in_the_shape_the_hub_reads() {
    let text = encode(&HubMessage::Invocation {
        invocation_id: Some("7".into()),
        target: "GoOnline".into(),
        arguments: vec![json!(42)],
    });

    assert!(text.ends_with(RS));
    let value: serde_json::Value = serde_json::from_str(text.trim_end_matches(RS)).unwrap();
    assert_eq!(
        value,
        json!({"type":1,"invocationId":"7","target":"GoOnline","arguments":[42]})
    );
}

#[test]
fn a_fire_and_forget_invocation_has_no_id() {
    let text = encode(&HubMessage::Invocation {
        invocation_id: None,
        target: "Signal".into(),
        arguments: vec![],
    });

    assert!(!text.contains("invocationId"));
}

#[test]
fn a_ping_is_type_six() {
    assert_eq!(encode(&HubMessage::Ping), "{\"type\":6}\u{1e}");
}

#[test]
fn one_websocket_message_can_carry_several_hub_messages() {
    let frames = decode_frames(
        "{\"type\":1,\"target\":\"Signal\",\"arguments\":[\"s\",\"p\"]}\u{1e}{\"type\":3,\"invocationId\":\"1\",\"result\":5}\u{1e}{\"type\":6}\u{1e}",
    )
    .unwrap();

    assert_eq!(
        frames,
        vec![
            HubMessage::Invocation {
                invocation_id: None,
                target: "Signal".into(),
                arguments: vec![json!("s"), json!("p")],
            },
            HubMessage::Completion {
                invocation_id: "1".into(),
                result: Some(json!(5)),
                error: None,
            },
            HubMessage::Ping,
        ]
    );
}

#[test]
fn a_completion_can_carry_an_error() {
    let frames =
        decode_frames("{\"type\":3,\"invocationId\":\"2\",\"error\":\"too large\"}\u{1e}").unwrap();

    assert_eq!(
        frames,
        vec![HubMessage::Completion {
            invocation_id: "2".into(),
            result: None,
            error: Some("too large".into()),
        }]
    );
}

#[test]
fn a_close_message_says_why_and_whether_to_reconnect() {
    let frames =
        decode_frames("{\"type\":7,\"error\":\"bye\",\"allowReconnect\":true}\u{1e}").unwrap();

    assert_eq!(
        frames,
        vec![HubMessage::Close {
            error: Some("bye".into()),
            allow_reconnect: true
        }]
    );
}

#[test]
fn message_types_this_client_never_asked_for_are_skipped() {
    assert_eq!(
        decode_frames("{\"type\":2,\"invocationId\":\"1\",\"item\":1}\u{1e}").unwrap(),
        vec![]
    );
}

#[test]
fn broken_json_is_an_error() {
    assert!(decode_frames("{nope\u{1e}").is_err());
}
