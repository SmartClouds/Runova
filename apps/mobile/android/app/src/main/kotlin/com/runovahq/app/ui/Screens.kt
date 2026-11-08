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
import androidx.compose.runtime.Composable
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
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaSkeleton
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.TabItem
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
    val git: GitIntents = GitIntents(),
    val status: StatusIntents = StatusIntents(),
)

val AppTabs = listOf(
    TabItem("systems", "Systems", RunovaIcons.Systems),
    TabItem("account", "Account", RunovaIcons.Account),
)

@Composable
fun AppRoot(view: AppView, tab: String, onTab: (String) -> Unit, intents: AppIntents) {
    val colors = RunovaTheme.colors
    Box(Modifier.fillMaxSize().background(colors.background)) {
        when (view.auth) {
            AuthState.STARTING -> StartingScreen()
            AuthState.SIGNED_OUT -> SignInScreen(view.error, intents.signIn)
            AuthState.SIGNED_IN -> {
                val connection = view.connection
                when {
                    connection == null -> Shell(view, tab, onTab, intents)
                    connection.phase == ConnectionPhase.CONNECTED -> DeviceShell(view, connection, tab, onTab, intents)
                    else -> ConnectionScreen(connection, intents)
                }
            }
        }
        view.confirm?.let { ConfirmOverlay(it, intents.confirm, intents.dismissConfirm) }
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
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            if (tab == "account") {
                AccountScreen(intents)
            } else {
                SystemsScreen(view, intents)
            }
        }
        RunovaBottomBar(AppTabs, if (tab == "account") "account" else "systems", onTab)
    }
}

@Composable
fun StartingScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        RunovaText("Runova", style = RunovaType.heading)
    }
}

@Composable
fun SignInScreen(error: String?, onSignIn: () -> Unit) {
    val colors = RunovaTheme.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        RunovaIcon(RunovaIcons.Systems, size = 40.dp, color = colors.primary)
        Spacer(Modifier.height(16.dp))
        RunovaText("Runova", style = RunovaType.heading)
        Spacer(Modifier.height(6.dp))
        RunovaText(
            "Your computers, terminals and deployments, wherever you are.",
            color = colors.mutedForeground,
            align = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        RunovaButton("Sign in", onClick = onSignIn, modifier = Modifier.fillMaxWidth())
        if (error != null) {
            Spacer(Modifier.height(12.dp))
            RunovaText(error, style = RunovaType.small, color = colors.destructive, align = TextAlign.Center)
        }
    }
}

private fun platformName(platform: String) = when (platform) {
    "windows" -> "Windows"
    "macos" -> "macOS"
    "linux" -> "Linux"
    else -> platform
}

@Composable
fun SystemsScreen(view: AppView, intents: AppIntents) {
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar("Systems")
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
    val enabled = system.online && system.canManage
    RunovaListRow(
        title = system.name,
        detail = platformName(system.platform),
        icon = RunovaIcons.Systems,
        onClick = if (enabled) ({ intents.connect(system.id) }) else null,
        trailing = {
            when {
                !system.online -> RunovaBadge("Offline")
                !system.canManage -> RunovaBadge("Screen only", BadgeTone.Warning)
                else -> RunovaBadge("Online", BadgeTone.Success)
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
fun ConnectionScreen(connection: ConnectionView, intents: AppIntents) {
    val colors = RunovaTheme.colors
    val failed = connection.phase == ConnectionPhase.FAILED
    val text = phaseText(connection)
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(connection.systemName, onBack = intents.disconnect)
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        ) {
            RunovaIcon(
                if (failed) RunovaIcons.Warning else RunovaIcons.Shield,
                size = 36.dp,
                color = if (failed) colors.destructive else colors.primary,
            )
            RunovaText(text.title, style = RunovaType.title, align = TextAlign.Center)
            RunovaText(text.detail, color = colors.mutedForeground, align = TextAlign.Center)
            if (failed) {
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaButton("Back", onClick = intents.disconnect, kind = ButtonKind.Soft)
                    RunovaButton("Try again", onClick = { intents.connect(connection.systemId) })
                }
            }
        }
    }
}

@Composable
fun AccountScreen(intents: AppIntents) {
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar("Account")
        Column(Modifier.padding(16.dp)) {
            RunovaButton("Sign out", onClick = intents.signOut, kind = ButtonKind.Soft, modifier = Modifier.fillMaxWidth())
        }
    }
}
