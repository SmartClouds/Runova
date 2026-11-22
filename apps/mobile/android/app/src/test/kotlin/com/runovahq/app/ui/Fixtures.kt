package com.runovahq.app.ui

import uniffi.runova_ffi.AccountItem
import uniffi.runova_ffi.AccountsView
import uniffi.runova_ffi.PushLabelView
import uniffi.runova_ffi.AccountScreen
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.AutoFixSessionView
import uniffi.runova_ffi.AutoLock
import uniffi.runova_ffi.AutoLockChoice
import uniffi.runova_ffi.BiometricKind
import uniffi.runova_ffi.LockScreen
import uniffi.runova_ffi.PasscodeEntryView
import uniffi.runova_ffi.PasscodeKind
import uniffi.runova_ffi.PasscodeSettingsScreen
import uniffi.runova_ffi.PasscodeStep
import uniffi.runova_ffi.PromptsScreen
import uniffi.runova_ffi.ConfirmView
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.CloudflareScreen
import uniffi.runova_ffi.DeployScreen
import uniffi.runova_ffi.ErrorsScreen
import uniffi.runova_ffi.EncryptionScreen
import uniffi.runova_ffi.GitMoreScreen
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.GitToolsScreen
import uniffi.runova_ffi.MonitoringScreen
import uniffi.runova_ffi.NotificationsScreen
import uniffi.runova_ffi.PipelinesScreen
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.PasskeySignInView
import uniffi.runova_ffi.ProviderSignInView
import uniffi.runova_ffi.QrSignInView
import uniffi.runova_ffi.RecoveryPhrasesScreen
import uniffi.runova_ffi.RemoteView
import uniffi.runova_ffi.ReceiveScreen
import uniffi.runova_ffi.SendScreen
import uniffi.runova_ffi.StatusScreen
import uniffi.runova_ffi.StudioScreen
import uniffi.runova_ffi.StudioToolsScreen
import uniffi.runova_ffi.SystemView
import uniffi.runova_ffi.TerminalItem
import uniffi.runova_ffi.TerminalProcessView
import uniffi.runova_ffi.TerminalView
import uniffi.runova_ffi.VaultLockState
import uniffi.runova_ffi.VaultScreen

val emptyGit = GitScreen(null, false, null, false, emptyList(), emptyList())
val emptyStatus = StatusScreen(null, false, emptyList(), emptyList(), null, emptyList())
val emptyDeploy = DeployScreen(emptyList(), false, null, null, null)
val emptyCloudflare = CloudflareScreen(false, false, null, emptyList(), null, null, null, null, null, null, null, null, null, null, emptyList(), null, null, null, null)
val emptyMonitoring = MonitoringScreen(emptyList(), emptyList(), false, null, null)
val emptyErrors = ErrorsScreen(false, false, emptyList(), null, emptyList(), null, null)
val emptyPipelines = PipelinesScreen(null, false, null, null, null)
val emptyAccount = AccountScreen(null, false, emptyList(), emptyList(), emptyList(), emptyList(), null, null)
val emptyNotifications = NotificationsScreen(emptyList(), 0u, false, emptyList(), false, null)
val emptyVault = VaultScreen(VaultLockState.UNKNOWN, false, false, false, null, emptyList(), null, null, null)

/** The keypad as the core sends it: `filled` of `kind`'s dots, and what to say above them. */
fun entry(
    kind: PasscodeKind = PasscodeKind.PIN4,
    filled: Int = 0,
    title: String = "Enter your passcode",
    error: String? = null,
    shake: Long = 0,
    waitSeconds: Int = 0,
) = PasscodeEntryView(
    kind = kind,
    length = when (kind) {
        PasscodeKind.PIN4 -> 4u
        PasscodeKind.PIN6 -> 6u
        PasscodeKind.PASSWORD -> 0u
    },
    filled = filled.toUByte(),
    title = title,
    error = error,
    shake = shake.toULong(),
    busy = false,
    waitSeconds = waitSeconds.toUInt(),
)

val noLock = LockScreen(false, false, entry(), null, BiometricKind.NONE, null, false)

fun locked(
    entry: PasscodeEntryView = entry(),
    biometricLabel: String? = null,
    biometricKind: BiometricKind = BiometricKind.NONE,
    confirmForgot: Boolean = false,
) = LockScreen(true, true, entry, biometricLabel, biometricKind, null, confirmForgot)

private val autoLockLabels = listOf(
    AutoLock.IMMEDIATELY to "Right away",
    AutoLock.ONE_MINUTE to "After 1 minute",
    AutoLock.FIVE_MINUTES to "After 5 minutes",
    AutoLock.ONE_HOUR to "After 1 hour",
    AutoLock.FIVE_HOURS to "After 5 hours",
)

fun passcodeScreen(
    open: Boolean = true,
    step: PasscodeStep = PasscodeStep.OFF,
    entry: PasscodeEntryView = entry(title = ""),
    autoLock: AutoLock = AutoLock.ONE_MINUTE,
    biometricLabel: String? = null,
    biometricKind: BiometricKind = BiometricKind.NONE,
    biometricOn: Boolean = false,
) = PasscodeSettingsScreen(
    open = open,
    step = step,
    entry = entry,
    autoLock = autoLock,
    autoLockLabel = autoLockLabels.first { it.first == autoLock }.second,
    autoLockChoices = autoLockLabels.map { AutoLockChoice(it.first, it.second) },
    biometricLabel = biometricLabel,
    biometricKind = biometricKind,
    biometricOn = biometricOn,
)

val noPasscode = passcodeScreen(open = false)

/** The recovery phrases screen with nothing scanned (E108). */
val noPhrases = RecoveryPhrasesScreen(emptyList(), null, null, null, null, null)

/** The Send files screen with nothing sent (E113). */
val noSends = SendScreen(emptyList(), emptyList(), null, 0u, null, 0u)

/** Nothing sent to the phone, and it takes files once it knows where (E114). */
val noReceives = ReceiveScreen(true, false, true, emptyList(), emptyList(), 0u, null, 0u)

/** One account on the phone (E118). */
fun accountItem(
    id: Long,
    name: String,
    email: String,
    initials: String,
    tone: Int = 0,
    active: Boolean = false,
    needsSignIn: Boolean = false,
    lastUsed: String = if (active) "In use" else "Used 2d ago",
) = AccountItem(id, name, email, initials, tone.toUByte(), active, needsSignIn, lastUsed)

val workAccount = accountItem(11, "Sam Rivera", "sam@work.test", "SR", tone = 5)
val homeAccount = accountItem(22, "Sam", "sam@home.test", "S", tone = 4, active = true)

/** A phone with one account, which is how every screen test before E118 ran. */
val noAccounts = AccountsView(emptyList(), false, null, null, emptyList())

/** The work and the home account, with home in use. */
val twoAccounts = AccountsView(
    listOf(workAccount, homeAccount),
    false,
    null,
    null,
    listOf(PushLabelView("work-tag-123", "sam@work.test"), PushLabelView("home-tag-456", "sam@home.test")),
)

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
    cloudflare: CloudflareScreen = emptyCloudflare,
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
    prompts: PromptsScreen = PromptsScreen(null, false, null, null, emptyList(), emptyList(), emptyList()),
    studioTools: StudioToolsScreen = StudioToolsScreen(null, null, null, null),
    gitMore: GitMoreScreen = GitMoreScreen(null, null),
    encryption: EncryptionScreen? = null,
    qrSignIn: QrSignInView? = null,
    passkeySignIn: PasskeySignInView? = null,
    providerSignIn: ProviderSignInView? = null,
    continueInBrowser: String? = null,
    lock: LockScreen = noLock,
    passcode: PasscodeSettingsScreen = noPasscode,
    recoveryPhrases: RecoveryPhrasesScreen = noPhrases,
    send: SendScreen = noSends,
    receive: ReceiveScreen = noReceives,
    accounts: AccountsView = noAccounts,
    demo: Boolean = false,
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
    cloudflare,
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
    studioTools,
    gitMore,
    encryption,
    qrSignIn,
    passkeySignIn,
    providerSignIn,
    continueInBrowser,
    lock,
    passcode,
    recoveryPhrases,
    send,
    receive,
    accounts,
    demo,
)
