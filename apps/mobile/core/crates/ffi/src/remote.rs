//! Showing and using a computer's screen. A phone holds one live link to a computer, so the viewer
//! takes the place of a management session and hands back to it on close. The screen itself goes
//! around the view, through [`crate::frames`].

use crate::engine::{Done, Engine, Runner};
use crate::frames::{FrameQueue, RemoteFrameSink, start_pump};
use crate::secure::{SecurePins, identity_seed};
use crate::view::{RemotePhase, RemoteView};
use runova_protocol::remote::{InputEvent, MouseButton};
use runova_session::connect::{ConnectError, ConnectTarget, ControlLink, Phase, connect_control};
use runova_session::hub::HostKind;
use runova_session::viewer::{ViewerEnd, ViewerEvent, ViewerHandle, start_viewer};
use std::sync::Arc;
use tokio::sync::mpsc;

const CONTROLLER_NAME: &str = "Runova app";
const VIEWER_EVENTS: usize = 32;
const HUB_EVENT_QUEUE: usize = 256;
/// Finger travel, in dp, for one wheel notch.
const DP_PER_NOTCH: f64 = 24.0;
/// A clipboard this big is a mistake. Text of this size also has to cross the hub-free link.
const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;
const MAX_TYPED_CHARS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Enum)]
pub enum RemotePointer {
    Tap { x: f64, y: f64 },
    RightTap { x: f64, y: f64 },
    DragStart { x: f64, y: f64 },
    DragMove { x: f64, y: f64 },
    DragEnd { x: f64, y: f64 },
    Scroll { x: f64, y: f64, dx: f64, dy: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RemoteKey {
    Escape,
    Tab,
    Enter,
    Backspace,
    Delete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Windows,
    CtrlC,
    CtrlV,
    CtrlZ,
    CtrlA,
    AltTab,
    AltF4,
}

/// DOM `KeyboardEvent.code` values, held down in order and let go in reverse.
fn key_codes(key: RemoteKey) -> &'static [&'static str] {
    match key {
        RemoteKey::Escape => &["Escape"],
        RemoteKey::Tab => &["Tab"],
        RemoteKey::Enter => &["Enter"],
        RemoteKey::Backspace => &["Backspace"],
        RemoteKey::Delete => &["Delete"],
        RemoteKey::Up => &["ArrowUp"],
        RemoteKey::Down => &["ArrowDown"],
        RemoteKey::Left => &["ArrowLeft"],
        RemoteKey::Right => &["ArrowRight"],
        RemoteKey::Home => &["Home"],
        RemoteKey::End => &["End"],
        RemoteKey::PageUp => &["PageUp"],
        RemoteKey::PageDown => &["PageDown"],
        RemoteKey::Windows => &["MetaLeft"],
        RemoteKey::CtrlC => &["ControlLeft", "KeyC"],
        RemoteKey::CtrlV => &["ControlLeft", "KeyV"],
        RemoteKey::CtrlZ => &["ControlLeft", "KeyZ"],
        RemoteKey::CtrlA => &["ControlLeft", "KeyA"],
        RemoteKey::AltTab => &["AltLeft", "Tab"],
        RemoteKey::AltF4 => &["AltLeft", "F4"],
    }
}

/// The key presses for one key, in the order they happen.
fn key_events(key: RemoteKey) -> Vec<InputEvent> {
    let codes = key_codes(key);
    let down = codes.iter().map(|code| InputEvent::Key {
        code: (*code).to_owned(),
        down: true,
    });
    let up = codes.iter().rev().map(|code| InputEvent::Key {
        code: (*code).to_owned(),
        down: false,
    });
    down.chain(up).collect()
}

fn clamp01(value: f64) -> f64 {
    if value.is_nan() {
        0.5
    } else {
        value.clamp(0.0, 1.0)
    }
}

fn click(x: f64, y: f64, button: MouseButton) -> [InputEvent; 3] {
    [
        InputEvent::Move { x, y },
        InputEvent::Down { x, y, button },
        InputEvent::Up { x, y, button },
    ]
}

/// Whole wheel notches, keeping what is left over for the next call. Fingers moving up push the
/// page up, which is a wheel turning down.
fn notches(travelled: &mut f64, delta_dp: f64) -> f64 {
    *travelled -= delta_dp;
    let whole = (*travelled / DP_PER_NOTCH).trunc();
    *travelled -= whole * DP_PER_NOTCH;
    whole
}

pub(crate) struct RemoteSession {
    system_id: i64,
    can_use_password: bool,
    back_to: Option<i64>,
    sink: Arc<dyn RemoteFrameSink>,
    queue: Option<Arc<FrameQueue>>,
    viewer: Option<ViewerHandle>,
    session_id: Option<String>,
    scroll_x: f64,
    scroll_y: f64,
}

impl Runner {
    fn remote_open(&mut self, system_id: i64, sink: Arc<dyn RemoteFrameSink>) {
        // Coming from a managed computer, closing the viewer goes back to it.
        let back_to = self.session.is_some().then_some(self.return_to).flatten();
        self.start_remote(system_id, sink, back_to, None);
    }

    /// `back_to` is where closing the viewer returns to, and survives password retries.
    fn start_remote(
        &mut self,
        system_id: i64,
        sink: Arc<dyn RemoteFrameSink>,
        back_to: Option<i64>,
        password: Option<String>,
    ) {
        self.end_connection();
        let Some(entry) = self.systems.iter().find(|s| s.id == system_id).cloned() else {
            return;
        };
        let can_use_password = entry.unattended;
        let mut view = RemoteView {
            system_id,
            system_name: entry.name.clone(),
            phase: RemotePhase::Requesting,
            error: None,
            can_use_password,
            agent: false,
            width: 0,
            height: 0,
            direct: None,
            safety_code: None,
            clipboard: None,
            note: None,
        };
        self.return_to = back_to;
        let (Some(hub), Some(device_id)) = (self.hub.clone(), self.device_id) else {
            view.phase = RemotePhase::Failed;
            view.error = Some("Not connected to Runova yet. Try again in a moment.".to_owned());
            self.view.remote = Some(view);
            return;
        };
        self.view.remote = Some(view);
        self.remote = Some(RemoteSession {
            system_id,
            can_use_password,
            back_to,
            sink,
            queue: None,
            viewer: None,
            session_id: None,
            scroll_x: 0.0,
            scroll_y: 0.0,
        });
        let attempt = self.attempt;
        let target = ConnectTarget {
            remote_id: entry.remote_id,
            device_id,
            identity_seed: identity_seed(self.deps.secure.as_ref()),
        };
        let (events, mut queue) = mpsc::channel(HUB_EVENT_QUEUE);
        let done = self.done_tx.clone();
        let phases = self.done_tx.clone();
        let transports = self.deps.transports.clone();
        let pins = SecurePins(self.deps.secure.clone());
        let task = tokio::spawn(async move {
            let on_phase = move |phase: Phase| {
                let _ = phases.send(Done::Run {
                    attempt,
                    task: Box::new(move |runner: &mut Runner| runner.on_remote_phase(phase)),
                });
            };
            let result = connect_control(
                target,
                password,
                hub.as_ref(),
                transports.as_ref(),
                &pins,
                &mut queue,
                &on_phase,
            )
            .await;
            let _ = done.send(Done::Run {
                attempt,
                task: Box::new(move |runner: &mut Runner| runner.on_remote_link(result)),
            });
        });
        self.connecting = Some((events, task));
    }

    fn on_remote_phase(&mut self, phase: Phase) {
        let Some(view) = self.view.remote.as_mut() else {
            return;
        };
        view.phase = match phase {
            Phase::Requesting => RemotePhase::Requesting,
            Phase::WaitingForApproval => RemotePhase::WaitingForApproval,
            Phase::Connecting => RemotePhase::Connecting,
            Phase::Securing | Phase::Connected { .. } => RemotePhase::Securing,
        };
    }

    fn on_remote_link(&mut self, result: Result<ControlLink, ConnectError>) {
        self.connecting = None;
        let (Some(session), Some(view)) = (self.remote.as_mut(), self.view.remote.as_mut()) else {
            return;
        };
        match result {
            Ok(control) => {
                view.safety_code = Some(control.safety_code);
                view.direct = Some(control.direct);
                view.agent = control.host_kind == HostKind::Agent;
                view.phase = RemotePhase::Securing;
                let queue = Arc::new(FrameQueue::new());
                start_pump(queue.clone(), session.sink.clone());
                let (events, mut receive) = mpsc::channel(VIEWER_EVENTS);
                let viewer = start_viewer(
                    control.link,
                    CONTROLLER_NAME.to_owned(),
                    queue.clone(),
                    events,
                );
                session.queue = Some(queue);
                session.viewer = Some(viewer);
                session.session_id = Some(control.session_id);
                let attempt = self.attempt;
                let done = self.done_tx.clone();
                tokio::spawn(async move {
                    while let Some(event) = receive.recv().await {
                        let sent = done.send(Done::Run {
                            attempt,
                            task: Box::new(move |runner: &mut Runner| {
                                runner.on_viewer_event(event)
                            }),
                        });
                        if sent.is_err() {
                            break;
                        }
                    }
                });
            }
            Err(ConnectError::WrongPassword) => {
                view.phase = RemotePhase::NeedsPassword;
                view.error = Some(ConnectError::WrongPassword.to_string());
            }
            Err(
                error @ (ConnectError::Declined
                | ConnectError::Unavailable
                | ConnectError::NoAnswer),
            ) if session.can_use_password => {
                view.phase = RemotePhase::NeedsPassword;
                view.error = Some(error.to_string());
            }
            Err(error) => {
                view.phase = RemotePhase::Failed;
                view.error = Some(error.to_string());
            }
        }
    }

    fn on_viewer_event(&mut self, event: ViewerEvent) {
        let Some(view) = self.view.remote.as_mut() else {
            return;
        };
        match event {
            ViewerEvent::Ready { width, height, .. } => {
                view.phase = RemotePhase::Live;
                view.width = width;
                view.height = height;
            }
            ViewerEvent::ScreenSize { width, height } => {
                view.width = width;
                view.height = height;
            }
            ViewerEvent::Clipboard(text) => view.clipboard = Some(text),
            ViewerEvent::Ended(end) => {
                let message = match end {
                    ViewerEnd::Closed => return,
                    ViewerEnd::Host(_) => "The computer ended this session.",
                    ViewerEnd::Lost => "The connection to this computer ended.",
                    ViewerEnd::NoResponse => "This computer did not start sharing its screen.",
                };
                view.phase = RemotePhase::Failed;
                view.error = Some(message.to_owned());
                self.stop_remote_link();
            }
        }
    }

    /// Ends the link and lets go of the frames, keeping what is on screen for now.
    fn stop_remote_link(&mut self) {
        let Some(session) = self.remote.as_mut() else {
            return;
        };
        if let Some(queue) = session.queue.take() {
            queue.stop();
        }
        if let Some(viewer) = session.viewer.take() {
            viewer.close();
        }
        if let (Some(id), Some(hub)) = (session.session_id.take(), self.hub.clone()) {
            tokio::spawn(async move { hub.end(&id).await });
        }
    }

    /// Called whenever the phone's computer link ends. Native code gets `on_stopped` soon after.
    pub(crate) fn stop_remote(&mut self) {
        self.stop_remote_link();
        self.remote = None;
        self.view.remote = None;
    }

    fn remote_close(&mut self) {
        let back_to = self.remote.as_ref().and_then(|s| s.back_to);
        self.end_connection();
        if let Some(system) = back_to {
            self.connect(system);
        }
    }

    fn remote_submit_password(&mut self, password: String) {
        let Some(session) = self.remote.as_ref() else {
            return;
        };
        let (system_id, sink, back_to) = (session.system_id, session.sink.clone(), session.back_to);
        self.start_remote(system_id, sink, back_to, Some(password));
    }

    /// Stops waiting at the computer and asks for its password instead.
    fn remote_use_password(&mut self) {
        let can_use_password = self.remote.as_ref().is_some_and(|s| s.can_use_password);
        let Some(view) = self.view.remote.as_mut() else {
            return;
        };
        if !can_use_password || view.phase == RemotePhase::Live {
            return;
        }
        if let Some((_, task)) = self.connecting.take() {
            task.abort();
        }
        // Work from the abandoned attempt is thrown away.
        self.attempt += 1;
        view.phase = RemotePhase::NeedsPassword;
        view.error = None;
    }

    fn remote_pointer(&mut self, pointer: RemotePointer) {
        let Some(session) = self.remote.as_mut() else {
            return;
        };
        let Some(viewer) = session.viewer.clone() else {
            return;
        };
        match pointer {
            RemotePointer::Tap { x, y } => {
                for event in click(clamp01(x), clamp01(y), MouseButton::Left) {
                    viewer.send_input(event);
                }
            }
            RemotePointer::RightTap { x, y } => {
                for event in click(clamp01(x), clamp01(y), MouseButton::Right) {
                    viewer.send_input(event);
                }
            }
            RemotePointer::DragStart { x, y } => {
                let (x, y) = (clamp01(x), clamp01(y));
                viewer.send_input(InputEvent::Move { x, y });
                viewer.send_input(InputEvent::Down {
                    x,
                    y,
                    button: MouseButton::Left,
                });
            }
            RemotePointer::DragMove { x, y } => viewer.move_to(clamp01(x), clamp01(y)),
            RemotePointer::DragEnd { x, y } => viewer.send_input(InputEvent::Up {
                x: clamp01(x),
                y: clamp01(y),
                button: MouseButton::Left,
            }),
            RemotePointer::Scroll { x, y, dx, dy } => {
                let wheel_x = notches(&mut session.scroll_x, dx);
                let wheel_y = notches(&mut session.scroll_y, dy);
                if wheel_x != 0.0 || wheel_y != 0.0 {
                    viewer.send_input(InputEvent::Wheel {
                        x: clamp01(x),
                        y: clamp01(y),
                        dx: wheel_x,
                        dy: wheel_y,
                    });
                }
            }
        }
    }

    fn remote_text(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        let text: String = text.chars().take(MAX_TYPED_CHARS).collect();
        if let Some(viewer) = self.remote.as_ref().and_then(|s| s.viewer.clone()) {
            viewer.send_input(InputEvent::Text { text });
        }
    }

    fn remote_key(&mut self, key: RemoteKey) {
        if let Some(viewer) = self.remote.as_ref().and_then(|s| s.viewer.clone()) {
            for event in key_events(key) {
                viewer.send_input(event);
            }
        }
    }

    fn remote_send_clipboard(&mut self, text: String) {
        let Some(viewer) = self.remote.as_ref().and_then(|s| s.viewer.clone()) else {
            return;
        };
        let Some(view) = self.view.remote.as_mut() else {
            return;
        };
        if text.is_empty() {
            view.note = Some("Your clipboard is empty.".to_owned());
        } else if text.len() > MAX_CLIPBOARD_BYTES {
            view.note = Some("That's too much text to send.".to_owned());
        } else {
            viewer.send_clipboard(text);
            view.note = Some("Sent to the computer's clipboard.".to_owned());
        }
    }
}

#[uniffi::export]
impl Engine {
    pub fn remote_open(&self, system_id: i64, sink: Arc<dyn RemoteFrameSink>) {
        self.run(move |runner| runner.remote_open(system_id, sink));
    }

    /// Closes the viewer. Native code releases what it drew into when `on_stopped` arrives.
    pub fn remote_close(&self) {
        self.run(Runner::remote_close);
    }

    pub fn remote_submit_password(&self, password: String) {
        self.run(move |runner| runner.remote_submit_password(password));
    }

    pub fn remote_use_password(&self) {
        self.run(Runner::remote_use_password);
    }

    pub fn remote_pointer(&self, pointer: RemotePointer) {
        self.run(move |runner| runner.remote_pointer(pointer));
    }

    pub fn remote_text(&self, text: String) {
        self.run(move |runner| runner.remote_text(text));
    }

    pub fn remote_key(&self, key: RemoteKey) {
        self.run(move |runner| runner.remote_key(key));
    }

    pub fn remote_send_clipboard(&self, text: String) {
        self.run(move |runner| runner.remote_send_clipboard(text));
    }

    /// The text from the computer's clipboard has been dealt with.
    pub fn remote_clipboard_taken(&self) {
        self.run(|runner| {
            if let Some(view) = runner.view.remote.as_mut() {
                view.clipboard = None;
            }
        });
    }

    pub fn remote_dismiss_note(&self) {
        self.run(|runner| {
            if let Some(view) = runner.view.remote.as_mut() {
                view.note = None;
            }
        });
    }
}
