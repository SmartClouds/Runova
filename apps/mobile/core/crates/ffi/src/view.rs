//! What native code draws. Screens render this and send intents back; they decide nothing.

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AuthState {
    Starting,
    SignedOut,
    SignedIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ConnectionPhase {
    Requesting,
    WaitingForApproval,
    Connecting,
    Securing,
    Connected,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SystemView {
    pub id: i64,
    pub remote_id: String,
    pub name: String,
    pub platform: String,
    pub online: bool,
    pub own: bool,
    /// False when only the background agent is keeping it online.
    pub can_manage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConnectionView {
    pub system_id: i64,
    pub system_name: String,
    pub phase: ConnectionPhase,
    pub safety_code: Option<String>,
    pub direct: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub has_repository: bool,
    pub icon_bg_color: Option<String>,
    pub icon_color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AppView {
    pub auth: AuthState,
    pub hub_connected: bool,
    pub systems: Vec<SystemView>,
    pub systems_loading: bool,
    pub connection: Option<ConnectionView>,
    pub projects: Vec<ProjectView>,
    pub projects_loading: bool,
    pub error: Option<String>,
}

impl AppView {
    pub(crate) fn starting() -> Self {
        Self {
            auth: AuthState::Starting,
            hub_connected: false,
            systems: Vec::new(),
            systems_loading: false,
            connection: None,
            projects: Vec::new(),
            projects_loading: false,
            error: None,
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait ViewListener: Send + Sync {
    fn on_view(&self, view: AppView);
}
