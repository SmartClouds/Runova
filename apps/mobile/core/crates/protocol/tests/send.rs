//! Sending files (E112, E113) against `send-v1.json`, the file the desktop's Vitest reads too.

use runova_protocol::file::{
    BIN_FILE_CHUNK, FileChunk, FileMessage, decode_chunk, encode_chunk, transfer_key,
};
use runova_protocol::send::{
    MAX_FILES, MAX_NOTE_CHARS, MAX_OFFER_BYTES, MAX_PART_SIZE, MAX_PATH_CHARS, MAX_SEGMENT_BYTES,
    MAX_SEGMENTS, MIN_PART_SIZE, RECEIVE_FILES_FEATURE, SEND_PART_BYTES, SendMessage,
    parse_send_message, safe_relative_path, send_path_key,
};
use serde_json::{Value, json};

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/test-vectors/send-v1.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file")).expect("json")
}

#[test]
fn the_feature_part_size_and_limits_match() {
    let v = vectors();
    assert_eq!(v["feature"], RECEIVE_FILES_FEATURE);
    assert_eq!(v["partBytes"], SEND_PART_BYTES);
    let limits = &v["limits"];
    assert_eq!(limits["maxFiles"], MAX_FILES as u64);
    assert_eq!(limits["maxOfferBytes"], MAX_OFFER_BYTES as u64);
    assert_eq!(limits["maxNoteChars"], MAX_NOTE_CHARS as u64);
    assert_eq!(limits["maxPathChars"], MAX_PATH_CHARS as u64);
    assert_eq!(limits["maxSegments"], MAX_SEGMENTS as u64);
    assert_eq!(limits["maxSegmentBytes"], MAX_SEGMENT_BYTES as u64);
    assert_eq!(limits["minPartSize"], MIN_PART_SIZE);
    assert_eq!(limits["maxPartSize"], MAX_PART_SIZE);
}

#[test]
fn every_message_reads_and_writes_byte_for_byte() {
    for case in vectors()["messages"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();

        let parsed = parse_send_message(text).unwrap_or_else(|| panic!("should read {text}"));

        assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), case["value"]);
    }
}

#[test]
fn every_rejected_message_is_turned_down() {
    for case in vectors()["rejected"].as_array().unwrap() {
        let text = case.as_str().unwrap();

        assert!(parse_send_message(text).is_none(), "should refuse {text}");
    }
}

#[test]
fn every_path_maps_as_the_desktop_maps_it() {
    for case in vectors()["paths"].as_array().unwrap() {
        let input = case["in"].as_str().unwrap();

        assert_eq!(
            safe_relative_path(input).as_deref(),
            case["out"].as_str(),
            "for {input:?}"
        );
    }
}

#[test]
fn paths_compare_without_minding_case() {
    assert_eq!(send_path_key("Photos/A.JPG"), send_path_key("photos/a.jpg"));
    assert_ne!(send_path_key("a/b"), send_path_key("a/c"));
}

#[test]
fn an_offer_holds_as_many_files_as_the_limit_and_no_more() {
    let offer = |n: usize| {
        let files: Vec<Value> = (0..n)
            .map(|i| json!({ "transferId": format!("t-{i}"), "path": format!("f{i}"), "size": 1 }))
            .collect();
        json!({ "t": "send-offer", "v": 1, "batchId": "b", "files": files }).to_string()
    };

    assert!(parse_send_message(&offer(MAX_FILES)).is_some());
    assert!(parse_send_message(&offer(MAX_FILES + 1)).is_none());
}

#[test]
fn a_note_is_counted_in_characters() {
    let note: String = "👋".repeat(MAX_NOTE_CHARS);
    let text = json!({
        "t": "send-offer", "v": 1, "batchId": "b",
        "files": [{ "transferId": "x", "path": "a", "size": 1 }],
        "note": note,
    })
    .to_string();

    assert!(matches!(
        parse_send_message(&text),
        Some(SendMessage::SendOffer { .. })
    ));
}

#[test]
fn the_largest_size_a_number_holds_exactly_is_taken() {
    let text = |size: u64| {
        json!({
            "t": "send-offer", "v": 1, "batchId": "b",
            "files": [{ "transferId": "x", "path": "a", "size": size }],
        })
        .to_string()
    };

    assert!(parse_send_message(&text(9_007_199_254_740_991)).is_some());
    assert!(parse_send_message(&text(9_007_199_254_740_993)).is_none());
}

#[test]
fn every_transfer_key_is_fnv_1a_over_utf16_units() {
    for case in vectors()["transferKeys"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();

        assert_eq!(
            u64::from(transfer_key(id)),
            case["key"].as_u64().unwrap(),
            "for {id}"
        );
    }
}

#[test]
fn every_chunk_frames_as_the_vector_says() {
    for case in vectors()["chunks"].as_array().unwrap() {
        let chunk = FileChunk {
            transfer_key: case["transferKey"].as_u64().unwrap() as u32,
            part_index: case["partIndex"].as_u64().unwrap() as u32,
            seq: case["seq"].as_u64().unwrap() as u32,
            bytes: hex::decode(case["bytes"].as_str().unwrap()).unwrap(),
        };
        let frame = hex::decode(case["frame"].as_str().unwrap()).unwrap();

        assert_eq!(encode_chunk(&chunk), frame);
        assert_eq!(frame[0], BIN_FILE_CHUNK);
        assert_eq!(decode_chunk(&frame), Some(chunk));
    }
}

#[test]
fn a_frame_too_short_or_of_another_kind_is_no_chunk() {
    assert_eq!(decode_chunk(&[BIN_FILE_CHUNK, 0, 0]), None);
    assert_eq!(decode_chunk(&[0x01; 20]), None);
}

#[test]
fn the_file_messages_read_and_write_as_the_desktop_writes_them() {
    let cases = [
        r#"{"t":"file-offer","transferId":"t1","name":"a.txt","size":5,"partSize":4194304,"partCount":1}"#,
        r#"{"t":"file-resume","transferId":"t1","missingParts":[0,2]}"#,
        r#"{"t":"file-part-done","transferId":"t1","partIndex":0,"hash":"ab","size":5}"#,
        r#"{"t":"file-part-ack","transferId":"t1","partIndex":0,"ok":true}"#,
        r#"{"t":"file-complete","transferId":"t1","hash":"ab"}"#,
        r#"{"t":"file-done","transferId":"t1","savedPath":"/inbox/a.txt","verified":true}"#,
        r#"{"t":"file-error","transferId":"t1","message":"No room."}"#,
        r#"{"t":"file-cancel","transferId":"t1"}"#,
    ];
    for text in cases {
        let message: FileMessage = serde_json::from_str(text).expect(text);

        assert_eq!(serde_json::to_string(&message).unwrap(), text);
    }
}
