//! The parts of direct links that need no network.

use runova_rtc::signals::{Signal, fingerprint_of};
use runova_rtc::stun::{binding_request, read_mapped_address};
use std::net::SocketAddr;

#[test]
fn a_fingerprint_is_written_as_the_desktop_writes_it() {
    let sdp = "v=0\r\na=fingerprint:SHA-256 ab:cd:ef\r\nm=application\r\n";

    assert_eq!(fingerprint_of(sdp), "sha-256 AB:CD:EF");
}

#[test]
fn an_sdp_with_no_fingerprint_gives_an_empty_one() {
    assert_eq!(fingerprint_of("v=0\r\n"), "");
}

#[test]
fn an_offer_has_the_desktops_shape() {
    let text = Signal::Sdp {
        kind: "offer".into(),
        sdp: "v=0".into(),
    }
    .to_json();

    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"k":"sdp","type":"offer","sdp":"v=0"})
    );
}

#[test]
fn signals_from_the_desktop_are_read() {
    assert_eq!(
        Signal::parse(r#"{"k":"sdp","type":"answer","sdp":"v=0"}"#),
        Some(Signal::Sdp {
            kind: "answer".into(),
            sdp: "v=0".into()
        })
    );
    assert_eq!(
        Signal::parse(
            r#"{"k":"ice","candidate":"candidate:1 1 udp","sdpMid":"0","sdpMLineIndex":0}"#
        ),
        Some(Signal::Ice {
            candidate: "candidate:1 1 udp".into()
        })
    );
}

#[test]
fn anything_else_is_ignored() {
    assert_eq!(Signal::parse(r#"{"k":"relay"}"#), None);
    assert_eq!(Signal::parse("not json"), None);
}

#[test]
fn a_stun_request_is_a_well_formed_binding_request() {
    let id = [7u8; 12];
    let request = binding_request(&id);

    assert_eq!(request.len(), 20);
    assert_eq!(&request[..2], &[0x00, 0x01]);
    assert_eq!(&request[2..4], &[0x00, 0x00]);
    assert_eq!(&request[4..8], &[0x21, 0x12, 0xA4, 0x42]);
    assert_eq!(&request[8..], &id);
}

/// A success response carrying one XOR-MAPPED-ADDRESS for 192.0.2.1:32853 (RFC 5769 style).
fn response(id: &[u8; 12]) -> Vec<u8> {
    let mut packet = vec![0x01, 0x01, 0x00, 0x0C, 0x21, 0x12, 0xA4, 0x42];
    packet.extend_from_slice(id);
    packet.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
    packet.extend_from_slice(&[0xA1, 0x47]);
    packet.extend_from_slice(&[0xE1, 0x12, 0xA6, 0x43]);
    packet
}

#[test]
fn the_mapped_address_is_read_from_a_response() {
    let id = [9u8; 12];

    let address = read_mapped_address(&response(&id), &id);

    assert_eq!(
        address,
        Some("192.0.2.1:32853".parse::<SocketAddr>().unwrap())
    );
}

#[test]
fn a_response_to_someone_elses_request_is_ignored() {
    assert_eq!(read_mapped_address(&response(&[9u8; 12]), &[1u8; 12]), None);
}

#[test]
fn a_short_packet_is_ignored() {
    assert_eq!(read_mapped_address(&[1, 1, 0], &[0u8; 12]), None);
}
