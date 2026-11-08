//! The management messages against `manage-v1.json`, which the desktop's Vitest reads too.

use runova_protocol::manage::{
    MANAGE_CAPABILITY, ManageMessage, decode_stream, encode_stream, parse_message,
};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/test-vectors/manage-v1.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file")).expect("json")
}

#[test]
fn the_capability_matches() {
    assert_eq!(vectors()["capability"], MANAGE_CAPABILITY);
}

#[test]
fn every_vector_reads_and_writes_byte_for_byte() {
    for case in vectors()["messages"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();

        let parsed = parse_message(text).unwrap_or_else(|| panic!("should read {text}"));

        assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
    }
}

#[test]
fn every_rejected_vector_is_turned_down() {
    for case in vectors()["rejected"].as_array().unwrap() {
        let text = case.as_str().unwrap();

        assert!(parse_message(text).is_none(), "should refuse {text}");
    }
}

#[test]
fn a_failed_result_needs_a_code() {
    assert!(parse_message(r#"{"t":"rpc-result","id":1,"ok":false,"message":"x"}"#).is_none());
}

#[test]
fn a_call_reads_into_its_fields() {
    let parsed = parse_message(r#"{"t":"rpc-call","id":7,"m":"projects.list"}"#).unwrap();

    assert_eq!(
        parsed,
        ManageMessage::RpcCall {
            id: 7,
            m: "projects.list".into(),
            p: None
        }
    );
}

#[test]
fn the_binary_frame_matches() {
    let vectors = vectors();
    let binary = &vectors["binary"];
    let payload = hex::decode(binary["payload"].as_str().unwrap()).unwrap();
    let frame = hex::decode(binary["frame"].as_str().unwrap()).unwrap();
    let subscription = binary["subscription"].as_u64().unwrap() as u32;

    assert_eq!(encode_stream(subscription, &payload), frame);
    let (id, bytes) = decode_stream(&frame).unwrap();
    assert_eq!(id, subscription);
    assert_eq!(bytes, payload.as_slice());
}

#[test]
fn a_frame_too_short_or_of_another_kind_is_turned_down() {
    assert!(decode_stream(&[1, 0, 0]).is_none());
    assert!(decode_stream(&[2, 0, 0, 0, 1, 9]).is_none());
}
