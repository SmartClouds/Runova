package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaBottomBar
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaHeroIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaSkeleton
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.TabItem
import uniffi.runova_ffi.AccountsView
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ConfirmView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.SystemView

/** What the screens can ask for. Everything else is decided in the Rust core. */
data class AppIntents(
    val signIn: () -> Unit = {},
    val refresh: () -> Unit = {},
    val connect: (Long) -> Unit = {},
    val disconnect: () -> Unit = {},
    val signOut: () -> Unit = {},
    val openSection: (Section?) -> Unit = {},
    val selectProject: (String?) -> Unit = {},
    val openTerminal: (String) -> Unit = {},
    val closeTerminal: () -> Unit = {},
    val terminalInput: (String) -> Unit = {},
    val terminalScroll: (Int) -> Unit = {},
    val loadProcesses: (String) -> Unit = {},
    val confirm: () -> Unit = {},
    val dismissConfirm: () -> Unit = {},
    val dismissNotice: () -> Unit = {},
    val finishIntro: () -> Unit = {},
    val scanSignIn: (String) -> Unit = {},
    val cancelQrSignIn: () -> Unit = {},
    /** Asks the core for a passkey challenge (E115). */
    val signInWithPasskey: () -> Unit = {},
    /** Shows the platform's passkey prompt for a challenge the core put in the view. */
    val promptPasskey: (challengeId: String, optionsJson: String) -> Unit = { _, _ -> },
    /** Asks the core for a nonce for a provider's own sheet: Google on Android (E117). */
    val signInWithProvider: (provider: String) -> Unit = {},
    /** Opens the browser sign-in going straight to a provider (E117). */
    val signInInBrowser: (provider: String) -> Unit = {},
    /** Shows Google's sheet for a nonce the core put in the view. */
    val promptGoogle: (nonce: String, clientId: String?) -> Unit = { _, _ -> },
    val openAbout: () -> Unit = {},
    /** Opens the account switcher (E118). The app's root fills this in. */
    val openAccounts: () -> Unit = {},
    val accounts: AccountsIntents = AccountsIntents(),
    val git: GitIntents = GitIntents(),
    val status: StatusIntents = StatusIntents(),
    val vault: VaultIntents = VaultIntents(),
    val deploy: DeployIntents = DeployIntents(),
    val cloudflare: CloudflareIntents = CloudflareIntents(),
    val monitoring: MonitoringIntents = MonitoringIntents(),
    val pipelines: PipelineIntents = PipelineIntents(),
    val account: AccountIntents = AccountIntents(),
    val forgetThisPhone: () -> Unit = {},
    val notifications: NotificationIntents = NotificationIntents(),
    val remote: RemoteIntents = RemoteIntents(),
    val studio: StudioIntents = StudioIntents(),
    val prompts: PromptIntents = PromptIntents(),
    val lock: LockIntents = LockIntents(),
    val passcode: PasscodeIntents = PasscodeIntents(),
    val phrases: PhraseIntents = PhraseIntents(),
    val send: SendIntents = SendIntents(),
    val receive: ReceiveIntents = ReceiveIntents(),
)

val AppTabs = listOf(
    TabItem("systems", "Systems", RunovaIcons.Systems),
    TabItem("monitors", "Monitors", RunovaIcons.Monitoring),
    TabItem("inbox", "Inbox", RunovaIcons.Notifications),
    TabItem("account", "Account", RunovaIcons.Account),
)

@Composable
fun AppRoot(view: AppView, tab: String, onTab: (String) -> Unit, appIntents: AppIntents) {
    val colors = RunovaTheme.colors
    var aboutOpen by remember { mutableStateOf(false) }
    var switcherOpen by remember { mutableStateOf(false) }
    var manageOpen by rememberSaveable { mutableStateOf(false) }
    val intents = remember(appIntents) {
        appIntents.copy(openAbout = { aboutOpen = true }, openAccounts = { switcherOpen = true })
    }
    if (view.lock.locked) {
        // Only the lock is composed, so nothing behind it reaches the screen or a screen reader.
        AppLockScreen(view.lock, intents.lock)
        return
    }
    // The chrome: what the desktop's title bar and menu are drawn on.
    CompositionLocalProvider(LocalGitTools provides view.gitTools) {
    Box(Modifier.fillMaxSize().background(colors.card)) {
        when (view.auth) {
            AuthState.STARTING -> StartingScreen()
            AuthState.SIGNED_OUT ->
                if (view.showIntro) IntroScreen(intents.finishIntro) else SignInFlow(view, intents, adding = false)
            AuthState.SIGNED_IN -> {
                val connection = view.connection
                val remote = view.remote
                val switching = view.accounts.switching
                when {
                    switching != null -> SwitchingScreen(switching)
                    // Adding an account: the sign-in screen over the account in use (E118).
                    view.accounts.adding -> SignInFlow(view, intents, adding = true)
                    manageOpen -> ManageAccountsScreen(view.accounts, intents.accounts) { manageOpen = false }
                    // Sending files goes beside a connection, so it opens over whatever is on show.
                    intents.send.picks.open ->
                        SendFilesScreen(view.send, intents.send, view.receive, intents.receive) { intents.send.picks.open = false }
                    remote != null -> RemoteViewerScreen(remote, intents.remote)
                    connection == null -> Shell(view, tab, onTab, intents)
                    connection.phase == ConnectionPhase.CONNECTED -> DeviceShell(view, connection, tab, onTab, intents)
                    else -> ConnectionScreen(connection, intents, view.phoneFingerprint)
                }
            }
        }
        view.notifications.banner?.let {
            Box(Modifier.align(Alignment.TopCenter)) {
                NotificationBanner(it, view.connection != null, intents.notifications, onTab)
            }
        }
        // What the core says about a switch, over the tabs (a connected computer has its own bar).
        if (view.auth == AuthState.SIGNED_IN && view.connection == null && view.accounts.switching == null) {
            view.notice?.let { notice ->
                AccountToast(notice, intents.dismissNotice, Modifier.align(Alignment.BottomCenter).padding(bottom = 92.dp))
            }
        }
        if (switcherOpen && view.auth == AuthState.SIGNED_IN && !view.accounts.adding) {
            AccountSwitcherSheet(view.accounts, intents.accounts, onManage = { manageOpen = true }) { switcherOpen = false }
        }
        view.account.stepUp?.let { StepUpOverlay(it, intents.account) }
        view.confirm?.let { ConfirmOverlay(it, intents.confirm, intents.dismissConfirm) }
        // Files on their way to the phone ask first, over whatever is on show (E114).
        if (view.auth == AuthState.SIGNED_IN) {
            view.receive.offers.firstOrNull()?.let { IncomingOfferSheet(it, intents.receive) }
        }
        if (aboutOpen) AboutSheet(view.appVersion, { aboutOpen = false })
    }
    }
}

@Composable
private fun ConfirmOverlay(confirm: ConfirmView, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val colors = RunovaTheme.colors
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null, onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        RunovaCard(Modifier.padding(24.dp).fillMaxWidth().clickable(interactionSource = null, indication = null) {}) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaText(confirm.title, style = RunovaType.title)
                RunovaText(confirm.detail, color = colors.mutedForeground)
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaButton("Cancel", onClick = onDismiss, Modifier.weight(1f), kind = ButtonKind.Soft)
                    RunovaButton(
                        confirm.action,
                        onClick = onConfirm,
                        Modifier.weight(1f),
                        kind = if (confirm.danger) ButtonKind.Danger else ButtonKind.Primary,
                    )
                }
            }
        }
    }
}

@Composable
private fun Shell(view: AppView, tab: String, onTab: (String) -> Unit, intents: AppIntents) {
    val section = AppTabs.firstOrNull { it.id == tab }?.id ?: "systems"
    val onShow = when (section) {
        "monitors" -> Section.MONITORING
        "account" -> Section.ACCOUNT
        "inbox" -> Section.NOTIFICATIONS
        else -> null
    }
    DisposableEffect(onShow) {
        if (onShow != null) intents.openSection(onShow)
        onDispose { if (onShow != null) intents.openSection(null) }
    }
    if (section == "monitors" && MonitorOverlay(view, intents.monitoring)) return
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            when (section) {
                "account" -> AccountTab(view, intents)
                "inbox" -> InboxTab(view, intents.notifications, onTab)
                "monitors" -> RunovaScreen("Monitors") {
                    MonitoringTab(view, intents.monitoring)
                }
                else -> SystemsScreen(view, intents)
            }
        }
        RunovaBottomBar(AppTabs, section, onTab)
    }
}

/**
 * Signing in, with its QR scan and the platform prompts. Used signed out, and over the account in
 * use when another is being added.
 */
@Composable
private fun SignInFlow(view: AppView, intents: AppIntents, adding: Boolean) {
    var scanning by remember { mutableStateOf(false) }
    val qr = view.qrSignIn
    when {
        qr != null -> QrWaitingScreen(qr, intents.cancelQrSignIn)
        scanning -> QrScanScreen(
            onCode = {
                scanning = false
                intents.scanSignIn(it)
            },
            onCancel = { scanning = false },
        )
        else -> {
            val passkey = view.passkeySignIn
            // Once per challenge: a recomposition must not open the prompt again.
            if (passkey?.optionsJson != null) {
                LaunchedEffect(passkey.challengeId) {
                    intents.promptPasskey(passkey.challengeId, passkey.optionsJson!!)
                }
            }
            val sheet = view.providerSignIn
            // Once per nonce, as with the passkey prompt.
            if (sheet?.provider == "google" && sheet.nonce != null) {
                LaunchedEffect(sheet.nonce) { intents.promptGoogle(sheet.nonce!!, sheet.clientId) }
            }
            // Two-step sign-in: the browser asks for the code. Once each time it is set.
            view.continueInBrowser?.let { provider ->
                LaunchedEffect(provider) { intents.signInInBrowser(provider) }
            }
            SignInScreen(
                view.error,
                intents.signIn,
                onScanQr = { scanning = true },
                onPasskey = intents.signInWithPasskey,
                passkeyWaiting = passkey != null,
                onGoogle = { intents.signInWithProvider("google") },
                googleWaiting = sheet?.provider == "google",
                onBrowserProvider = intents.signInInBrowser,
                adding = if (adding) view.accounts else null,
                onCancelAdding = intents.accounts.cancelAdd,
                signedOut = if (!adding && view.accounts.items.isNotEmpty()) view.accounts else null,
                onSwitch = intents.accounts.switchTo,
            )
        }
    }
}

@Composable
fun StartingScreen() {
    RunovaSplash()
}

@Composable
fun SignInScreen(
    error: String?,
    onSignIn: () -> Unit,
    onScanQr: () -> Unit = {},
    onPasskey: () -> Unit = {},
    passkeyWaiting: Boolean = false,
    onGoogle: () -> Unit = {},
    googleWaiting: Boolean = false,
    onBrowserProvider: (String) -> Unit = {},
    /** The accounts already on the phone while one more is added (E118). */
    adding: AccountsView? = null,
    onCancelAdding: () -> Unit = {},
    /** The accounts on the phone after a session ended, to sign in again or switch. */
    signedOut: AccountsView? = null,
    onSwitch: (Long) -> Unit = {},
) {
    val colors = RunovaTheme.colors
    Column(Modifier.fillMaxSize()) {
        if (adding != null) {
            val again = adding.reauth
            RunovaTopBar(if (again != null) "Sign in again" else "Add an account", onBack = onCancelAdding)
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (adding != null) {
                val again = adding.reauth
                val current = adding.current()
                RunovaLogo(72.dp)
                Spacer(Modifier.height(12.dp))
                RunovaText(
                    when {
                        again != null -> "Your session for ${again.email} ended. Sign in again to keep using it."
                        current != null -> "You'll stay signed in to ${current.email}."
                        else -> "You'll stay signed in to this account."
                    },
                    color = colors.mutedForeground,
                    align = TextAlign.Center,
                )
            } else {
                RunovaLogo(112.dp)
                Spacer(Modifier.height(12.dp))
                RunovaText("Runova", style = RunovaType.heading)
                Spacer(Modifier.height(6.dp))
                RunovaText(
                    "Your computers, terminals and deployments, wherever you are.",
                    color = colors.mutedForeground,
                    align = TextAlign.Center,
                )
                if (signedOut != null) {
                    Spacer(Modifier.height(16.dp))
                    SignedOutAccounts(signedOut, onSwitch)
                }
            }
            Spacer(Modifier.height(24.dp))
            RunovaButton("Sign in", onClick = onSignIn, modifier = Modifier.fillMaxWidth(), icon = RunovaIcons.Forward)
            Spacer(Modifier.height(8.dp))
            ScanQrButton(onScanQr)
            Spacer(Modifier.height(8.dp))
            RunovaButton(
                if (passkeyWaiting) "Waiting for your passkey…" else "Use a passkey",
                onClick = onPasskey,
                modifier = Modifier.fillMaxWidth(),
                kind = ButtonKind.Soft,
                enabled = !passkeyWaiting,
                icon = RunovaIcons.Fingerprint,
            )
            Spacer(Modifier.height(16.dp))
            RunovaButton(
                if (googleWaiting) "Waiting for Google…" else "Continue with Google",
                onClick = onGoogle,
                modifier = Modifier.fillMaxWidth(),
                kind = ButtonKind.Soft,
                enabled = !googleWaiting,
            )
            Spacer(Modifier.height(8.dp))
            RunovaButton(
                "Continue with Apple",
                onClick = { onBrowserProvider("apple") },
                modifier = Modifier.fillMaxWidth(),
                kind = ButtonKind.Soft,
            )
            Spacer(Modifier.height(8.dp))
            RunovaButton(
                "Continue with Microsoft",
                onClick = { onBrowserProvider("microsoft") },
                modifier = Modifier.fillMaxWidth(),
                kind = ButtonKind.Soft,
            )
            if (error != null) {
                Spacer(Modifier.height(12.dp))
                RunovaText(error, style = RunovaType.small, color = colors.destructive, align = TextAlign.Center)
            }
        }
    }
}

internal fun platformName(platform: String) = when (platform) {
    "windows" -> "Windows"
    "macos" -> "macOS"
    "linux" -> "Linux"
    else -> platform
}

@Composable
fun SystemsScreen(view: AppView, intents: AppIntents) {
    val openSend = { intents.send.picks.open = true }
    RunovaScreen(
        "Systems",
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // With one account there is nothing to switch to, so the bar stays as it was.
                if (view.accounts.items.size > 1) AccountAvatarButton(view.accounts, intents.openAccounts)
                SendFilesButton(openSend)
            }
        },
    ) {
        view.send.progressLabel?.let { label ->
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) {
                SendingStrip(label, view.send.progressPercent.toInt(), RunovaIcons.Send, openSend)
            }
        }
        view.receive.progressLabel?.let { label ->
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) {
                SendingStrip(label, view.receive.progressPercent.toInt(), RunovaIcons.Pull, openSend)
            }
        }
        when {
            view.systems.isEmpty() && view.systemsLoading -> LoadingRows()
            view.systems.isEmpty() -> RunovaEmptyState(
                RunovaIcons.Systems,
                "No computers yet",
                "Sign in to Runova on a computer with this account and it shows up here.",
            )
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
                item {
                    RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(0.dp)) {
                        Column { view.systems.forEach { SystemRow(it, intents) } }
                    }
                }
            }
        }
        view.error?.let {
            RunovaText(
                it,
                Modifier.padding(16.dp),
                style = RunovaType.small,
                color = RunovaTheme.colors.destructive,
            )
        }
    }
}

@Composable
private fun SystemRow(system: SystemView, intents: AppIntents) {
    RunovaListRow(
        title = system.name,
        detail = platformName(system.platform),
        icon = RunovaIcons.Systems,
        iconTone = if (system.online) BadgeTone.Primary else BadgeTone.Neutral,
        flat = true,
        onClick = when {
            !system.online -> null
            system.canManage -> ({ intents.connect(system.id) })
            // Only its screen can be reached, by the background agent or as someone else's computer.
            else -> ({ intents.remote.open(system.id) })
        },
        trailing = {
            when {
                !system.online -> RunovaBadge("Offline", dot = true)
                !system.canManage -> RunovaBadge("Screen only", BadgeTone.Warning, dot = true)
                else -> RunovaBadge("Online", BadgeTone.Success, dot = true)
            }
        },
    )
}

@Composable
internal fun LoadingRows() {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        RunovaSkeleton(Modifier.fillMaxWidth())
        RunovaSkeleton(Modifier.fillMaxWidth(0.7f))
        RunovaSkeleton(Modifier.fillMaxWidth(0.85f))
    }
}

private data class PhaseText(val title: String, val detail: String)

private fun phaseText(connection: ConnectionView) = when (connection.phase) {
    ConnectionPhase.REQUESTING -> PhaseText("Reaching ${connection.systemName}", "Asking Runova where it is.")
    ConnectionPhase.WAITING_FOR_APPROVAL -> PhaseText(
        "Approve on ${connection.systemName}",
        "Runova on that computer is asking whether to let this phone in. You only do this once.",
    )
    ConnectionPhase.CONNECTING -> PhaseText("Connecting", "Looking for a direct route to ${connection.systemName}.")
    ConnectionPhase.SECURING -> PhaseText("Securing the connection", "Checking it really is ${connection.systemName}.")
    ConnectionPhase.CONNECTED -> PhaseText(connection.systemName, "")
    ConnectionPhase.FAILED -> PhaseText("Couldn't connect", connection.error ?: "Something went wrong.")
}

@Composable
fun ConnectionScreen(connection: ConnectionView, intents: AppIntents, fingerprint: String? = null) {
    val colors = RunovaTheme.colors
    val failed = connection.phase == ConnectionPhase.FAILED
    val text = phaseText(connection)
    RunovaScreen(connection.systemName, onBack = intents.disconnect) {
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        ) {
            RunovaHeroIcon(
                if (failed) RunovaIcons.Warning else RunovaIcons.Shield,
                if (failed) BadgeTone.Danger else BadgeTone.Primary,
                Modifier.padding(bottom = 8.dp),
            )
            RunovaText(text.title, style = RunovaType.title, align = TextAlign.Center)
            RunovaText(text.detail, color = colors.mutedForeground, align = TextAlign.Center)
            if (connection.phase == ConnectionPhase.WAITING_FOR_APPROVAL && fingerprint != null) {
                RunovaText("It should show $fingerprint", style = RunovaType.title, align = TextAlign.Center)
            }
            if (failed) {
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaButton("Back", onClick = intents.disconnect, kind = ButtonKind.Soft)
                    RunovaButton("Try again", onClick = { intents.connect(connection.systemId) }, icon = RunovaIcons.Refresh)
                }
            }
        }
    }
}

