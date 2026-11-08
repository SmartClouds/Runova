//! The remote-control wire format, checked against what `packages/protocol/src/index.ts` writes.

use runova_protocol::remote::{
    ControlMessage, InputEvent, MouseButton, REMOTE_PROTOCOL_VERSION, ScreenSize, TileHeader,
    decode_tile_header, parse_control,
};

#[test]
fn hello_is_written_like_the_desktops() {
    let hello = ControlMessage::Hello {
        role: "controller".into(),
        device_name: "Runova app".into(),
        protocol_version: REMOTE_PROTOCOL_VERSION,
        intent: "control".into(),
    };
    assert_eq!(
        serde_json::to_string(&hello).unwrap(),
        r#"{"t":"hello","role":"controller","deviceName":"Runova app","protocolVersion":4,"intent":"control"}"#
    );
}

#[test]
fn input_events_are_written_like_the_desktops() {
    let cases = [
        (
            InputEvent::Move { x: 0.25, y: 0.75 },
            r#"{"k":"move","x":0.25,"y":0.75}"#,
        ),
        (
            InputEvent::Down {
                x: 0.5,
                y: 0.5,
                button: MouseButton::Left,
            },
            r#"{"k":"down","x":0.5,"y":0.5,"button":"left"}"#,
        ),
        (
            InputEvent::Up {
                x: 0.5,
                y: 0.5,
                button: MouseButton::Right,
            },
            r#"{"k":"up","x":0.5,"y":0.5,"button":"right"}"#,
        ),
        (
            InputEvent::Wheel {
                x: 0.5,
                y: 0.5,
                dx: 0.0,
                dy: 2.0,
            },
            r#"{"k":"wheel","x":0.5,"y":0.5,"dx":0.0,"dy":2.0}"#,
        ),
        (
            InputEvent::Key {
                code: "Enter".into(),
                down: true,
            },
            r#"{"k":"key","code":"Enter","down":true}"#,
        ),
        (
            InputEvent::Text { text: "hi".into() },
            r#"{"k":"text","text":"hi"}"#,
        ),
    ];
    for (event, expected) in cases {
        let message = ControlMessage::Input { event };
        let written = serde_json::to_string(&message).unwrap();
        assert_eq!(written, format!(r#"{{"t":"input","event":{expected}}}"#));
    }
}

#[test]
fn a_tile_header_is_read_as_the_desktop_lays_it_out() {
    // kind(1) frameId(4) x(2) y(2) w(2) h(2), big-endian, then the JPEG.
    let mut frame = vec![0x01, 0, 0, 1, 2, 0, 128, 0, 16, 0, 128, 0, 64];
    frame.extend_from_slice(&[0xFF, 0xD8, 0xFF]);

    assert_eq!(
        decode_tile_header(&frame),
        Some(TileHeader {
            frame_id: 258,
            x: 128,
            y: 16,
            w: 128,
            h: 64,
        })
    );
}

#[test]
fn a_truncated_or_foreign_frame_is_not_a_tile() {
    let short = [0x01, 0, 0, 0, 1, 0, 0, 0, 0, 0, 10, 0, 10];
    assert_eq!(decode_tile_header(&short), None);
    let file_chunk = [0x02, 0, 0, 0, 1, 0, 0, 0, 0, 0, 10, 0, 10, 0xFF];
    assert_eq!(decode_tile_header(&file_chunk), None);
    let empty_tile = [0x01, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 10, 0xFF];
    assert_eq!(decode_tile_header(&empty_tile), None);
}

#[test]
fn messages_from_the_host_are_read() {
    assert_eq!(
        parse_control(
            r#"{"t":"auth-ok","deviceName":"Sam's desk","screen":{"width":1920,"height":1080}}"#
        ),
        Some(ControlMessage::AuthOk {
            device_name: "Sam's desk".into(),
            screen: ScreenSize {
                width: 1920,
                height: 1080
            },
        })
    );
    assert_eq!(
        parse_control(r#"{"t":"screen-info","width":800,"height":600}"#),
        Some(ControlMessage::ScreenInfo {
            width: 800,
            height: 600
        })
    );
    assert_eq!(
        parse_control(r#"{"t":"clipboard","text":"hello"}"#),
        Some(ControlMessage::Clipboard {
            text: "hello".into()
        })
    );
}

#[test]
fn messages_this_app_does_not_use_are_harmless() {
    assert_eq!(
        parse_control(r#"{"t":"rtc-offer","sdp":"v=0"}"#),
        Some(ControlMessage::Other)
    );
    assert_eq!(parse_control("not json"), None);
}
