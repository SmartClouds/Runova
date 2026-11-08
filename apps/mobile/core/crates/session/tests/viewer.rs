//! The viewer against a host running the real handshake and framing.

use runova_crypto::handshake::{Identity, Mode, os_random};
use runova_link::secure::{ControllerConfig, HostConfig, LinkEvent, SecureLink};
use runova_link::testing::memory_pair;
use runova_protocol::remote::{ControlMessage, InputEvent, MouseButton, parse_control};
use runova_session::viewer::{
    FrameOutlet, Tile, ViewerEnd, ViewerEvent, ViewerHandle, start_viewer,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(10);

/// Two ends of a secured link, as a phone and a computer would hold them.
async fn secured_pair() -> (SecureLink, SecureLink) {
    let (phone, computer) = memory_pair();
    let host_seed = [1u8; 32];
    let phone_seed = [2u8; 32];
    let host_public = Identity::from_seed(host_seed).public_key();
    let phone_public = Identity::from_seed(phone_seed).public_key();
    let host_side = tokio::spawn(async move {
        SecureLink::as_host(
            Box::new(computer),
            HostConfig {
                session_id: "s1".into(),
                mode: Mode::Ask,
                identity: Identity::from_seed(host_seed),
                expected_controller_key: phone_public,
                password_secret: None,
                local_fingerprint: "sha-256 BB".into(),
                remote_fingerprint: "sha-256 AA".into(),
            },
            false,
            &mut os_random,
        )
        .await
        .expect("the host handshake")
    });
    let link = SecureLink::as_controller(
        Box::new(phone),
        ControllerConfig {
            session_id: "s1".into(),
            mode: Mode::Ask,
            identity: Identity::from_seed(phone_seed),
            expected_host_key: host_public,
            password_secret: None,
            local_fingerprint: "sha-256 AA".into(),
            remote_fingerprint: "sha-256 BB".into(),
        },
        false,
        &mut os_random,
    )
    .await
    .expect("the controller handshake");
    (link, host_side.await.unwrap())
}

#[derive(Default)]
struct RecordingOutlet {
    sizes: Mutex<Vec<(u32, u32)>>,
    tiles: Mutex<Vec<Tile>>,
}

impl FrameOutlet for RecordingOutlet {
    fn on_screen_size(&self, width: u32, height: u32) {
        self.sizes.lock().unwrap().push((width, height));
    }

    fn on_tile(&self, tile: Tile) {
        self.tiles.lock().unwrap().push(tile);
    }
}

async fn next_control(host: &mut SecureLink) -> ControlMessage {
    match timeout(WAIT, host.next())
        .await
        .expect("a message")
        .unwrap()
    {
        LinkEvent::Text(text) => parse_control(&text).expect("a control message"),
        LinkEvent::Binary(_) => panic!("expected text"),
    }
}

async fn send(host: &mut SecureLink, json: &str) {
    host.send_text(json).await.unwrap();
}

fn tile_bytes(x: u16, y: u16, jpeg: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x01, 0, 0, 0, 7];
    frame.extend_from_slice(&x.to_be_bytes());
    frame.extend_from_slice(&y.to_be_bytes());
    frame.extend_from_slice(&128u16.to_be_bytes());
    frame.extend_from_slice(&128u16.to_be_bytes());
    frame.extend_from_slice(jpeg);
    frame
}

fn started() -> (
    Arc<RecordingOutlet>,
    mpsc::Sender<ViewerEvent>,
    mpsc::Receiver<ViewerEvent>,
) {
    let (events, queue) = mpsc::channel(32);
    (Arc::new(RecordingOutlet::default()), events, queue)
}

async fn expect_event(queue: &mut mpsc::Receiver<ViewerEvent>) -> ViewerEvent {
    timeout(WAIT, queue.recv())
        .await
        .expect("an event")
        .expect("the channel")
}

/// A viewer that has been let in by the computer.
async fn allowed_viewer() -> (
    ViewerHandle,
    SecureLink,
    Arc<RecordingOutlet>,
    mpsc::Receiver<ViewerEvent>,
) {
    let (phone, mut host) = secured_pair().await;
    let (outlet, events, mut queue) = started();
    let handle = start_viewer(phone, "Runova app".into(), outlet.clone(), events);
    assert!(matches!(
        next_control(&mut host).await,
        ControlMessage::Hello { .. }
    ));
    send(
        &mut host,
        r#"{"t":"auth-ok","deviceName":"Sam's desk","screen":{"width":1920,"height":1080}}"#,
    )
    .await;
    assert_eq!(next_control(&mut host).await, ControlMessage::ControlStart);
    assert_eq!(
        expect_event(&mut queue).await,
        ViewerEvent::Ready {
            device_name: "Sam's desk".into(),
            width: 1920,
            height: 1080,
        }
    );
    (handle, host, outlet, queue)
}

#[tokio::test]
async fn it_introduces_itself_as_the_desktops_controller_does() {
    let (phone, mut host) = secured_pair().await;
    let (outlet, events, _queue) = started();
    let _viewer = start_viewer(phone, "Runova app".into(), outlet, events);

    assert_eq!(
        next_control(&mut host).await,
        ControlMessage::Hello {
            role: "controller".into(),
            device_name: "Runova app".into(),
            protocol_version: 4,
            intent: "control".into(),
        }
    );
}

#[tokio::test]
async fn once_let_in_it_asks_for_the_screen_and_passes_tiles_on_untouched() {
    let (_viewer, mut host, outlet, _queue) = allowed_viewer().await;

    let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
    host.send_binary(&tile_bytes(256, 128, &jpeg))
        .await
        .unwrap();

    for _ in 0..200 {
        if !outlet.tiles.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(outlet.sizes.lock().unwrap().as_slice(), [(1920, 1080)]);
    let tiles = outlet.tiles.lock().unwrap();
    assert_eq!(tiles.len(), 1);
    assert_eq!((tiles[0].x, tiles[0].y), (256, 128));
    assert_eq!(tiles[0].jpeg, jpeg);
}

#[tokio::test]
async fn a_new_screen_size_is_told_once_and_junk_frames_are_ignored() {
    let (_viewer, mut host, outlet, mut queue) = allowed_viewer().await;

    send(
        &mut host,
        r#"{"t":"screen-info","width":1280,"height":800}"#,
    )
    .await;
    assert_eq!(
        expect_event(&mut queue).await,
        ViewerEvent::ScreenSize {
            width: 1280,
            height: 800
        }
    );
    send(
        &mut host,
        r#"{"t":"screen-info","width":1280,"height":800}"#,
    )
    .await;
    expect_event(&mut queue).await;
    host.send_binary(&[9, 9, 9]).await.unwrap();
    send(&mut host, r#"{"t":"clipboard","text":"from the computer"}"#).await;

    assert_eq!(
        expect_event(&mut queue).await,
        ViewerEvent::Clipboard("from the computer".into())
    );
    assert_eq!(
        outlet.sizes.lock().unwrap().as_slice(),
        [(1920, 1080), (1280, 800)]
    );
    assert!(outlet.tiles.lock().unwrap().is_empty());
}

#[tokio::test]
async fn input_is_sent_in_order_with_a_pending_move_first() {
    let (viewer, mut host, _outlet, _queue) = allowed_viewer().await;

    viewer.move_to(0.1, 0.2);
    viewer.send_input(InputEvent::Down {
        x: 0.1,
        y: 0.2,
        button: MouseButton::Left,
    });
    viewer.send_input(InputEvent::Text { text: "hi".into() });
    viewer.send_clipboard("from the phone".into());

    assert_eq!(
        next_control(&mut host).await,
        ControlMessage::Input {
            event: InputEvent::Move { x: 0.1, y: 0.2 }
        }
    );
    assert_eq!(
        next_control(&mut host).await,
        ControlMessage::Input {
            event: InputEvent::Down {
                x: 0.1,
                y: 0.2,
                button: MouseButton::Left
            }
        }
    );
    assert_eq!(
        next_control(&mut host).await,
        ControlMessage::Input {
            event: InputEvent::Text { text: "hi".into() }
        }
    );
    assert_eq!(
        next_control(&mut host).await,
        ControlMessage::Clipboard {
            text: "from the phone".into()
        }
    );
}

#[tokio::test]
async fn many_moves_before_the_link_is_free_collapse_to_the_newest() {
    let (viewer, mut host, _outlet, _queue) = allowed_viewer().await;

    for step in 1..=50 {
        viewer.move_to(f64::from(step) / 100.0, 0.5);
    }
    let first = next_control(&mut host).await;
    let ControlMessage::Input {
        event: InputEvent::Move { x, .. },
    } = first
    else {
        panic!("expected a move, got {first:?}");
    };

    assert!(x >= 0.5, "stale move sent: {x}");
}

#[tokio::test]
async fn a_ping_gets_a_pong() {
    let (_viewer, mut host, _outlet, _queue) = allowed_viewer().await;

    send(&mut host, r#"{"t":"ping"}"#).await;

    assert_eq!(next_control(&mut host).await, ControlMessage::Pong);
}

#[tokio::test]
async fn the_computers_goodbye_ends_the_viewer_with_its_reason() {
    let (_viewer, mut host, _outlet, mut queue) = allowed_viewer().await;

    send(
        &mut host,
        r#"{"t":"bye","reason":"the host ended the session"}"#,
    )
    .await;

    assert_eq!(
        expect_event(&mut queue).await,
        ViewerEvent::Ended(ViewerEnd::Host("the host ended the session".into()))
    );
}

#[tokio::test]
async fn a_lost_link_ends_the_viewer() {
    let (_viewer, mut host, _outlet, mut queue) = allowed_viewer().await;

    host.close().await;

    assert_eq!(
        expect_event(&mut queue).await,
        ViewerEvent::Ended(ViewerEnd::Lost)
    );
}

#[tokio::test]
async fn closing_says_goodbye_and_ends_the_viewer() {
    let (viewer, mut host, _outlet, mut queue) = allowed_viewer().await;

    viewer.close();

    assert!(matches!(
        next_control(&mut host).await,
        ControlMessage::Bye { .. }
    ));
    assert_eq!(
        expect_event(&mut queue).await,
        ViewerEvent::Ended(ViewerEnd::Closed)
    );
}

#[tokio::test(start_paused = true)]
async fn a_computer_that_never_lets_the_phone_in_is_reported() {
    let (phone, host) = secured_pair().await;
    let (outlet, events, mut queue) = started();
    let _viewer = start_viewer(phone, "Runova app".into(), outlet, events);
    // The host keeps the link open and says nothing.
    let _host = host;

    assert_eq!(
        queue.recv().await,
        Some(ViewerEvent::Ended(ViewerEnd::NoResponse))
    );
}

#[tokio::test]
async fn nothing_is_sent_before_the_computer_lets_the_phone_in() {
    let (phone, mut host) = secured_pair().await;
    let (outlet, events, mut queue) = started();
    let viewer = start_viewer(phone, "Runova app".into(), outlet, events);
    assert!(matches!(
        next_control(&mut host).await,
        ControlMessage::Hello { .. }
    ));

    viewer.send_input(InputEvent::Text {
        text: "early".into(),
    });
    viewer.move_to(0.5, 0.5);
    send(
        &mut host,
        r#"{"t":"auth-ok","deviceName":"d","screen":{"width":0,"height":0}}"#,
    )
    .await;

    assert_eq!(next_control(&mut host).await, ControlMessage::ControlStart);
    assert!(matches!(
        expect_event(&mut queue).await,
        ViewerEvent::Ready { width: 0, .. }
    ));
}
