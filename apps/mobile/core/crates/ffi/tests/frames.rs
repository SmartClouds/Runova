//! The queue that carries screen pieces to native code.

use runova_ffi::frames::{FrameQueue, RemoteFrameSink, start_pump};
use runova_session::viewer::{FrameOutlet, Tile};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn tile(x: u16, jpeg: Vec<u8>) -> Tile {
    Tile {
        frame_id: 1,
        x,
        y: 0,
        w: 128,
        h: 128,
        jpeg,
    }
}

#[derive(Default)]
struct Log {
    calls: Mutex<Vec<String>>,
    gate: Mutex<()>,
}

impl RemoteFrameSink for Log {
    fn on_screen_size(&self, width: u32, height: u32) {
        let _gate = self.gate.lock().unwrap();
        self.calls
            .lock()
            .unwrap()
            .push(format!("size {width}x{height}"));
    }

    fn on_tile(&self, x: u16, _y: u16, _w: u16, _h: u16, jpeg: Vec<u8>) {
        let _gate = self.gate.lock().unwrap();
        self.calls
            .lock()
            .unwrap()
            .push(format!("tile {x} {}", jpeg.len()));
    }

    fn on_stopped(&self) {
        let _gate = self.gate.lock().unwrap();
        self.calls.lock().unwrap().push("stopped".to_owned());
    }
}

async fn eventually(check: impl Fn() -> bool, label: &str) {
    for _ in 0..1000 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {label}");
}

#[tokio::test]
async fn a_newer_tile_for_the_same_place_replaces_the_older_one() {
    let queue = FrameQueue::new();

    queue.on_tile(tile(0, vec![1; 100]));
    queue.on_tile(tile(128, vec![2; 50]));
    queue.on_tile(tile(0, vec![3; 200]));

    assert_eq!(queue.queued_tiles(), 2);
    assert_eq!(queue.queued_bytes(), 250);
    assert_eq!(queue.dropped(), 0);
}

#[tokio::test]
async fn the_queue_is_bounded_and_drops_the_oldest_place_first() {
    let queue = FrameQueue::new();

    // Each tile is a distinct place, so nothing replaces anything here.
    for i in 0..5000u16 {
        queue.on_tile(Tile {
            x: i,
            ..tile(0, vec![0u8; 16])
        });
    }

    assert_eq!(queue.queued_tiles(), 4096);
    assert_eq!(queue.dropped(), 904);
}

#[tokio::test]
async fn a_resize_discards_what_was_queued_for_the_old_screen() {
    let queue = Arc::new(FrameQueue::new());
    let sink = Arc::new(Log::default());
    queue.on_tile(tile(0, vec![1]));
    queue.on_screen_size(1920, 1080);
    queue.on_tile(tile(128, vec![2]));
    start_pump(queue.clone(), sink.clone());

    eventually(
        || {
            sink.calls
                .lock()
                .unwrap()
                .contains(&"tile 128 1".to_owned())
        },
        "the tile",
    )
    .await;
    queue.stop();
    eventually(
        || sink.calls.lock().unwrap().last().map(String::as_str) == Some("stopped"),
        "stopping",
    )
    .await;
    assert_eq!(
        sink.calls.lock().unwrap().as_slice(),
        ["size 1920x1080", "tile 128 1", "stopped"]
    );
}

#[tokio::test]
async fn stopping_frees_everything_still_queued_and_nothing_more_arrives() {
    let queue = Arc::new(FrameQueue::new());
    let sink = Arc::new(Log::default());
    let gate = sink.gate.lock().unwrap();
    start_pump(queue.clone(), sink.clone());
    queue.on_tile(tile(0, vec![1; 1024]));
    // Whatever the pump has taken, the rest is let go at once by stop.
    queue.on_tile(tile(128, vec![1; 1024]));
    queue.stop();
    assert_eq!(queue.queued_bytes(), 0);

    queue.on_tile(tile(256, vec![1; 1024]));
    assert_eq!(queue.queued_bytes(), 0);
    drop(gate);

    eventually(
        || sink.calls.lock().unwrap().last().map(String::as_str) == Some("stopped"),
        "stopping",
    )
    .await;
    eventually(|| Arc::strong_count(&sink) == 1, "the sink let go").await;
}

#[tokio::test]
async fn a_single_tile_too_big_to_be_real_is_ignored() {
    let queue = FrameQueue::new();

    queue.on_tile(tile(0, vec![0u8; 9 * 1024 * 1024]));

    assert_eq!(queue.queued_tiles(), 0);
}
