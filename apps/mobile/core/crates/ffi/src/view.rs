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
    Git,
    Status,
    Vault,
    Deploy,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DeployServerView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub state_label: String,
    pub online: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ContainerView {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub running: bool,
    pub healthy: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StackView {
    pub id: String,
    pub name: String,
    pub status: String,
    pub detail: String,
    pub can_redeploy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ProblemSeverity {
    Critical,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProblemView {
    pub id: String,
    pub severity: ProblemSeverity,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BackupView {
    pub label: String,
    pub detail: String,
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ServerDetailView {
    pub id: String,
    pub name: String,
    pub loading: bool,
    pub unreachable: Option<String>,
    pub containers: Vec<ContainerView>,
    pub stacks: Vec<StackView>,
    pub problems: Vec<ProblemView>,
    pub backup: Option<BackupView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LogLineView {
    pub text: String,
    pub error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ContainerLogsView {
    pub container_id: String,
    pub name: String,
    pub loading: bool,
    pub lines: Vec<LogLineView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct DeployScreen {
    pub servers: Vec<DeployServerView>,
    pub loading: bool,
    pub server: Option<ServerDetailView>,
    pub logs: Option<ContainerLogsView>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum VaultLockState {
    #[default]
    Unknown,
    Uninitialized,
    Locked,
    Unlocked,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct VaultSecretField {
    pub key: String,
    pub label: String,
    /// A custom field, asked for by its id.
    pub custom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct VaultEntryView {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub favorite: bool,
    pub editable: bool,
    pub secrets: Vec<VaultSecretField>,
}

/// Native code runs the phone's own check and answers with `biometric_result`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BiometricRequestView {
    pub id: u64,
    pub reason: String,
}

#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct RevealedSecretView {
    pub label: String,
    pub value: String,
}

/// Written by hand so a view printed for debugging can never carry the value.
impl std::fmt::Debug for RevealedSecretView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RevealedSecretView")
            .field("label", &self.label)
            .field("value", &"<hidden>")
            .finish()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct VaultScreen {
    pub state: VaultLockState,
    pub loading: bool,
    /// While true, native code blocks screenshots and hides the app switcher preview.
    pub on_show: bool,
    pub unlock_error: Option<String>,
    pub entries: Vec<VaultEntryView>,
    pub open_entry: Option<String>,
    pub biometric: Option<BiometricRequestView>,
    pub revealed: Option<RevealedSecretView>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SystemStatsView {
    pub cpu_percent: f64,
    pub cpu_label: String,
    pub cpu_detail: String,
    pub mem_percent: f64,
    pub mem_label: String,
    pub net_down_label: String,
    pub net_up_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LimitState {
    /// The account's own numbers.
    Ok,
    /// Worked out from local logs because the account did not answer.
    Estimate,
    /// The last numbers the account gave.
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LimitWindowView {
    pub label: String,
    pub percent: f64,
    pub percent_label: String,
    pub resets_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LimitChipView {
    pub provider_id: String,
    pub name: String,
    pub plan: Option<String>,
    pub state: LimitState,
    pub windows: Vec<LimitWindowView>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ProviderState {
    Ok,
    Connect,
    Error,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ProviderUsageView {
    pub provider_id: String,
    pub name: String,
    pub state: ProviderState,
    pub error: Option<String>,
    pub today_label: Option<String>,
    pub week_label: Option<String>,
    pub month_label: Option<String>,
    pub series: Vec<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct StatusScreen {
    pub system: Option<SystemStatsView>,
    pub loading: bool,
    pub limits: Vec<LimitChipView>,
    pub providers: Vec<ProviderUsageView>,
    /// The provider whose detail is open.
    pub detail: Option<String>,
}

/// Asked before anything hard to undo.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConfirmView {
    pub title: String,
    pub detail: String,
    pub action: String,
    pub danger: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum GitGroup {
    Conflict,
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitFileView {
    pub path: String,
    pub orig_path: Option<String>,
    pub group: GitGroup,
    pub status: String,
    pub conflict: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitStateView {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote: bool,
    pub operation: Option<String>,
    pub files: Vec<GitFileView>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DiffLineKind {
    Hunk,
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DiffLineView {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitDiffView {
    pub path: String,
    pub group: GitGroup,
    pub loading: bool,
    pub binary: bool,
    pub too_large: bool,
    pub lines: Vec<DiffLineView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitBranchView {
    pub name: String,
    pub current: bool,
    pub local: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitStashView {
    pub reference: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct GitScreen {
    pub state: Option<GitStateView>,
    pub loading: bool,
    pub diff: Option<GitDiffView>,
    pub branches_open: bool,
    pub branches: Vec<GitBranchView>,
    pub stashes: Vec<GitStashView>,
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
    pub git: GitScreen,
    pub status: StatusScreen,
    pub vault: VaultScreen,
    pub deploy: DeployScreen,
    /// Something asked for is still being done on the computer.
    pub busy: bool,
    /// That it worked, for a moment.
    pub notice: Option<String>,
    pub confirm: Option<ConfirmView>,
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
            git: GitScreen::default(),
            status: StatusScreen::default(),
            vault: VaultScreen::default(),
            deploy: DeployScreen::default(),
            busy: false,
            notice: None,
            confirm: None,
            error: None,
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait ViewListener: Send + Sync {
    fn on_view(&self, view: AppView);
}
