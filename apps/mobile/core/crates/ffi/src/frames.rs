//! Screen pieces on their way to native code. They never pass through `AppView`, which is cloned
//! on every publish. A bounded queue holds the newest tile for each place on the screen: the host
//! only resends what changed, so dropping a tile for a place that has a newer one loses nothing.
//! One thread hands them over, so decoding on the native side slows nothing else.

use runova_session::viewer::{FrameOutlet, Tile};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

/// Well past a 4K screen's worth of the desktop's 128 px tiles.
const MAX_TILES: usize = 4096;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_ONE_TILE: usize = 8 * 1024 * 1024;

/// Draws what the core hands it. Calls come one at a time on a thread of their own, and `on_tile`
/// may take as long as decoding needs. After `on_stopped` no more calls come, so whatever was
/// drawn into can be released.
#[uniffi::export(with_foreign)]
pub trait RemoteFrameSink: Send + Sync {
    fn on_screen_size(&self, width: u32, height: u32);
    fn on_tile(&self, x: u16, y: u16, w: u16, h: u16, jpeg: Vec<u8>);
    fn on_stopped(&self);
}

fn place(tile: &Tile) -> u64 {
    (u64::from(tile.x) << 48)
        | (u64::from(tile.y) << 32)
        | (u64::from(tile.w) << 16)
        | u64::from(tile.h)
}

#[derive(Default)]
struct State {
    size: Option<(u32, u32)>,
    order: VecDeque<u64>,
    tiles: HashMap<u64, Tile>,
    bytes: usize,
    dropped: u64,
    stopped: bool,
}

impl State {
    fn clear(&mut self) {
        self.order.clear();
        self.tiles.clear();
        self.bytes = 0;
    }
}

enum Next {
    Size(u32, u32),
    Tile(Tile),
    Stop,
}

pub struct FrameQueue {
    state: Mutex<State>,
    ready: Condvar,
}

impl Default for FrameQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameQueue {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            ready: Condvar::new(),
        }
    }

    fn next(&self) -> Next {
        let mut state = self.state.lock().expect("frame queue");
        loop {
            if state.stopped {
                return Next::Stop;
            }
            if let Some((width, height)) = state.size.take() {
                return Next::Size(width, height);
            }
            if let Some(key) = state.order.pop_front() {
                let tile = state.tiles.remove(&key).expect("queued tile");
                state.bytes -= tile.jpeg.len();
                return Next::Tile(tile);
            }
            state = self.ready.wait(state).expect("frame queue");
        }
    }

    /// Everything still queued is let go at once.
    pub fn stop(&self) {
        let mut state = self.state.lock().expect("frame queue");
        state.stopped = true;
        state.size = None;
        state.clear();
        self.ready.notify_all();
    }

    pub fn queued_tiles(&self) -> usize {
        self.state.lock().expect("frame queue").tiles.len()
    }

    pub fn queued_bytes(&self) -> usize {
        self.state.lock().expect("frame queue").bytes
    }

    /// Tiles lost to the limits, not counting those replaced by a newer one for the same place.
    pub fn dropped(&self) -> u64 {
        self.state.lock().expect("frame queue").dropped
    }
}

impl FrameOutlet for FrameQueue {
    fn on_screen_size(&self, width: u32, height: u32) {
        let mut state = self.state.lock().expect("frame queue");
        if state.stopped {
            return;
        }
        // Pieces of the old screen do not fit the new one.
        state.clear();
        state.size = Some((width, height));
        self.ready.notify_one();
    }

    fn on_tile(&self, tile: Tile) {
        let length = tile.jpeg.len();
        if length > MAX_ONE_TILE {
            return;
        }
        let mut state = self.state.lock().expect("frame queue");
        if state.stopped {
            return;
        }
        let key = place(&tile);
        state.bytes += length;
        match state.tiles.insert(key, tile) {
            Some(replaced) => state.bytes -= replaced.jpeg.len(),
            None => state.order.push_back(key),
        }
        while state.bytes > MAX_BYTES || state.order.len() > MAX_TILES {
            let Some(oldest) = state.order.pop_front() else {
                break;
            };
            if let Some(dropped) = state.tiles.remove(&oldest) {
                state.bytes -= dropped.jpeg.len();
                state.dropped += 1;
            }
        }
        self.ready.notify_one();
    }
}

/// Starts handing tiles to native code. Ends after [`FrameQueue::stop`].
pub fn start_pump(queue: Arc<FrameQueue>, sink: Arc<dyn RemoteFrameSink>) {
    let pump = move || {
        loop {
            match queue.next() {
                Next::Size(width, height) => sink.on_screen_size(width, height),
                Next::Tile(tile) => sink.on_tile(tile.x, tile.y, tile.w, tile.h, tile.jpeg),
                Next::Stop => break,
            }
        }
        sink.on_stopped();
    };
    let _ = thread::Builder::new()
        .name("runova-remote-frames".to_owned())
        .spawn(pump);
}
