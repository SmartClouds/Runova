//! The demo (E119): signing in with the website's demo page, and the computer inside the app that
//! answers every screen with made-up data and keeps nothing.

mod common;

use common::{DemoWorld, connected_demo, demo_world, in_demo, signed_in};
use runova_ffi::demo::{DEMO_SCREEN, answered_methods};
use runova_ffi::frames::RemoteFrameSink;
use runova_ffi::send::{PickedFile, PickedFiles};
use runova_ffi::view::{AuthState, RemotePhase, SendFileState, SendPhase};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn scanning_the_demo_page_signs_in_to_the_demo() {
    let demo = demo_world().await;

    demo.world
        .engine
        .scan_sign_in("https://runovahq.test/demo".into());

    let view = demo
        .world
        .until(
            |v| v.auth == AuthState::SignedIn && !v.systems.is_empty(),
            "the demo",
        )
        .await;
    assert!(view.demo);
    assert_eq!(view.qr_sign_in, None);
    assert_eq!(view.error, None);
    let bodies = demo.grants.bodies.lock().unwrap().clone();
    assert_eq!(bodies[0]["grantType"], "demo");
    assert_eq!(bodies[0]["platform"], "android");
    // The live hub and feed never hear from the demo.
    assert!(demo.world.computer.hub_events.lock().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn another_site_s_demo_page_is_not_ours() {
    let demo = demo_world().await;

    demo.world
        .engine
        .scan_sign_in("https://runovahq.com/demo".into());

    let view = demo.world.until(|v| v.error.is_some(), "the message").await;
    assert_eq!(
        view.error.as_deref(),
        Some("That isn't a Runova sign-in code.")
    );
    assert!(demo.grants.bodies.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_real_account_is_not_a_demo_and_uses_the_live_hub() {
    let world = signed_in().await;

    let view = world.latest().unwrap();

    assert!(!view.demo);
    assert!(world.computer.hub_events.lock().unwrap().is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_demo_computer_connects_and_lists_its_projects() {
    let demo = connected_demo().await;

    let view = demo
        .world
        .until(|v| !v.projects.is_empty(), "the projects")
        .await;

    assert!(view.projects.len() >= 3, "{:?}", view.projects);
    assert!(view.projects.iter().any(|p| p.has_repository));
    // The scripted computer behind the live switch is never asked anything.
    assert!(demo.world.computer.calls.lock().unwrap().is_empty());
    assert!(demo.world.computer.intents.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_terminals_answer_and_echo_what_is_typed() {
    let demo = connected_demo().await;
    demo.world.engine.load_terminals();
    let view = demo
        .world
        .until(|v| !v.terminals.is_empty(), "the terminals")
        .await;

    demo.world
        .engine
        .open_terminal(view.terminals[0].session_id.clone());
    demo.world
        .until(|v| v.terminal.is_some(), "the terminal")
        .await;
    demo.world.engine.terminal_input("hello demo".into());

    demo.world
        .until(
            |v| {
                v.terminal
                    .as_ref()
                    .is_some_and(|t| format!("{t:?}").contains("hello demo"))
            },
            "the echo",
        )
        .await;
}

fn manage_methods() -> BTreeSet<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/protocol/src/manage.ts"
    );
    let source = std::fs::read_to_string(path).expect("manage.ts");
    let start = source
        .find("export const MANAGE_METHODS")
        .expect("the method list");
    let end = start + source[start..].find("\n};").expect("its end");
    source[start..end]
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line.strip_prefix('\'')?;
            let name = &rest[..rest.find('\'')?];
            rest[name.len()..]
                .starts_with("':")
                .then(|| name.to_owned())
        })
        .collect()
}

/// Every method name the app's own code mentions, outside the demo.
fn methods_the_app_calls(known: &BTreeSet<String>) -> BTreeSet<String> {
    fn read_dir(dir: &std::path::Path, into: &mut String) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n != "demo") {
                    read_dir(&path, into);
                }
            } else if path.extension().is_some_and(|e| e == "rs") {
                into.push_str(&std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let mut source = String::new();
    read_dir(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut source,
    );
    known
        .iter()
        .filter(|m| source.contains(&format!("\"{m}\"")))
        .cloned()
        .collect()
}

#[test]
fn every_method_the_app_calls_has_a_demo_answer() {
    let known = manage_methods();
    assert!(known.len() > 100, "read {} methods", known.len());
    let answered: BTreeSet<String> = answered_methods().into_iter().collect();

    let missing: Vec<_> = methods_the_app_calls(&known)
        .into_iter()
        .filter(|m| !answered.contains(m))
        .collect();
    let unknown: Vec<_> = answered.iter().filter(|m| !known.contains(*m)).collect();

    assert!(missing.is_empty(), "no demo answer for {missing:?}");
    assert!(
        unknown.is_empty(),
        "demo answers for no method: {unknown:?}"
    );
}

#[derive(Default)]
struct Screen {
    sizes: Mutex<Vec<(u32, u32)>>,
    tiles: Mutex<Vec<(u16, u16, u16, u16)>>,
}

impl RemoteFrameSink for Screen {
    fn on_screen_size(&self, width: u32, height: u32) {
        self.sizes.lock().unwrap().push((width, height));
    }

    fn on_tile(&self, x: u16, y: u16, w: u16, h: u16, jpeg: Vec<u8>) {
        assert_eq!(jpeg, DEMO_SCREEN);
        self.tiles.lock().unwrap().push((x, y, w, h));
    }

    fn on_stopped(&self) {}
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

#[tokio::test(flavor = "multi_thread")]
async fn the_remote_screen_shows_the_demo_desktop() {
    let demo = in_demo().await;
    let screen = Arc::new(Screen::default());

    demo.world.engine.remote_open(5, screen.clone());

    demo.world
        .until(
            |v| {
                v.remote
                    .as_ref()
                    .is_some_and(|r| r.phase == RemotePhase::Live)
            },
            "the screen",
        )
        .await;
    wait_for(|| !screen.tiles.lock().unwrap().is_empty(), "a tile").await;
    assert_eq!(screen.sizes.lock().unwrap()[0], (1280, 720));
    assert_eq!(screen.tiles.lock().unwrap()[0], (0, 0, 1280, 720));
    demo.world.engine.remote_close();
    demo.world
        .until(|v| v.remote.is_none(), "the screen closed")
        .await;
}

#[derive(Default)]
struct Picked(Mutex<Vec<String>>);

impl PickedFiles for Picked {
    fn read(&self, _handle: String, offset: u64, length: u32) -> Option<Vec<u8>> {
        let size = 70_000u64;
        let end = (offset + u64::from(length)).min(size);
        Some(vec![7; (end - offset) as usize])
    }

    fn close(&self, handle: String) {
        self.0.lock().unwrap().push(handle);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn files_sent_to_the_demo_computer_finish_and_go_nowhere() {
    let demo = in_demo().await;
    demo.world
        .until(|v| !v.send.targets.is_empty(), "the targets")
        .await;
    let picked = Arc::new(Picked::default());

    demo.world.engine.send_files(
        5,
        vec![PickedFile {
            handle: "h1".into(),
            path: "beach.jpg".into(),
            size: 70_000,
        }],
        None,
        picked.clone(),
    );

    let view = demo
        .world
        .until(
            |v| {
                v.send
                    .batches
                    .first()
                    .is_some_and(|b| b.phase == SendPhase::Done)
            },
            "sent",
        )
        .await;
    let batch = view.send.batches.first().unwrap();
    assert!(batch.files.iter().all(|f| f.state == SendFileState::Done));
    assert!(demo.world.computer.offers.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_of_the_demo_leaves_no_demo_behind() {
    let DemoWorld { world, .. } = in_demo().await;

    world.engine.sign_out();

    let view = world
        .until(|v| v.auth == AuthState::SignedOut, "signed out")
        .await;
    assert!(!view.demo);
}
