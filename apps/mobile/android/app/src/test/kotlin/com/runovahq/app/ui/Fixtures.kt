package com.runovahq.app.ui

import uniffi.runova_ffi.AccountScreen
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.AutoFixSessionView
import uniffi.runova_ffi.PromptsScreen
import uniffi.runova_ffi.ConfirmView
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.DeployScreen
import uniffi.runova_ffi.ErrorsScreen
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.GitToolsScreen
import uniffi.runova_ffi.MonitoringScreen
import uniffi.runova_ffi.NotificationsScreen
import uniffi.runova_ffi.PipelinesScreen
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.RemoteView
import uniffi.runova_ffi.StatusScreen
import uniffi.runova_ffi.StudioScreen
import uniffi.runova_ffi.SystemView
import uniffi.runova_ffi.TerminalItem
import uniffi.runova_ffi.TerminalProcessView
import uniffi.runova_ffi.TerminalView
import uniffi.runova_ffi.VaultLockState
import uniffi.runova_ffi.VaultScreen

val emptyGit = GitScreen(null, false, null, false, emptyList(), emptyList())
val emptyStatus = StatusScreen(null, false, emptyList(), emptyList(), null, emptyList())
val emptyDeploy = DeployScreen(emptyList(), false, null, null)
val emptyMonitoring = MonitoringScreen(emptyList(), emptyList(), false, null, null)
val emptyErrors = ErrorsScreen(false, false, emptyList(), null, emptyList(), null, null)
val emptyPipelines = PipelinesScreen(null, false, null, null, null)
val emptyAccount = AccountScreen(null, false, emptyList(), emptyList(), emptyList(), emptyList(), null, null)
val emptyNotifications = NotificationsScreen(emptyList(), 0u, false, emptyList(), false, null)
val emptyVault = VaultScreen(VaultLockState.UNKNOWN, false, false, false, null, emptyList(), null, null, null)

/** One place to build what the core publishes, so a new screen changes only this function. */
fun appView(
    auth: AuthState = AuthState.SIGNED_IN,
    systems: List<SystemView> = emptyList(),
    connection: ConnectionView? = null,
    projects: List<ProjectView> = emptyList(),
    projectsLoading: Boolean = false,
    selected: String? = null,
    terminals: List<TerminalItem> = emptyList(),
    terminal: TerminalView? = null,
    processes: List<TerminalProcessView> = emptyList(),
    git: GitScreen = emptyGit,
    status: StatusScreen = emptyStatus,
    vault: VaultScreen = emptyVault,
    deploy: DeployScreen = emptyDeploy,
    monitoring: MonitoringScreen = emptyMonitoring,
    errors: ErrorsScreen = emptyErrors,
    pipelines: PipelinesScreen = emptyPipelines,
    account: AccountScreen = emptyAccount,
    notifications: NotificationsScreen = emptyNotifications,
    remote: RemoteView? = null,
    notice: String? = null,
    confirm: ConfirmView? = null,
    error: String? = null,
    phoneFingerprint: String? = null,
    showIntro: Boolean = false,
    appVersion: String = "1.0.0",
    studio: StudioScreen = StudioScreen(false, null, emptyList(), null, null),
    busy: Boolean = false,
    gitTools: GitToolsScreen = GitToolsScreen(null, null, null),
    autoFix: List<AutoFixSessionView> = emptyList(),
    prompts: PromptsScreen = PromptsScreen(null, false, null, null),
) = AppView(
    auth,
    true,
    systems,
    false,
    connection,
    projects,
    projectsLoading,
    selected,
    terminals,
    false,
    terminal,
    processes,
    git,
    status,
    vault,
    deploy,
    monitoring,
    errors,
    pipelines,
    account,
    notifications,
    remote,
    phoneFingerprint,
    busy,
    notice,
    confirm,
    error,
    showIntro,
    appVersion,
    studio,
    gitTools,
    autoFix,
    prompts,
)
