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
    Monitoring,
    Pipelines,
    Account,
    Notifications,
    Studio,
    Prompts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum NotificationDestination {
    Inbox,
    Monitors,
    Account,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NotificationItemView {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub category: String,
    pub destination: NotificationDestination,
    pub read: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NotificationPreferenceView {
    pub category: String,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct NotificationsScreen {
    pub items: Vec<NotificationItemView>,
    pub unread: u32,
    pub loading: bool,
    pub preferences: Vec<NotificationPreferenceView>,
    pub settings_open: bool,
    /// One that just arrived while the app is open.
    pub banner: Option<NotificationItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProfileView {
    pub name: String,
    pub email: String,
    pub two_factor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SessionView {
    pub id: i64,
    pub title: String,
    pub detail: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityView {
    pub id: i64,
    pub action: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TeamView {
    pub id: i64,
    pub name: String,
    pub role: String,
    /// The role as the server spells it, which is what rules are decided on.
    pub role_key: String,
    pub member_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MyInvitationView {
    pub id: i64,
    pub team: String,
    pub role: String,
    pub invited_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RoleOptionView {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TeamMemberView {
    pub user_id: i64,
    pub name: String,
    pub role: String,
    /// Whether the person using the app may change or remove this member.
    pub can_change: bool,
    pub role_options: Vec<RoleOptionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TeamInvitationView {
    pub id: i64,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TeamDetailView {
    pub id: i64,
    pub name: String,
    pub my_role: String,
    pub can_manage: bool,
    pub members: Vec<TeamMemberView>,
    pub invitations: Vec<TeamInvitationView>,
}

/// The website asks for a password or code again before the riskiest changes.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StepUpView {
    pub title: String,
    pub detail: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct AccountScreen {
    pub profile: Option<ProfileView>,
    pub loading: bool,
    pub sessions: Vec<SessionView>,
    pub activity: Vec<ActivityView>,
    pub teams: Vec<TeamView>,
    pub invitations: Vec<MyInvitationView>,
    pub team: Option<TeamDetailView>,
    pub step_up: Option<StepUpView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MonitorSource {
    /// Run by the computer, so only there while connected to it.
    Local,
    /// Run by Runova, so there with every computer off.
    Cloud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MonitorState {
    Up,
    Degraded,
    Down,
    Paused,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MonitorView {
    pub id: String,
    pub name: String,
    pub source: MonitorSource,
    pub state: MonitorState,
    pub detail: Option<String>,
    pub latency_label: Option<String>,
    pub uptime_label: Option<String>,
    pub paused: bool,
    pub can_check: bool,
    pub can_pause: bool,
    pub samples: Vec<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct MonitoringScreen {
    pub local: Vec<MonitorView>,
    pub cloud: Vec<MonitorView>,
    pub loading: bool,
    /// Why there are no local monitors, when that is not because there are none.
    pub local_note: Option<String>,
    pub open: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ErrorLevel {
    Fatal,
    Error,
    Warning,
    Info,
    Debug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ErrorStatus {
    Unresolved,
    Resolved,
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ErrorIssueView {
    pub connection_id: String,
    pub id: String,
    pub short_id: String,
    pub title: String,
    pub culprit: Option<String>,
    pub level: ErrorLevel,
    pub level_label: String,
    pub status: ErrorStatus,
    pub status_label: String,
    /// Set when it first appeared in the time the list looks at.
    pub new_label: Option<String>,
    /// Project, last seen and counts, for the row in the list.
    pub detail_label: String,
    /// Counts and when it was last seen, for the top of the detail.
    pub activity_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ErrorExceptionView {
    pub title: String,
    pub unhandled: bool,
    pub frames: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ErrorDetailView {
    pub connection_id: String,
    pub issue_id: String,
    pub loading: bool,
    /// The row it was opened from until the computer answers.
    pub issue: Option<ErrorIssueView>,
    pub meta_label: Option<String>,
    pub message: Option<String>,
    pub exceptions: Vec<ErrorExceptionView>,
    pub request: Option<String>,
    pub tags: Vec<String>,
    pub can_resolve: bool,
    pub can_reopen: bool,
    /// Why neither of those is on offer.
    pub write_note: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct ErrorsScreen {
    pub open: bool,
    pub loading: bool,
    pub issues: Vec<ErrorIssueView>,
    /// Why the list is empty, in words, when there is a reason worth giving.
    pub note: Option<String>,
    /// Connections this computer could not read, by name.
    pub problems: Vec<String>,
    pub cut_note: Option<String>,
    pub detail: Option<ErrorDetailView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PipelineRunState {
    Queued,
    Running,
    Success,
    Failed,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PipelineRunView {
    pub id: i64,
    pub title: String,
    pub branch: String,
    pub number: u32,
    pub state: PipelineRunState,
    pub state_label: String,
    pub can_cancel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WorkflowView {
    pub id: i64,
    pub name: String,
    pub can_dispatch: bool,
    pub run: Option<PipelineRunView>,
    pub inputs: Vec<WorkflowInputView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum WorkflowInputKind {
    Text,
    Choice,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WorkflowInputView {
    pub name: String,
    pub description: String,
    pub required: bool,
    pub kind: WorkflowInputKind,
    pub default_value: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DispatchFormView {
    pub workflow_id: i64,
    pub name: String,
    pub inputs: Vec<WorkflowInputView>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PipelinesStatusView {
    pub problem: Option<String>,
    pub workflows: Vec<WorkflowView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PipelineJobView {
    pub id: i64,
    pub name: String,
    pub state: PipelineRunState,
    pub state_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PipelineRunDetailView {
    pub run_id: i64,
    pub loading: bool,
    pub jobs: Vec<PipelineJobView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JobLogView {
    pub job_id: i64,
    pub name: String,
    pub loading: bool,
    pub truncated: bool,
    pub lines: Vec<LogLineView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct PipelinesScreen {
    pub status: Option<PipelinesStatusView>,
    pub loading: bool,
    pub run: Option<PipelineRunDetailView>,
    pub log: Option<JobLogView>,
    pub dispatch_form: Option<DispatchFormView>,
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
    /// The app has left the screen, so a value that arrives now is not kept.
    pub in_background: bool,
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

/// A line of what the computer is up to, in the order the desktop's status bar has them.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ComputerItemView {
    pub id: String,
    pub title: String,
    pub value: String,
    pub detail: Option<String>,
    /// It wants someone to look at it.
    pub attention: bool,
}

#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct StatusScreen {
    pub system: Option<SystemStatsView>,
    pub loading: bool,
    pub limits: Vec<LimitChipView>,
    pub providers: Vec<ProviderUsageView>,
    /// The provider whose detail is open.
    pub detail: Option<String>,
    pub computer: Vec<ComputerItemView>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RemotePhase {
    Requesting,
    WaitingForApproval,
    Connecting,
    Securing,
    NeedsPassword,
    Live,
    Failed,
}

/// The screen of a computer on show. The pixels themselves never come through here.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct RemoteView {
    pub system_id: i64,
    pub system_name: String,
    pub phase: RemotePhase,
    pub error: Option<String>,
    /// The computer also takes its unattended-access password.
    pub can_use_password: bool,
    /// Only the background agent is answering, so this is the sign-in screen or an idle desktop.
    pub agent: bool,
    pub width: u32,
    pub height: u32,
    pub direct: Option<bool>,
    pub safety_code: Option<String>,
    /// Text the computer sent to this phone's clipboard, until it is dealt with.
    pub clipboard: Option<String>,
    pub note: Option<String>,
}

/// Written by hand so a view printed for debugging can not carry clipboard text.
impl std::fmt::Debug for RemoteView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteView")
            .field("system_id", &self.system_id)
            .field("phase", &self.phase)
            .field("error", &self.error)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("direct", &self.direct)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StudioRenderState {
    Queued,
    Running,
    Done,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StudioStepState {
    Todo,
    Active,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioVideoItemView {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub pinned: bool,
    pub missing: bool,
    pub render_label: Option<String>,
    pub render_state: Option<StudioRenderState>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioLanguageView {
    pub code: String,
    pub name: String,
    pub native: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioStyleView {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// `#RRGGBB`, background first.
    pub colors: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct StudioComposerView {
    pub languages: Vec<StudioLanguageView>,
    pub styles: Vec<StudioStyleView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioStepView {
    pub label: String,
    pub detail: String,
    pub state: StudioStepState,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioSceneView {
    pub id: String,
    pub number: u32,
    pub title: String,
    pub narration: String,
    pub duration_label: String,
    pub animated: bool,
    pub can_animate: bool,
    /// The key to ask `studio_thumbnail` with, once `thumbnail_ready`.
    pub thumbnail: Option<String>,
    pub thumbnail_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioRunView {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioChangeField {
    pub label: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioChangeView {
    pub title: String,
    pub fields: Vec<StudioChangeField>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioProposalView {
    pub generation_id: String,
    pub summary: String,
    pub changes: Vec<StudioChangeView>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct StudioRenderView {
    pub id: String,
    pub file_name: String,
    pub state: StudioRenderState,
    pub label: String,
    pub percent: Option<f64>,
    pub can_cancel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StudioRenderSheetView {
    pub loading: bool,
    pub quality: String,
    pub summary: Option<String>,
    pub warnings: Vec<String>,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct StudioVideoView {
    pub loading: bool,
    pub id: String,
    pub title: String,
    pub aspect: String,
    pub quality: String,
    pub can_undo: bool,
    pub undo_label: Option<String>,
    pub steps: Vec<StudioStepView>,
    pub scenes: Vec<StudioSceneView>,
    pub problem: Option<String>,
    pub run: Option<StudioRunView>,
    pub proposal: Option<StudioProposalView>,
    pub renders: Vec<StudioRenderView>,
    pub animating_all: bool,
    pub animate_all_label: Option<String>,
    pub can_ask: bool,
    pub can_render: bool,
    pub render_sheet: Option<StudioRenderSheetView>,
}

#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct StudioScreen {
    pub loading: bool,
    pub note: Option<String>,
    pub videos: Vec<StudioVideoItemView>,
    pub composer: Option<StudioComposerView>,
    pub video: Option<StudioVideoView>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitTagOptionView {
    pub kind: String,
    pub tag: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitTagSuggestionView {
    pub tag: String,
    pub reason: Option<String>,
    pub message: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitTagsView {
    pub loading: bool,
    pub latest: Option<String>,
    pub commits_label: String,
    pub has_remote: bool,
    pub recent: Vec<String>,
    pub options: Vec<GitTagOptionView>,
    pub suggesting: bool,
    pub suggestion: Option<GitTagSuggestionView>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum GitAiKind {
    Commit,
    Branch,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GitAiView {
    pub kind: GitAiKind,
    pub loading: bool,
    /// The answer, until the field has taken it.
    pub text: Option<String>,
    pub note: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct GitToolsScreen {
    pub tags: Option<GitTagsView>,
    pub ai: Option<GitAiView>,
    /// The conflicted file the AI is working on.
    pub resolving: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AutoFixTone {
    Working,
    Attention,
    Done,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AutoFixSessionView {
    pub id: String,
    pub workflow_id: i64,
    pub title: String,
    pub phase_label: String,
    pub tone: AutoFixTone,
    pub message: Option<String>,
    pub timeline: Vec<String>,
    /// The terminal of the agent at work, to follow it.
    pub agent_session: Option<String>,
    pub can_stop: bool,
    pub can_retry: bool,
    pub can_commit: bool,
    pub can_dismiss: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PromptTargetView {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PromptOptionsView {
    pub types: Vec<String>,
    pub targets: Vec<PromptTargetView>,
    pub default_target: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct PromptsScreen {
    pub options: Option<PromptOptionsView>,
    pub generating: bool,
    /// A freshly written prompt, until the field has taken it.
    pub result: Option<String>,
    pub error: Option<String>,
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
    pub monitoring: MonitoringScreen,
    pub errors: ErrorsScreen,
    pub pipelines: PipelinesScreen,
    pub account: AccountScreen,
    pub notifications: NotificationsScreen,
    pub remote: Option<RemoteView>,
    /// The code to compare with the one the computer shows while it asks about this phone.
    pub phone_fingerprint: Option<String>,
    /// Something asked for is still being done on the computer.
    pub busy: bool,
    /// That it worked, for a moment.
    pub notice: Option<String>,
    pub confirm: Option<ConfirmView>,
    pub error: Option<String>,
    /// This install has not been through the welcome pages yet.
    pub show_intro: bool,
    pub app_version: String,
    pub studio: StudioScreen,
    pub git_tools: GitToolsScreen,
    pub auto_fix: Vec<AutoFixSessionView>,
    pub prompts: PromptsScreen,
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
            monitoring: MonitoringScreen::default(),
            errors: ErrorsScreen::default(),
            pipelines: PipelinesScreen::default(),
            account: AccountScreen::default(),
            notifications: NotificationsScreen::default(),
            remote: None,
            phone_fingerprint: None,
            busy: false,
            notice: None,
            confirm: None,
            error: None,
            show_intro: false,
            app_version: String::new(),
            studio: StudioScreen::default(),
            git_tools: GitToolsScreen::default(),
            auto_fix: Vec::new(),
            prompts: PromptsScreen::default(),
        }
    }
}

#[uniffi::export(with_foreign)]
pub trait ViewListener: Send + Sync {
    fn on_view(&self, view: AppView);
}
