//! The app's one state machine. Commands come in from the screens, the hub and running work, and
//! a new view goes out whenever anything a screen shows has changed.

use crate::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use crate::secure::{SecurePins, SecureStore, device_id, identity_key, identity_seed};
use crate::view::{
    AppView, AuthState, ConnectionPhase, ConnectionView, ProjectView, SystemView, ViewListener,
};
use async_trait::async_trait;
use runova_api::auth::{
    AuthError, DeviceInfo, Session, SignInRequest, begin_sign_in, read_callback,
};
use runova_crypto::handshake::os_random;
use runova_session::connect::{ConnectTarget, ManageSession, Phase, Transports, connect_to};
use runova_session::hub::{HubEvent, HubPort};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};

const SIGN_IN_FAILED: &str = "Couldn't sign in. Try again.";
const HUB_EVENT_QUEUE: usize = 256;

#[async_trait]
pub trait HubConnector: Send + Sync {
    async fn connect(
        &self,
        token: String,
    ) -> Result<(Arc<dyn HubPort>, mpsc::Receiver<HubEvent>), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AppLifecycle {
    /// The app left the screen. The link is let go after the grace, and push takes over.
    Backgrounded {
        grace_ms: u64,
    },
    Foregrounded,
}

pub struct Dependencies {
    pub site: String,
    pub platform: String,
    pub app_version: String,
    pub secure: Arc<dyn SecureStore>,
    pub listener: Arc<dyn ViewListener>,
    pub session: Arc<Session>,
    pub backend: Arc<dyn Backend>,
    pub hub: Arc<dyn HubConnector>,
    pub transports: Arc<dyn Transports>,
}

enum Command {
    FinishSignIn { url: String, pending: SignInRequest },
    Refresh,
    Connect(i64),
    Disconnect,
    Lifecycle(AppLifecycle),
    SignOut,
}

enum Done {
    Boot(Result<Booted, BootError>),
    Systems(Result<Vec<SystemEntry>, BackendError>),
    Phase {
        attempt: u64,
        phase: Phase,
    },
    Connect {
        attempt: u64,
        result: Result<Box<ManageSession>, String>,
    },
    Projects {
        attempt: u64,
        result: Result<Vec<ProjectView>, String>,
    },
    LinkClosed {
        attempt: u64,
    },
}

struct Booted {
    hub: Arc<dyn HubPort>,
    events: mpsc::Receiver<HubEvent>,
    device_id: i64,
    systems: Vec<SystemEntry>,
}

enum BootError {
    SignedOut,
    Failed(String),
}

/// Native code's handle on the running engine.
#[derive(Clone)]
pub struct Engine {
    commands: mpsc::UnboundedSender<Command>,
    pending: Arc<Mutex<Option<SignInRequest>>>,
    site: String,
    platform: String,
    app_version: String,
    secure: Arc<dyn SecureStore>,
}

impl Engine {
    /// Must be called inside the Tokio runtime that will run it.
    pub fn start(deps: Dependencies) -> Self {
        let (commands, queue) = mpsc::unbounded_channel();
        let engine = Self {
            commands,
            pending: Arc::new(Mutex::new(None)),
            site: deps.site.clone(),
            platform: deps.platform.clone(),
            app_version: deps.app_version.clone(),
            secure: deps.secure.clone(),
        };
        tokio::spawn(Runner::new(deps).run(queue));
        engine
    }

    /// The link to open in the system browser.
    pub fn begin_sign_in(&self, device_name: String) -> SignInRequest {
        let info = DeviceInfo {
            device_id: device_id(self.secure.as_ref()),
            name: device_name,
            platform: self.platform.clone(),
            app_version: self.app_version.clone(),
        };
        let request = begin_sign_in(&self.site, &info, &mut os_random);
        let copy = SignInRequest {
            url: request.url.clone(),
            verifier: request.verifier.clone(),
            state: request.state.clone(),
        };
        *self.pending.lock().expect("sign-in state") = Some(request);
        copy
    }

    pub fn finish_sign_in(&self, url: String) {
        let pending = self.pending.lock().expect("sign-in state").take();
        if let Some(pending) = pending {
            let _ = self.commands.send(Command::FinishSignIn { url, pending });
        }
    }

    pub fn refresh(&self) {
        let _ = self.commands.send(Command::Refresh);
    }

    pub fn connect(&self, system_id: i64) {
        let _ = self.commands.send(Command::Connect(system_id));
    }

    pub fn disconnect(&self) {
        let _ = self.commands.send(Command::Disconnect);
    }

    pub fn lifecycle(&self, change: AppLifecycle) {
        let _ = self.commands.send(Command::Lifecycle(change));
    }

    pub fn sign_out(&self) {
        let _ = self.commands.send(Command::SignOut);
    }
}

struct Runner {
    deps: Dependencies,
    done_tx: mpsc::UnboundedSender<Done>,
    done_rx: Option<mpsc::UnboundedReceiver<Done>>,
    view: AppView,
    published: Option<AppView>,
    hub: Option<Arc<dyn HubPort>>,
    hub_events: Option<mpsc::Receiver<HubEvent>>,
    device_id: Option<i64>,
    systems: Vec<SystemEntry>,
    attempt: u64,
    connecting: Option<(mpsc::Sender<HubEvent>, JoinHandle<()>)>,
    session: Option<ManageSession>,
    /// The computer to return to when the app comes back.
    return_to: Option<i64>,
    let_go_at: Option<Instant>,
}

fn view_of(entry: &SystemEntry) -> SystemView {
    SystemView {
        id: entry.id,
        remote_id: entry.remote_id.clone(),
        name: entry.name.clone(),
        platform: entry.platform.clone(),
        online: entry.online,
        own: entry.own,
        can_manage: entry.own && entry.kind == "app",
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDto {
    id: String,
    name: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    has_repository: bool,
    icon_bg_color: Option<String>,
    icon_color: Option<String>,
}

impl Runner {
    fn new(deps: Dependencies) -> Self {
        let (done_tx, done_rx) = mpsc::unbounded_channel();
        Self {
            deps,
            done_tx,
            done_rx: Some(done_rx),
            view: AppView::starting(),
            published: None,
            hub: None,
            hub_events: None,
            device_id: None,
            systems: Vec::new(),
            attempt: 0,
            connecting: None,
            session: None,
            return_to: None,
            let_go_at: None,
        }
    }

    fn publish(&mut self) {
        if self.published.as_ref() != Some(&self.view) {
            self.published = Some(self.view.clone());
            self.deps.listener.on_view(self.view.clone());
        }
    }

    fn set_systems(&mut self, systems: Vec<SystemEntry>) {
        self.view.systems = systems.iter().map(view_of).collect();
        self.systems = systems;
        self.view.systems_loading = false;
    }

    /// Connects the hub, makes sure the phone is registered, and lists the computers.
    fn boot(&mut self) {
        self.view.systems_loading = true;
        let done = self.done_tx.clone();
        let session = self.deps.session.clone();
        let connector = self.deps.hub.clone();
        let backend = self.deps.backend.clone();
        let secure = self.deps.secure.clone();
        let platform = self.deps.platform.clone();
        tokio::spawn(async move {
            let _ = done.send(Done::Boot(
                run_boot(session, connector, backend, secure, platform).await,
            ));
        });
    }

    fn refresh(&mut self) {
        self.view.systems_loading = true;
        let done = self.done_tx.clone();
        let backend = self.deps.backend.clone();
        tokio::spawn(async move {
            let _ = done.send(Done::Systems(backend.systems().await));
        });
    }

    fn end_connection(&mut self) {
        self.attempt += 1;
        if let Some((_, task)) = self.connecting.take() {
            task.abort();
        }
        if let Some(session) = self.session.take() {
            let client = session.client.clone();
            tokio::spawn(async move { client.close().await });
        }
        self.view.connection = None;
        self.view.projects.clear();
        self.view.projects_loading = false;
    }

    fn let_go_of_hub(&mut self) {
        self.hub = None;
        self.hub_events = None;
        self.view.hub_connected = false;
    }

    fn signed_out(&mut self) {
        self.end_connection();
        self.let_go_of_hub();
        self.device_id = None;
        self.return_to = None;
        self.systems.clear();
        self.view.systems.clear();
        self.view.systems_loading = false;
        self.view.auth = AuthState::SignedOut;
    }

    fn connect(&mut self, system_id: i64) {
        self.end_connection();
        let Some(entry) = self.systems.iter().find(|s| s.id == system_id).cloned() else {
            return;
        };
        let mut view = ConnectionView {
            system_id,
            system_name: entry.name.clone(),
            phase: ConnectionPhase::Requesting,
            safety_code: None,
            direct: None,
            error: None,
        };
        let (Some(hub), Some(device_id)) = (self.hub.clone(), self.device_id) else {
            view.phase = ConnectionPhase::Failed;
            view.error = Some("Not connected to Runova yet. Try again in a moment.".to_owned());
            self.view.connection = Some(view);
            return;
        };
        self.view.connection = Some(view);
        self.return_to = Some(system_id);
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
                let _ = phases.send(Done::Phase { attempt, phase });
            };
            let result = connect_to(
                target,
                hub.as_ref(),
                transports.as_ref() as &dyn Transports,
                &pins,
                &mut queue,
                &on_phase,
            )
            .await;
            let _ = done.send(Done::Connect {
                attempt,
                result: result.map(Box::new).map_err(|e| e.to_string()),
            });
        });
        self.connecting = Some((events, task));
    }

    fn on_phase(&mut self, phase: Phase) {
        let Some(view) = self.view.connection.as_mut() else {
            return;
        };
        view.phase = match phase {
            Phase::Requesting => ConnectionPhase::Requesting,
            Phase::WaitingForApproval => ConnectionPhase::WaitingForApproval,
            Phase::Connecting => ConnectionPhase::Connecting,
            Phase::Securing => ConnectionPhase::Securing,
            Phase::Connected {
                safety_code,
                direct,
            } => {
                view.safety_code = Some(safety_code);
                view.direct = Some(direct);
                ConnectionPhase::Connected
            }
        };
    }

    fn on_connected(&mut self, session: ManageSession) {
        let attempt = self.attempt;
        let client = session.client.clone();
        self.session = Some(session);
        self.view.projects_loading = true;

        let done = self.done_tx.clone();
        let projects = client.clone();
        tokio::spawn(async move {
            let result = match projects.call("projects.list", None).await {
                Ok(value) => serde_json::from_value::<Vec<ProjectDto>>(value)
                    .map(|items| {
                        items
                            .into_iter()
                            .filter(|p| !p.archived)
                            .map(|p| ProjectView {
                                id: p.id,
                                name: p.name,
                                tags: p.tags,
                                pinned: p.pinned,
                                has_repository: p.has_repository,
                                icon_bg_color: p.icon_bg_color,
                                icon_color: p.icon_color,
                            })
                            .collect()
                    })
                    .map_err(|_| "This computer sent an unreadable project list.".to_owned()),
                Err(error) => Err(error.to_string()),
            };
            let _ = done.send(Done::Projects { attempt, result });
        });

        let closed = self.done_tx.clone();
        tokio::spawn(async move {
            client.closed().await;
            let _ = closed.send(Done::LinkClosed { attempt });
        });
    }

    fn fail_connection(&mut self, message: String) {
        if let Some(view) = self.view.connection.as_mut() {
            view.phase = ConnectionPhase::Failed;
            view.error = Some(message);
        }
        self.session = None;
        self.view.projects_loading = false;
    }

    fn on_done(&mut self, done: Done) {
        match done {
            Done::Boot(Ok(booted)) => {
                self.hub = Some(booted.hub);
                self.hub_events = Some(booted.events);
                self.device_id = Some(booted.device_id);
                self.view.hub_connected = true;
                self.set_systems(booted.systems);
                if self.view.connection.is_none()
                    && let Some(system) = self.return_to
                {
                    self.connect(system);
                }
            }
            Done::Boot(Err(BootError::SignedOut)) => self.signed_out(),
            Done::Boot(Err(BootError::Failed(message))) => {
                self.view.systems_loading = false;
                self.view.error = Some(message);
            }
            Done::Systems(Ok(systems)) => self.set_systems(systems),
            Done::Systems(Err(BackendError::SignedOut)) => self.signed_out(),
            Done::Systems(Err(BackendError::Failed(message))) => {
                self.view.systems_loading = false;
                self.view.error = Some(message);
            }
            Done::Phase { attempt, phase } if attempt == self.attempt => self.on_phase(phase),
            Done::Connect { attempt, result } if attempt == self.attempt => {
                self.connecting = None;
                match result {
                    Ok(session) => self.on_connected(*session),
                    Err(message) => self.fail_connection(message),
                }
            }
            Done::Projects { attempt, result } if attempt == self.attempt => {
                self.view.projects_loading = false;
                match result {
                    Ok(projects) => self.view.projects = projects,
                    Err(message) => self.view.error = Some(message),
                }
            }
            Done::LinkClosed { attempt } if attempt == self.attempt => {
                self.fail_connection("The connection to this computer ended.".to_owned());
            }
            _ => {}
        }
    }

    fn on_hub_event(&mut self, event: Option<HubEvent>) {
        let Some(event) = event else {
            self.let_go_of_hub();
            return;
        };
        if let HubEvent::Presence { device_id, online } = event {
            if let Some(entry) = self.systems.iter_mut().find(|s| s.id == device_id) {
                entry.online = online;
            }
            let systems = std::mem::take(&mut self.systems);
            self.set_systems(systems);
            return;
        }
        if let Some((events, _)) = &self.connecting {
            // A full queue means the connect task has stopped reading, so nothing is lost.
            let _ = events.try_send(event);
        }
    }

    async fn on_command(&mut self, command: Command) {
        match command {
            Command::FinishSignIn { url, pending } => {
                self.view.error = None;
                match read_callback(&url, &pending.state) {
                    Ok(code) => {
                        match self
                            .deps
                            .session
                            .complete_sign_in(&code, &pending.verifier)
                            .await
                        {
                            Ok(()) => {
                                self.view.auth = AuthState::SignedIn;
                                self.boot();
                            }
                            Err(AuthError::Network(_)) | Err(_) => {
                                self.view.error = Some(SIGN_IN_FAILED.to_owned());
                            }
                        }
                    }
                    Err(AuthError::Declined) => {
                        self.view.error = Some("Sign-in was cancelled.".to_owned());
                    }
                    Err(_) => self.view.error = Some(SIGN_IN_FAILED.to_owned()),
                }
            }
            Command::Refresh => self.refresh(),
            Command::Connect(system) => self.connect(system),
            Command::Disconnect => {
                self.return_to = None;
                self.end_connection();
            }
            Command::Lifecycle(AppLifecycle::Backgrounded { grace_ms }) => {
                self.let_go_at = Some(Instant::now() + Duration::from_millis(grace_ms));
            }
            Command::Lifecycle(AppLifecycle::Foregrounded) => {
                self.let_go_at = None;
                if self.view.auth == AuthState::SignedIn && self.hub.is_none() {
                    self.boot();
                }
            }
            Command::SignOut => {
                self.deps.session.sign_out().await;
                self.signed_out();
            }
        }
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        let mut done = self.done_rx.take().expect("runs once");
        if self.deps.session.is_signed_in().await {
            self.view.auth = AuthState::SignedIn;
            self.boot();
        } else {
            self.view.auth = AuthState::SignedOut;
        }
        self.publish();

        loop {
            let let_go_at = self.let_go_at;
            tokio::select! {
                command = commands.recv() => match command {
                    Some(command) => self.on_command(command).await,
                    None => break,
                },
                Some(finished) = done.recv() => self.on_done(finished),
                event = next_event(&mut self.hub_events) => self.on_hub_event(event),
                () = wait_until(let_go_at) => {
                    self.let_go_at = None;
                    self.end_connection();
                    self.let_go_of_hub();
                }
            }
            self.publish();
        }
    }
}

async fn next_event(events: &mut Option<mpsc::Receiver<HubEvent>>) -> Option<HubEvent> {
    match events {
        Some(queue) => queue.recv().await,
        None => std::future::pending().await,
    }
}

async fn wait_until(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn run_boot(
    session: Arc<Session>,
    connector: Arc<dyn HubConnector>,
    backend: Arc<dyn Backend>,
    secure: Arc<dyn SecureStore>,
    platform: String,
) -> Result<Booted, BootError> {
    let from_backend = |error| match error {
        BackendError::SignedOut => BootError::SignedOut,
        BackendError::Failed(message) => BootError::Failed(message),
    };
    let token = session.access_token().await.map_err(|error| match error {
        AuthError::SignedOut => BootError::SignedOut,
        other => BootError::Failed(other.to_string()),
    })?;
    let (hub, events) = connector.connect(token).await.map_err(BootError::Failed)?;
    let seed = identity_seed(secure.as_ref());
    let device_id = backend
        .register_phone(PhoneRegistration {
            device_id: device_id(secure.as_ref()),
            name: "Runova app".to_owned(),
            platform,
            identity_key: identity_key(seed),
        })
        .await
        .map_err(from_backend)?;
    let systems = backend.systems().await.map_err(from_backend)?;
    Ok(Booted {
        hub,
        events,
        device_id,
        systems,
    })
}
