//! The app's one state machine. Commands come in from the screens, the hub and running work, and
//! a new view goes out whenever anything a screen shows has changed.

use crate::account::PendingStepUp;
use crate::backend::{Backend, BackendError, PhoneRegistration, SystemEntry};
use crate::notifications::{FeedConnector, FeedEvent};
use crate::remote::RemoteSession;
use crate::secure::{
    SecurePins, SecureStore, device_id, identity_key, identity_seed, phone_fingerprint,
};
use crate::studio::SharedThumbnails;
use crate::terminals::OpenTerminal;
use crate::vault::PendingReveal;
use crate::view::{
    AppView, AuthState, ConfirmView, ConnectionPhase, ConnectionView, DeployScreen, GitScreen,
    MonitoringScreen, PipelinesScreen, ProjectView, Section, StatusScreen, SystemView,
    ViewListener,
};
use async_trait::async_trait;
use runova_api::auth::{
    AuthError, DeviceInfo, Session, SignInRequest, begin_sign_in, read_callback,
};
use runova_crypto::handshake::os_random;
use runova_rpc::{ManageClient, RpcError};
use runova_session::connect::{ConnectTarget, ManageSession, Phase, Transports, connect_to};
use runova_session::hub::{HubEvent, HubPort};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until};
use zeroize::Zeroize;

const SIGN_IN_FAILED: &str = "Couldn't sign in. Try again.";
const HUB_EVENT_QUEUE: usize = 256;
const UNREADABLE: &str = "This computer sent something this version of the app can't read.";

/// A change to what the screens show, made by finished work.
pub(crate) type Apply = Box<dyn FnOnce(&mut AppView) + Send>;
pub(crate) type Task = Box<dyn FnOnce(&mut Runner) + Send>;

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
    pub feed: Arc<dyn FeedConnector>,
    /// How often a screen on show refreshes itself.
    pub refresh_every: Duration,
}

enum Command {
    FinishSignIn { url: String, pending: SignInRequest },
    Refresh,
    Connect(i64),
    Disconnect,
    Lifecycle(AppLifecycle),
    SignOut,
    Run(Task),
}

pub(crate) enum Done {
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
    Apply {
        attempt: u64,
        apply: Apply,
    },
    Tick {
        attempt: u64,
    },
    Run {
        attempt: u64,
        task: Task,
    },
}

pub(crate) struct Booted {
    hub: Arc<dyn HubPort>,
    events: mpsc::Receiver<HubEvent>,
    feed: Option<mpsc::Receiver<FeedEvent>>,
    device_id: i64,
    systems: Vec<SystemEntry>,
}

pub(crate) enum BootError {
    SignedOut,
    Failed(String),
}

/// Native code's handle on the running engine.
#[derive(Clone, uniffi::Object)]
pub struct Engine {
    commands: mpsc::UnboundedSender<Command>,
    pending: Arc<Mutex<Option<SignInRequest>>>,
    site: String,
    platform: String,
    app_version: String,
    secure: Arc<dyn SecureStore>,
    pub(crate) thumbnails: SharedThumbnails,
}

impl Engine {
    /// Must be called inside the Tokio runtime that will run it.
    pub fn start(deps: Dependencies) -> Self {
        let (commands, queue) = mpsc::unbounded_channel();
        let thumbnails = SharedThumbnails::default();
        let engine = Self {
            commands,
            thumbnails: thumbnails.clone(),
            pending: Arc::new(Mutex::new(None)),
            site: deps.site.clone(),
            platform: deps.platform.clone(),
            app_version: deps.app_version.clone(),
            secure: deps.secure.clone(),
        };
        tokio::spawn(Runner::new(deps, thumbnails).run(queue));
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

    pub(crate) fn run(&self, task: impl FnOnce(&mut Runner) + Send + 'static) {
        let _ = self.commands.send(Command::Run(Box::new(task)));
    }

    /// `None` when no screen that refreshes itself is on show.
    pub fn open_section(&self, section: Option<Section>) {
        self.run(move |runner| runner.open_section(section));
    }

    pub fn select_project(&self, project_id: Option<String>) {
        self.run(move |runner| runner.select_project(project_id));
    }

    pub fn load_terminals(&self) {
        self.run(Runner::load_terminals);
    }

    pub fn open_terminal(&self, session_id: String) {
        self.run(move |runner| runner.open_terminal(session_id));
    }

    pub fn close_terminal(&self) {
        self.run(Runner::close_terminal);
    }

    pub fn terminal_input(&self, data: String) {
        self.run(move |runner| runner.terminal_input(data));
    }

    /// Positive goes back in time.
    pub fn terminal_scroll(&self, lines: i32) {
        self.run(move |runner| runner.terminal_scroll(lines));
    }

    pub fn load_terminal_processes(&self, session_id: String) {
        self.run(move |runner| runner.load_terminal_processes(session_id));
    }
}

#[uniffi::export]
impl Engine {
    /// Yes to the question on screen.
    pub fn confirm(&self) {
        self.run(|runner| runner.answer(true));
    }

    pub fn dismiss_confirm(&self) {
        self.run(|runner| runner.answer(false));
    }

    pub fn dismiss_notice(&self) {
        self.run(|runner| runner.view.notice = None);
    }

    /// The welcome pages are done with, for good on this install.
    pub fn intro_done(&self) {
        self.run(|runner| {
            runner
                .deps
                .secure
                .set(INTRO_SEEN.to_owned(), "1".to_owned());
            runner.view.show_intro = false;
        });
    }
}

const INTRO_SEEN: &str = "intro-seen";

pub(crate) struct Runner {
    /// The language of the open video, which picks its voices.
    pub(crate) studio_language: String,
    /// Stops the download under way.
    pub(crate) download_stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// The AI run the phone is waiting on, so it can be stopped.
    pub(crate) ai_request: Option<String>,
    pub(crate) deps: Dependencies,
    pub(crate) thumbnails: SharedThumbnails,
    pub(crate) done_tx: mpsc::UnboundedSender<Done>,
    done_rx: Option<mpsc::UnboundedReceiver<Done>>,
    pub(crate) view: AppView,
    pub(crate) published: Option<AppView>,
    pub(crate) hub: Option<Arc<dyn HubPort>>,
    hub_events: Option<mpsc::Receiver<HubEvent>>,
    pub(crate) device_id: Option<i64>,
    pub(crate) systems: Vec<SystemEntry>,
    pub(crate) attempt: u64,
    pub(crate) connecting: Option<(mpsc::Sender<HubEvent>, JoinHandle<()>)>,
    pub(crate) session: Option<ManageSession>,
    /// The computer to return to when the app comes back.
    pub(crate) return_to: Option<i64>,
    pub(crate) remote: Option<RemoteSession>,
    let_go_at: Option<Instant>,
    pub(crate) open_terminal: Option<OpenTerminal>,
    pub(crate) section: Option<Section>,
    ticker: Option<JoinHandle<()>>,
    pending_confirm: Option<Task>,
    pub(crate) ticks: u32,
    pub(crate) pending_reveal: Option<PendingReveal>,
    pub(crate) biometric_serial: u64,
    pub(crate) vault_listing: bool,
    pub(crate) pending_step_up: Option<PendingStepUp>,
    pub(crate) feed_events: Option<mpsc::Receiver<FeedEvent>>,
    pub(crate) push_token: Option<String>,
    pub(crate) seal_key: Option<Arc<runova_crypto::sealed::SealKey>>,
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
struct OpResult {
    ok: bool,
    #[serde(default)]
    message: String,
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
    fn new(deps: Dependencies, thumbnails: SharedThumbnails) -> Self {
        let (done_tx, done_rx) = mpsc::unbounded_channel();
        Self {
            studio_language: String::new(),
            download_stop: None,
            ai_request: None,
            deps,
            thumbnails,
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
            remote: None,
            let_go_at: None,
            open_terminal: None,
            section: None,
            ticker: None,
            pending_confirm: None,
            ticks: 0,
            pending_reveal: None,
            biometric_serial: 0,
            vault_listing: false,
            pending_step_up: None,
            feed_events: None,
            push_token: None,
            seal_key: None,
        }
    }

    pub(crate) fn platform_name(&self) -> String {
        self.deps.platform.clone()
    }

    pub(crate) fn refresh_cloud_if_on_show(&mut self) {
        if self.section == Some(Section::Monitoring) {
            self.reload_cloud();
        }
    }

    pub(crate) fn leave_computer(&mut self) {
        self.return_to = None;
        self.end_connection();
    }

    /// Removes everything that identifies this phone, so the next person starts clean.
    pub(crate) async fn clear_identity(&mut self) {
        self.deps.session.sign_out().await;
        for key in ["identity-seed", "device-id"] {
            self.deps.secure.remove(key.to_owned());
        }
    }

    /// Puts the question on screen and runs `task` only if the answer is yes.
    pub(crate) fn ask(
        &mut self,
        confirm: ConfirmView,
        task: impl FnOnce(&mut Runner) + Send + 'static,
    ) {
        self.view.confirm = Some(confirm);
        self.pending_confirm = Some(Box::new(task));
    }

    fn answer(&mut self, yes: bool) {
        self.view.confirm = None;
        if let Some(task) = self.pending_confirm.take()
            && yes
        {
            task(self);
        }
    }

    /// Does something on the computer that answers with `{ok, message}`, then runs `after`.
    pub(crate) fn op(
        &mut self,
        method: &'static str,
        params: Option<Value>,
        after: fn(&mut Runner),
    ) {
        let Some(client) = self.client() else {
            return;
        };
        self.view.busy = true;
        self.view.error = None;
        self.view.notice = None;
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call(method, params).await;
            let task: Task = Box::new(move |runner| {
                runner.view.busy = false;
                match outcome.map(serde_json::from_value::<OpResult>) {
                    Ok(Ok(OpResult { ok: true, message })) => {
                        runner.view.notice = first_line(&message);
                    }
                    Ok(Ok(OpResult { message, .. })) => runner.view.error = Some(message),
                    Ok(Err(_)) => runner.view.error = Some(UNREADABLE.to_owned()),
                    Err(RpcError::Closed) => {}
                    Err(error) => runner.view.error = Some(error.to_string()),
                }
                after(runner);
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    fn open_section(&mut self, section: Option<Section>) {
        self.view.error = None;
        self.view.notice = None;
        let on_vault = section == Some(Section::Vault);
        if !on_vault {
            self.forget_secret();
        }
        self.view.vault.on_show = on_vault;
        self.section = section;
        self.start_ticking();
    }

    fn start_ticking(&mut self) {
        if let Some(ticker) = self.ticker.take() {
            ticker.abort();
        }
        // Cloud monitors come from Runova itself, so they need no computer.
        let needs_computer = !matches!(
            self.section,
            Some(Section::Monitoring) | Some(Section::Account) | Some(Section::Notifications)
        );
        if self.section.is_none() || (needs_computer && self.session.is_none()) {
            return;
        }
        self.ticks = 0;
        self.refresh_section();
        let attempt = self.attempt;
        let every = self.deps.refresh_every;
        let done = self.done_tx.clone();
        self.ticker = Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                if done.send(Done::Tick { attempt }).is_err() {
                    break;
                }
            }
        }));
    }

    pub(crate) fn refresh_section(&mut self) {
        match self.section {
            Some(Section::Clis) => self.load_terminals(),
            Some(Section::Git) => {
                self.load_git();
                self.refresh_version_run();
            }
            Some(Section::Status) => self.refresh_status(),
            Some(Section::Vault) => self.refresh_vault(),
            Some(Section::Deploy) => self.refresh_deploy(),
            Some(Section::Monitoring) => self.refresh_monitoring(),
            Some(Section::Pipelines) => self.refresh_pipelines(),
            Some(Section::Account) => self.refresh_account(),
            Some(Section::Notifications) => self.refresh_notifications(),
            Some(Section::Studio) => self.refresh_studio(),
            Some(Section::Prompts) => self.refresh_prompts(),
            None => {}
        }
    }

    pub(crate) fn client(&self) -> Option<ManageClient> {
        self.session.as_ref().map(|s| s.client.clone())
    }

    /// Calls a method on the connected computer. Work from a connection that has since ended is
    /// thrown away, and a refusal is shown to the user in the computer's own words.
    pub(crate) fn call<T, Ok, Failed>(
        &mut self,
        method: &'static str,
        params: Option<Value>,
        ok: Ok,
        failed: Failed,
    ) where
        T: DeserializeOwned + Send + 'static,
        Ok: FnOnce(&mut AppView, T) + Send + 'static,
        Failed: FnOnce(&mut AppView) + Send + 'static,
    {
        let Some(client) = self.client() else {
            failed(&mut self.view);
            return;
        };
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        tokio::spawn(async move {
            let outcome = client.call(method, params).await;
            let apply: Apply = Box::new(move |view| {
                let parsed = outcome.map(|value| serde_json::from_value::<T>(value));
                match parsed {
                    Ok(Ok(value)) => ok(view, value),
                    Ok(Err(_)) => {
                        failed(view);
                        view.error = Some(UNREADABLE.to_owned());
                    }
                    // The link's end has its own message, on the connection.
                    Err(RpcError::Closed) => failed(view),
                    Err(error) => {
                        failed(view);
                        view.error = Some(error.to_string());
                    }
                }
            });
            let _ = done.send(Done::Apply { attempt, apply });
        });
    }

    fn clear_device(&mut self) {
        if let Some(ticker) = self.ticker.take() {
            ticker.abort();
        }
        self.open_terminal = None;
        self.view.selected_project = None;
        self.view.git = GitScreen::default();
        self.view.git_tools = Default::default();
        self.view.studio = Default::default();
        self.view.auto_fix.clear();
        self.view.prompts = Default::default();
        self.view.studio_tools = Default::default();
        self.view.git_more = Default::default();
        self.view.status = StatusScreen::default();
        self.clear_vault();
        self.view.deploy = DeployScreen::default();
        self.view.pipelines = PipelinesScreen::default();
        self.view.monitoring.local.clear();
        self.view.errors = Default::default();
        self.view.confirm = None;
        self.pending_confirm = None;
        self.view.busy = false;
        self.view.notice = None;
        self.view.projects.clear();
        self.view.projects_loading = false;
        self.view.terminals.clear();
        self.view.terminals_loading = false;
        self.view.terminal = None;
        self.view.terminal_processes.clear();
    }

    fn publish(&mut self) {
        if self.published.as_ref() != Some(&self.view) {
            if let Some(mut old) = self.published.take().and_then(|view| view.vault.revealed) {
                old.value.zeroize();
            }
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
        let feed = self.deps.feed.clone();
        tokio::spawn(async move {
            let _ = done.send(Done::Boot(
                run_boot(session, connector, feed, backend, secure, platform).await,
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

    pub(crate) fn end_connection(&mut self) {
        self.attempt += 1;
        if let Some((_, task)) = self.connecting.take() {
            task.abort();
        }
        if let Some(session) = self.session.take() {
            let client = session.client.clone();
            tokio::spawn(async move { client.close().await });
        }
        self.stop_remote();
        self.view.connection = None;
        self.clear_device();
    }

    fn let_go_of_hub(&mut self) {
        self.feed_events = None;
        self.hub = None;
        self.hub_events = None;
        self.view.hub_connected = false;
    }

    pub(crate) fn on_signed_out(&mut self) {
        self.signed_out();
    }

    pub(crate) fn deps_backend(&self) -> Arc<dyn Backend> {
        self.deps.backend.clone()
    }

    /// Reads from the website, for screens that do not go through a computer.
    pub(crate) fn rest<T, Ok, Failed>(&mut self, path: impl Into<String>, ok: Ok, failed: Failed)
    where
        T: DeserializeOwned + Send + 'static,
        Ok: FnOnce(&mut AppView, T) + Send + 'static,
        Failed: FnOnce(&mut AppView) + Send + 'static,
    {
        let backend = self.deps.backend.clone();
        let attempt = self.attempt;
        let done = self.done_tx.clone();
        let path = path.into();
        tokio::spawn(async move {
            let outcome = backend.get_json(&path).await;
            let task: Task = Box::new(move |runner| match outcome {
                Ok(value) => match serde_json::from_value::<T>(value) {
                    Ok(value) => ok(&mut runner.view, value),
                    Err(_) => {
                        failed(&mut runner.view);
                        runner.view.error = Some(UNREADABLE.to_owned());
                    }
                },
                Err(BackendError::SignedOut) => runner.signed_out(),
                Err(BackendError::Failed(message)) => {
                    failed(&mut runner.view);
                    runner.view.error = Some(message);
                }
            });
            let _ = done.send(Done::Run { attempt, task });
        });
    }

    fn signed_out(&mut self) {
        self.view.monitoring = MonitoringScreen::default();
        self.view.account = Default::default();
        self.view.notifications = Default::default();
        self.view.encryption = None;
        self.pending_step_up = None;
        self.end_connection();
        self.let_go_of_hub();
        self.device_id = None;
        self.return_to = None;
        self.systems.clear();
        self.view.systems.clear();
        self.view.systems_loading = false;
        self.view.auth = AuthState::SignedOut;
    }

    pub(crate) fn connect(&mut self, system_id: i64) {
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
        self.view.phone_fingerprint =
            Some(phone_fingerprint(identity_seed(self.deps.secure.as_ref())));
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
        self.start_ticking();
        self.share_seal_key();

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
        self.clear_device();
    }

    fn on_done(&mut self, done: Done) {
        match done {
            Done::Boot(Ok(booted)) => {
                self.hub = Some(booted.hub);
                self.hub_events = Some(booted.events);
                self.feed_events = booted.feed;
                self.send_push_token();
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
            Done::Apply { attempt, apply } if attempt == self.attempt => apply(&mut self.view),
            Done::Tick { attempt } if attempt == self.attempt => self.refresh_section(),
            Done::Run { attempt, task } if attempt == self.attempt => task(self),
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
                self.forget_secret();
                self.view.vault.in_background = true;
                self.let_go_at = Some(Instant::now() + Duration::from_millis(grace_ms));
            }
            Command::Lifecycle(AppLifecycle::Foregrounded) => {
                self.view.vault.in_background = false;
                self.let_go_at = None;
                if self.view.auth == AuthState::SignedIn && self.hub.is_none() {
                    self.boot();
                }
            }
            Command::SignOut => {
                self.sign_out_fully().await;
                self.signed_out();
            }
            Command::Run(task) => task(self),
        }
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        let mut done = self.done_rx.take().expect("runs once");
        self.view.show_intro = self.deps.secure.get(INTRO_SEEN.to_owned()).is_none();
        self.view.app_version = self.deps.app_version.clone();
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
                event = next_feed_event(&mut self.feed_events) => self.on_feed_event(event),
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

fn first_line(message: &str) -> Option<String> {
    message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

async fn next_feed_event(events: &mut Option<mpsc::Receiver<FeedEvent>>) -> Option<FeedEvent> {
    match events {
        Some(queue) => queue.recv().await,
        None => std::future::pending().await,
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
    feed: Arc<dyn FeedConnector>,
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
    let (hub, events) = connector
        .connect(token.clone())
        .await
        .map_err(BootError::Failed)?;
    // The app works without live delivery, so this failing is not a failed start.
    let feed = feed.connect(token).await.ok();
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
        feed,
        device_id,
        systems,
    })
}
