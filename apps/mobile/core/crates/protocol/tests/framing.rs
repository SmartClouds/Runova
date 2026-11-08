//! Link framing against `packages/protocol/test-vectors/anywhere-v1.json`, the file the desktop's
//! Vitest and the background agent's xUnit also read.

use runova_protocol::framing::{LINK_MAX_FRAME, LinkKind, LinkReassembler, encode_link_message};
use sha2::{Digest, Sha256};

fn vectors() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/test-vectors/anywhere-v1.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vector file")).expect("json")
}

fn pattern(length: usize) -> Vec<u8> {
    (0..length).map(|i| (i % 251) as u8).collect()
}

#[test]
fn a_short_text_message_is_one_frame_byte_for_byte() {
    let framing = &vectors()["framing"];
    let payload = hex::decode(framing["textPayload"].as_str().unwrap()).unwrap();

    let frames = encode_link_message(LinkKind::Text, &payload, 0).unwrap();

    let expected: Vec<String> = framing["textFrames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(frames.iter().map(hex::encode).collect::<Vec<_>>(), expected);
}

#[test]
fn a_long_binary_message_fragments_exactly_as_the_vectors_say() {
    let framing = &vectors()["framing"];
    let length = framing["binaryLength"].as_u64().unwrap() as usize;
    let id = framing["binaryMessageId"].as_u64().unwrap() as u32;

    let payload: Vec<u8> = (0..length).map(|i| (i * 7 % 256) as u8).collect();

    let frames = encode_link_message(LinkKind::Binary, &payload, id).unwrap();

    let headers = framing["binaryFrameHeaders"].as_array().unwrap();
    let lengths = framing["binaryFrameLengths"].as_array().unwrap();
    let hashes = framing["binaryFrameSha256"].as_array().unwrap();
    assert_eq!(frames.len(), headers.len());
    for (index, frame) in frames.iter().enumerate() {
        assert_eq!(hex::encode(&frame[..10]), headers[index].as_str().unwrap());
        assert_eq!(frame.len() as u64, lengths[index].as_u64().unwrap());
        assert_eq!(
            hex::encode(Sha256::digest(frame)),
            hashes[index].as_str().unwrap()
        );
    }
}

#[test]
fn fragments_reassemble_into_the_original_message() {
    let payload = pattern(150_000);
    let frames = encode_link_message(LinkKind::Binary, &payload, 7).unwrap();
    let mut reassembler = LinkReassembler::new();

    let mut done = None;
    for frame in &frames {
        assert!(done.is_none());
        done = reassembler.push(frame).unwrap();
    }

    let message = done.expect("a whole message");
    assert_eq!(message.kind, LinkKind::Binary);
    assert_eq!(message.payload, payload);
}

#[test]
fn no_frame_is_longer_than_a_data_channel_accepts() {
    let frames = encode_link_message(LinkKind::Binary, &pattern(500_000), 1).unwrap();
    assert!(frames.iter().all(|f| f.len() <= LINK_MAX_FRAME));
}

#[test]
fn malformed_frames_are_refused() {
    let fragments = encode_link_message(LinkKind::Binary, &pattern(70_000), 1).unwrap();

    assert!(LinkReassembler::new().push(&[]).is_err());
    assert!(LinkReassembler::new().push(&[9, 1, 2]).is_err());
    assert!(LinkReassembler::new().push(&[3, 0, 0]).is_err());
    // The second fragment with no first.
    assert!(LinkReassembler::new().push(&fragments[1]).is_err());
    // A whole message in the middle of a fragmented one.
    let mut interrupted = LinkReassembler::new();
    interrupted.push(&fragments[0]).unwrap();
    assert!(interrupted.push(&[1, b'{', b'}']).is_err());
}

#[test]
fn a_message_over_the_limit_is_refused_before_it_fills_memory() {
    let frames = encode_link_message(LinkKind::Binary, &pattern(200_000), 1).unwrap();
    let mut small = LinkReassembler::with_limit(100_000);

    let result = frames.iter().try_for_each(|f| small.push(f).map(|_| ()));

    assert!(result.is_err());
}
