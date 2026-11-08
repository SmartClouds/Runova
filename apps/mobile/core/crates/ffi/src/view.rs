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

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AgentState {
    Idle,
    Working,
    NeedsInput,
    Done,
    Exited,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TerminalItem {
    pub session_id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub cli_id: Option<String>,
    pub status: Option<AgentState>,
    pub created_at: i64,
}

/// Neighbouring cells with one style. Colors are `0xRRGGBB`; `None` is the theme's own.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RunView {
    pub text: String,
    pub fg: Option<u32>,
    pub bg: Option<u32>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub cursor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LineView {
    pub runs: Vec<RunView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct CursorView {
    pub row: u16,
    pub col: u16,
}

/// No rows means the computer has not sent the screen yet.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FrameView {
    pub cols: u16,
    pub rows: u16,
    pub cursor: Option<CursorView>,
    pub lines: Vec<LineView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TerminalView {
    pub session_id: String,
    pub title: String,
    pub frame: FrameView,
    /// Looking at history, so new output is not on screen.
    pub scrolled: bool,
    pub ended: bool,
    pub end_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TerminalProcessView {
    pub name: String,
    pub cpu_percent: f64,
    pub mem_bytes: u64,
    pub cpu_label: String,
    pub memory_label: String,
}

/// A screen that refreshes itself for as long as it is on show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Section {
    Clis,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct AppView {
    pub auth: AuthState,
    pub hub_connected: bool,
    pub systems: Vec<SystemView>,
    pub systems_loading: bool,
    pub connection: Option<ConnectionView>,
    pub projects: Vec<ProjectView>,
    pub projects_loading: bool,
    pub selected_project: Option<String>,
    pub terminals: Vec<TerminalItem>,
    pub terminals_loading: bool,
    pub terminal: Option<TerminalView>,
    pub terminal_processes: Vec<TerminalProcessView>,
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
            selected_project: None,
            terminals: Vec::new(),
            terminals_loading: false,
            terminal: None,
            terminal_processes: Vec::new(),
            error: None,
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait ViewListener: Send + Sync {
    fn on_view(&self, view: AppView);
}
