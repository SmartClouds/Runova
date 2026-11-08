mod common;

use common::{World, connected, signed_in, signed_in_to_unattended};
use runova_ffi::engine::AppLifecycle;
use runova_ffi::frames::RemoteFrameSink;
use runova_ffi::remote::{RemoteKey, RemotePointer};
use runova_ffi::view::{ConnectionPhase, RemotePhase, RemoteView};
use runova_protocol::remote::{ControlMessage, InputEvent, MouseButton};
use runova_session::hub::{AccessMode, Intent};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Where a tile went and its bytes: x, y, w, h, JPEG.
type PaintedTile = (u16, u16, u16, u16, Vec<u8>);

#[derive(Default)]
struct Screen {
    sizes: Mutex<Vec<(u32, u32)>>,
    tiles: Mutex<Vec<PaintedTile>>,
    stopped: Mutex<bool>,
}

impl RemoteFrameSink for Screen {
    fn on_screen_size(&self, width: u32, height: u32) {
        self.sizes.lock().unwrap().push((width, height));
    }

    fn on_tile(&self, x: u16, y: u16, w: u16, h: u16, jpeg: Vec<u8>) {
        self.tiles.lock().unwrap().push((x, y, w, h, jpeg));
    }

    fn on_stopped(&self) {
        *self.stopped.lock().unwrap() = true;
    }
}

async fn wait_for(check: impl Fn() -> bool, label: &str) {
    for _ in 0..1000 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {label}");
}

/// The viewer open and showing the scripted computer's screen.
async fn live(world: &World, screen: &Arc<Screen>) -> RemoteView {
    world.engine.remote_open(5, screen.clone());
    let view = world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::Live)
            },
            "the screen",
        )
        .await;
    wait_for(
        || {
            world
                .computer
                .control_received
                .lock()
                .unwrap()
                .contains(&ControlMessage::ControlStart)
        },
        "asking for the screen",
    )
    .await;
    view.remote.expect("the remote view")
}

fn sent_inputs(world: &World) -> Vec<InputEvent> {
    world
        .computer
        .control_received
        .lock()
        .unwrap()
        .iter()
        .filter_map(|m| match m {
            ControlMessage::Input { event } => Some(event.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_a_screen_asks_to_control_and_shows_it_without_a_manage_session() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());

    let view = live(&world, &screen).await;

    assert_eq!(
        world.computer.intents.lock().unwrap().as_slice(),
        [(Intent::Control, AccessMode::Ask)]
    );
    assert_eq!((view.width, view.height), (1280, 720));
    assert_eq!(view.system_name, "Sam's desk");
    assert!(world.latest().unwrap().connection.is_none());
    let received = world.computer.control_received.lock().unwrap();
    assert!(matches!(&received[0], ControlMessage::Hello { intent, .. } if intent == "control"));
}

#[tokio::test(flavor = "multi_thread")]
async fn tiles_reach_the_sink_and_never_the_view() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    let jpeg = vec![0xFF, 0xD8, 0xFF, 0xD9, 42];
    world.computer.control_tile(128, 64, 128, 128, &jpeg);

    wait_for(|| !screen.tiles.lock().unwrap().is_empty(), "the tile").await;
    let tiles = screen.tiles.lock().unwrap();
    assert_eq!(tiles[0], (128, 64, 128, 128, jpeg));
    assert_eq!(screen.sizes.lock().unwrap().as_slice(), [(1280, 720)]);
    // The view carries the size and nothing of the picture.
    let published = format!("{:?}", world.latest().unwrap());
    assert!(!published.contains("255, 216"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_screen_size_reaches_the_view_and_the_sink() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world
        .computer
        .control_text(r#"{"t":"screen-info","width":1920,"height":1200}"#);

    let view = world
        .until(
            |v| v.remote.as_ref().is_some_and(|r| r.width == 1920),
            "the new size",
        )
        .await;
    assert_eq!(view.remote.unwrap().height, 1200);
    wait_for(
        || screen.sizes.lock().unwrap().contains(&(1920, 1200)),
        "the sink's new size",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn taps_become_mouse_clicks_at_the_computer() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world
        .engine
        .remote_pointer(RemotePointer::Tap { x: 0.5, y: 0.25 });
    world
        .engine
        .remote_pointer(RemotePointer::RightTap { x: 1.5, y: -0.25 });

    wait_for(|| sent_inputs(&world).len() >= 6, "the clicks").await;
    let left = MouseButton::Left;
    let right = MouseButton::Right;
    assert_eq!(
        sent_inputs(&world),
        vec![
            InputEvent::Move { x: 0.5, y: 0.25 },
            InputEvent::Down {
                x: 0.5,
                y: 0.25,
                button: left
            },
            InputEvent::Up {
                x: 0.5,
                y: 0.25,
                button: left
            },
            // Coordinates are clamped to the screen.
            InputEvent::Move { x: 1.0, y: 0.0 },
            InputEvent::Down {
                x: 1.0,
                y: 0.0,
                button: right
            },
            InputEvent::Up {
                x: 1.0,
                y: 0.0,
                button: right
            },
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drag_holds_the_button_and_collapses_the_moves() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world
        .engine
        .remote_pointer(RemotePointer::DragStart { x: 0.1, y: 0.1 });
    for step in 1..=5 {
        world.engine.remote_pointer(RemotePointer::DragMove {
            x: 0.1 + f64::from(step) / 10.0,
            y: 0.1,
        });
    }
    world
        .engine
        .remote_pointer(RemotePointer::DragEnd { x: 0.6, y: 0.1 });

    wait_for(
        || {
            sent_inputs(&world).iter().any(|e| {
                matches!(
                    e,
                    InputEvent::Up {
                        button: MouseButton::Left,
                        ..
                    }
                )
            })
        },
        "the drag's end",
    )
    .await;
    let events = sent_inputs(&world);
    assert_eq!(
        events[1],
        InputEvent::Down {
            x: 0.1,
            y: 0.1,
            button: MouseButton::Left,
        }
    );
    assert!(events.len() <= 8, "moves were not collapsed: {events:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn scrolling_adds_up_to_whole_wheel_notches_and_flips_for_touch() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    for _ in 0..3 {
        world.engine.remote_pointer(RemotePointer::Scroll {
            x: 0.5,
            y: 0.5,
            dx: 0.0,
            dy: -20.0,
        });
    }

    // 60 dp of travel is two whole notches, with the rest kept for the next swipe.
    let notch = InputEvent::Wheel {
        x: 0.5,
        y: 0.5,
        dx: 0.0,
        dy: 1.0,
    };
    wait_for(|| sent_inputs(&world).len() >= 2, "the wheel").await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(sent_inputs(&world), vec![notch.clone(), notch]);
}

#[tokio::test(flavor = "multi_thread")]
async fn typing_and_shortcuts_reach_the_computer() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world.engine.remote_text("héllo".into());
    world.engine.remote_key(RemoteKey::Enter);
    world.engine.remote_key(RemoteKey::CtrlC);

    wait_for(|| sent_inputs(&world).len() >= 7, "the keys").await;
    let key = |code: &str, down| InputEvent::Key {
        code: code.to_owned(),
        down,
    };
    assert_eq!(
        sent_inputs(&world),
        vec![
            InputEvent::Text {
                text: "héllo".into()
            },
            key("Enter", true),
            key("Enter", false),
            key("ControlLeft", true),
            key("KeyC", true),
            key("KeyC", false),
            key("ControlLeft", false),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_clipboard_goes_both_ways() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world
        .engine
        .remote_send_clipboard("from the phone".to_owned());
    world
        .computer
        .control_text(r#"{"t":"clipboard","text":"from the computer"}"#);

    let view = world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.clipboard.as_deref() == Some("from the computer"))
            },
            "the computer's clipboard",
        )
        .await;
    assert_eq!(
        view.remote.unwrap().note.as_deref(),
        Some("Sent to the computer's clipboard.")
    );
    wait_for(
        || {
            world
                .computer
                .control_received
                .lock()
                .unwrap()
                .contains(&ControlMessage::Clipboard {
                    text: "from the phone".into(),
                })
        },
        "the phone's clipboard at the computer",
    )
    .await;

    world.engine.remote_clipboard_taken();
    world
        .until(
            |v| v.remote.as_ref().is_some_and(|r| r.clipboard.is_none()),
            "the clipboard cleared",
        )
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_huge_clipboard_is_refused_with_a_note() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world.engine.remote_send_clipboard("x".repeat(300 * 1024));

    let view = world
        .until(
            |v| v.remote.as_ref().is_some_and(|r| r.note.is_some()),
            "the note",
        )
        .await;
    assert_eq!(
        view.remote.unwrap().note.as_deref(),
        Some("That's too much text to send.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_viewer_opened_from_the_list_goes_back_to_the_list_and_stops_the_frames() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;
    world.computer.control_tile(0, 0, 128, 128, &[1, 2, 3]);
    wait_for(|| !screen.tiles.lock().unwrap().is_empty(), "the tile").await;

    world.engine.remote_close();

    world.until(|v| v.remote.is_none(), "the viewer gone").await;
    wait_for(|| *screen.stopped.lock().unwrap(), "the frames stopped").await;
    assert!(world.latest().unwrap().connection.is_none());
    // Nothing holds on to the native sink any more, so the pixels can go.
    wait_for(
        || Arc::strong_count(&screen) == 1,
        "the sink let go by the core",
    )
    .await;
    assert_eq!(
        world.computer.intents.lock().unwrap().as_slice(),
        [(Intent::Control, AccessMode::Ask)]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_opened_from_a_managed_computer_returns_to_it() {
    let world = connected().await;
    let screen = Arc::new(Screen::default());

    live(&world, &screen).await;
    // One live link at a time: the manage session has made way.
    assert!(world.latest().unwrap().connection.is_none());

    world.engine.remote_close();

    world
        .until(
            |v| {
                v.remote.is_none()
                    && v.connection
                        .as_ref()
                        .is_some_and(|c| c.phase == ConnectionPhase::Connected)
            },
            "back on the managed computer",
        )
        .await;
    assert_eq!(
        world.computer.intents.lock().unwrap().as_slice(),
        [
            (Intent::Manage, AccessMode::Ask),
            (Intent::Control, AccessMode::Ask),
            (Intent::Manage, AccessMode::Ask),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_declines_is_reported_with_no_password_option_when_it_has_none() {
    let world = signed_in().await;
    world.computer.declines.store(true, Ordering::SeqCst);
    let screen = Arc::new(Screen::default());

    world.engine.remote_open(5, screen);

    let view = world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::Failed)
            },
            "the refusal",
        )
        .await;
    let remote = view.remote.unwrap();
    assert!(!remote.can_use_password);
    assert_eq!(
        remote.error.as_deref(),
        Some("The request was declined on the computer.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_with_a_password_offers_it_after_a_refusal_and_the_right_one_opens_it() {
    let world = signed_in_to_unattended().await;
    world.computer.declines.store(true, Ordering::SeqCst);
    *world.computer.password.lock().unwrap() = Some("correct horse".into());
    let screen = Arc::new(Screen::default());

    world.engine.remote_open(5, screen.clone());
    let view = world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::NeedsPassword)
            },
            "the password prompt",
        )
        .await;
    assert!(view.remote.unwrap().can_use_password);

    world.engine.remote_submit_password("wrong horse".into());
    let view = world
        .until(
            |v| {
                v.remote.as_ref().is_some_and(|r| {
                    r.phase == RemotePhase::NeedsPassword
                        && r.error.as_deref()
                            == Some("That password is not the one for this computer.")
                })
            },
            "the wrong password message",
        )
        .await;
    assert_eq!(view.remote.unwrap().system_id, 5);

    world.engine.remote_submit_password("correct horse".into());
    world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::Live)
            },
            "the screen",
        )
        .await;
    let intents = world.computer.intents.lock().unwrap().clone();
    assert_eq!(
        intents,
        vec![
            (Intent::Control, AccessMode::Ask),
            (Intent::Control, AccessMode::Password),
            (Intent::Control, AccessMode::Password),
        ]
    );
    drop(screen);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_background_agent_is_reached_over_the_relay_with_no_manage_session() {
    let world = signed_in().await;
    world.computer.agent.store(true, Ordering::SeqCst);
    let screen = Arc::new(Screen::default());

    let view = live(&world, &screen).await;

    assert!(view.agent);
    assert_eq!(view.direct, Some(false));
    assert!(world.latest().unwrap().connection.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_that_hangs_up_is_reported_and_the_frames_stop() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world.computer.hang_up_control();

    let view = world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::Failed)
            },
            "the end of the session",
        )
        .await;
    assert_eq!(
        view.remote.unwrap().error.as_deref(),
        Some("The connection to this computer ended.")
    );
    wait_for(|| *screen.stopped.lock().unwrap(), "the frames stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn input_is_ignored_when_no_viewer_is_open() {
    let world = signed_in().await;

    world
        .engine
        .remote_pointer(RemotePointer::Tap { x: 0.5, y: 0.5 });
    world.engine.remote_text("hello".into());
    world.engine.remote_key(RemoteKey::Enter);

    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(world.computer.control_received.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn going_to_the_background_closes_the_viewer_after_the_grace() {
    let world = signed_in().await;
    let screen = Arc::new(Screen::default());
    live(&world, &screen).await;

    world
        .engine
        .lifecycle(AppLifecycle::Backgrounded { grace_ms: 0 });

    world.until(|v| v.remote.is_none(), "the viewer gone").await;
    wait_for(|| *screen.stopped.lock().unwrap(), "the frames stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn asking_for_the_password_early_stops_the_wait_at_the_computer() {
    let world = signed_in_to_unattended().await;
    world.computer.keeps_ringing.store(true, Ordering::SeqCst);
    *world.computer.password.lock().unwrap() = Some("correct horse".into());
    let screen = Arc::new(Screen::default());
    world.engine.remote_open(5, screen);
    world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::WaitingForApproval)
            },
            "the wait at the computer",
        )
        .await;

    world.engine.remote_use_password();
    world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::NeedsPassword)
            },
            "the password prompt",
        )
        .await;

    world.engine.remote_submit_password("correct horse".into());
    world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::Live)
            },
            "the screen",
        )
        .await;
}
