//! Showing a computer's screen. One task owns the link: it says hello as the desktop's controller
//! does, asks for the screen once the computer lets it in, passes screen pieces to a
//! [`FrameOutlet`], and writes input. Pointer moves are latest-wins, so a slow link can not build
//! a backlog of them.

use runova_link::secure::{LinkEvent, SecureLink};
use runova_protocol::remote::{
    ControlMessage, InputEvent, REMOTE_PROTOCOL_VERSION, TILE_JPEG_OFFSET, decode_tile_header,
    parse_control,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, mpsc};
use tokio::time::{Instant, sleep_until};

const OUTGOING_QUEUE: usize = 512;
/// How long a computer gets to let this phone in once the link is secure.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// One screen piece, moved to whoever draws it. Bytes never go through the app's view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tile {
    pub frame_id: u32,
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub jpeg: Vec<u8>,
}

/// Takes screen pieces as they arrive. Must not block: it runs on the link's own task.
pub trait FrameOutlet: Send + Sync {
    fn on_screen_size(&self, width: u32, height: u32);
    fn on_tile(&self, tile: Tile);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewerEnd {
    /// This phone closed it.
    Closed,
    /// The computer said goodbye or turned the phone away, in its own words.
    Host(String),
    /// The link went away.
    Lost,
    /// The computer never let this phone in.
    NoResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewerEvent {
    Ready {
        device_name: String,
        width: u32,
        height: u32,
    },
    ScreenSize {
        width: u32,
        height: u32,
    },
    Clipboard(String),
    Ended(ViewerEnd),
}

enum Outgoing {
    Input(InputEvent),
    Clipboard(String),
    Close,
}

/// The newest pointer position not yet written to the link.
#[derive(Default)]
struct LatestMove {
    position: Mutex<Option<(f64, f64)>>,
    changed: Notify,
}

impl LatestMove {
    fn take(&self) -> Option<(f64, f64)> {
        self.position.lock().expect("pointer position").take()
    }
}

/// The phone's side of a running viewer.
#[derive(Clone)]
pub struct ViewerHandle {
    outgoing: mpsc::Sender<Outgoing>,
    latest: Arc<LatestMove>,
}

impl ViewerHandle {
    /// The newest position replaces any not yet sent.
    pub fn move_to(&self, x: f64, y: f64) {
        *self.latest.position.lock().expect("pointer position") = Some((x, y));
        self.latest.changed.notify_one();
    }

    /// Queued in order. With no room the link has died, so the event is dropped with it.
    pub fn send_input(&self, event: InputEvent) {
        // A pending move goes first, so a press lands where the pointer went.
        if let Some((x, y)) = self.latest.take() {
            let _ = self
                .outgoing
                .try_send(Outgoing::Input(InputEvent::Move { x, y }));
        }
        let _ = self.outgoing.try_send(Outgoing::Input(event));
    }

    pub fn send_clipboard(&self, text: String) {
        let _ = self.outgoing.try_send(Outgoing::Clipboard(text));
    }

    pub fn close(&self) {
        let _ = self.outgoing.try_send(Outgoing::Close);
    }
}

struct Viewer {
    link: SecureLink,
    outlet: Arc<dyn FrameOutlet>,
    events: mpsc::Sender<ViewerEvent>,
    allowed: bool,
    last_size: Option<(u32, u32)>,
}

impl Viewer {
    async fn send(&mut self, message: &ControlMessage) -> bool {
        match serde_json::to_string(message) {
            Ok(text) => self.link.send_text(&text).await.is_ok(),
            Err(_) => false,
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        if self.last_size != Some((width, height)) && width > 0 && height > 0 {
            self.last_size = Some((width, height));
            self.outlet.on_screen_size(width, height);
        }
    }

    fn tile(&mut self, mut payload: Vec<u8>) {
        let Some(header) = decode_tile_header(&payload) else {
            return;
        };
        payload.drain(..TILE_JPEG_OFFSET);
        self.outlet.on_tile(Tile {
            frame_id: header.frame_id,
            x: header.x,
            y: header.y,
            w: header.w,
            h: header.h,
            jpeg: payload,
        });
    }

    /// `Some` when the session is over.
    async fn on_text(&mut self, text: &str) -> Option<ViewerEnd> {
        match parse_control(text) {
            Some(ControlMessage::AuthOk {
                device_name,
                screen,
            }) => {
                self.allowed = true;
                self.resize(screen.width, screen.height);
                let _ = self
                    .events
                    .send(ViewerEvent::Ready {
                        device_name,
                        width: screen.width,
                        height: screen.height,
                    })
                    .await;
                if !self.send(&ControlMessage::ControlStart).await {
                    return Some(ViewerEnd::Lost);
                }
                None
            }
            Some(ControlMessage::AuthFail { reason }) | Some(ControlMessage::Bye { reason }) => {
                Some(ViewerEnd::Host(reason))
            }
            Some(ControlMessage::ScreenInfo { width, height }) => {
                self.resize(width, height);
                let _ = self
                    .events
                    .send(ViewerEvent::ScreenSize { width, height })
                    .await;
                None
            }
            Some(ControlMessage::Clipboard { text }) => {
                let _ = self.events.send(ViewerEvent::Clipboard(text)).await;
                None
            }
            Some(ControlMessage::Ping) => {
                if self.send(&ControlMessage::Pong).await {
                    None
                } else {
                    Some(ViewerEnd::Lost)
                }
            }
            _ => None,
        }
    }

    async fn on_link(&mut self, event: LinkEvent) -> Option<ViewerEnd> {
        match event {
            LinkEvent::Text(text) => self.on_text(&text).await,
            LinkEvent::Binary(frame) => {
                self.tile(frame);
                None
            }
        }
    }

    async fn write_move(&mut self, latest: &LatestMove) -> bool {
        match latest.take() {
            Some((x, y)) => {
                self.send(&ControlMessage::Input {
                    event: InputEvent::Move { x, y },
                })
                .await
            }
            None => true,
        }
    }
}

async fn run(
    mut viewer: Viewer,
    mut outgoing: mpsc::Receiver<Outgoing>,
    latest: Arc<LatestMove>,
    device_name: String,
) {
    let hello = ControlMessage::Hello {
        role: "controller".to_owned(),
        device_name,
        protocol_version: REMOTE_PROTOCOL_VERSION,
        intent: "control".to_owned(),
    };
    if !viewer.send(&hello).await {
        finish(viewer, ViewerEnd::Lost).await;
        return;
    }
    let ready_by = Instant::now() + READY_TIMEOUT;
    let end = loop {
        tokio::select! {
            biased;
            command = outgoing.recv() => match command {
                None | Some(Outgoing::Close) => {
                    let bye = ControlMessage::Bye { reason: "controller disconnected".to_owned() };
                    let _ = viewer.send(&bye).await;
                    break ViewerEnd::Closed;
                }
                Some(Outgoing::Input(event)) => {
                    if !viewer.allowed {
                        continue;
                    }
                    if !viewer.send(&ControlMessage::Input { event }).await {
                        break ViewerEnd::Lost;
                    }
                }
                Some(Outgoing::Clipboard(text)) => {
                    if viewer.allowed && !viewer.send(&ControlMessage::Clipboard { text }).await {
                        break ViewerEnd::Lost;
                    }
                }
            },
            () = latest.changed.notified() => {
                if !viewer.allowed {
                    latest.take();
                } else if !viewer.write_move(&latest).await {
                    break ViewerEnd::Lost;
                }
            }
            event = viewer.link.next() => match event {
                Ok(event) => {
                    if let Some(end) = viewer.on_link(event).await {
                        break end;
                    }
                }
                Err(_) => break ViewerEnd::Lost,
            },
            () = sleep_until(ready_by), if !viewer.allowed => break ViewerEnd::NoResponse,
        }
    };
    finish(viewer, end).await;
}

async fn finish(mut viewer: Viewer, end: ViewerEnd) {
    viewer.link.close().await;
    let _ = viewer.events.send(ViewerEvent::Ended(end)).await;
}

/// Starts a viewer on a secured link. It ends when the link does or [`ViewerHandle::close`] is
/// called; either way an [`ViewerEvent::Ended`] comes last.
pub fn start_viewer(
    link: SecureLink,
    device_name: String,
    outlet: Arc<dyn FrameOutlet>,
    events: mpsc::Sender<ViewerEvent>,
) -> ViewerHandle {
    let (outgoing, commands) = mpsc::channel(OUTGOING_QUEUE);
    let latest = Arc::new(LatestMove::default());
    let viewer = Viewer {
        link,
        outlet,
        events,
        allowed: false,
        last_size: None,
    };
    tokio::spawn(run(viewer, commands, latest.clone(), device_name));
    ViewerHandle { outgoing, latest }
}
