package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.CloudflareChoiceView
import uniffi.runova_ffi.CloudflareOriginDialogKind
import uniffi.runova_ffi.CloudflareOriginDialogView
import uniffi.runova_ffi.CloudflareOriginLockView
import uniffi.runova_ffi.CloudflareOriginMode
import uniffi.runova_ffi.CloudflareOriginView
import uniffi.runova_ffi.CloudflarePendingChangeView
import uniffi.runova_ffi.CloudflareStepState
import uniffi.runova_ffi.CloudflareTone
import uniffi.runova_ffi.CloudflareTunnelView

private val BREAK_GLASS_MINUTES = listOf(15u, 30u, 60u, 120u, 240u)

private fun minutesLabel(minutes: UInt) = if (minutes < 60u) "$minutes min" else "${minutes / 60u} h"

@Composable
private fun toneColor(tone: CloudflareTone): Color {
    val colors = RunovaTheme.colors
    return when (tone) {
        CloudflareTone.GOOD -> colors.primary
        CloudflareTone.WARNING -> colors.warning
        CloudflareTone.BAD -> colors.destructive
    }
}

/** The saved servers on the Cloudflare home, each opening its Cloudflare-only origin. */
@Composable
internal fun ServersCard(servers: List<CloudflareChoiceView>, intents: CloudflareIntents) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle("Your servers")
        RunovaText(
            "How Cloudflare reaches each one: through a tunnel, or from Cloudflare's addresses only.",
            style = RunovaType.small,
            color = RunovaTheme.colors.mutedForeground,
        )
        RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
            Column {
                servers.forEach { server ->
                    com.runovahq.app.design.RunovaListRow(
                        title = server.name,
                        detail = "Cloudflare-only origin",
                        icon = RunovaIcons.Server,
                        onClick = { intents.openOrigin(server.id) },
                        flat = true,
                    )
                }
            }
        }
    }
}

@Composable
internal fun OriginScreen(origin: CloudflareOriginView, error: String?, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    RunovaScreen("Cloudflare-only origin", subtitle = origin.serverName, onBack = intents.closeOrigin) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "intro") {
                RunovaText(
                    "Stops visitors from going around Cloudflare to the server's own address.",
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                )
            }
            when {
                origin.loading -> item(key = "loading") { LoadingRows() }
                origin.problem != null -> item(key = "problem") { ErrorText(origin.problem!!) }
                else -> {
                    origin.pending?.let { pending -> item(key = "pending") { PendingCard(pending, intents) } }
                    item(key = "mode") { ModeCard(origin, intents) }
                    if (origin.mode == CloudflareOriginMode.TUNNEL) {
                        item(key = "tunnel") {
                            origin.tunnel?.let { TunnelCard(it, origin, intents) }
                                ?: origin.tunnelProblem?.let { ErrorText(it) }
                        }
                    } else {
                        item(key = "lock") {
                            origin.lock?.let { LockCard(it, origin, intents) }
                                ?: origin.lockProblem?.let { ErrorText(it) }
                        }
                    }
                }
            }
        }
        error?.let { ErrorText(it, Modifier.padding(16.dp)) }
    }
}

@Composable
private fun PendingCard(pending: CloudflarePendingChangeView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.warning.copy(alpha = 0.10f))
            .border(1.dp, colors.warning.copy(alpha = 0.35f), RoundedCornerShape(16.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            RunovaIcon(RunovaIcons.Clock, size = 14.dp, color = colors.warning)
            RunovaText("A firewall change waits for you", style = RunovaType.title)
        }
        RunovaText(pending.summary, style = RunovaType.small)
        RunovaText(pending.deadlineLabel, style = RunovaType.small, color = colors.warning)
        Commands(pending.commands)
        Wrap {
            RunovaButton("Keep it", intents.firewallKeep, icon = RunovaIcons.Check)
            RunovaButton("Revert", intents.firewallRevert, kind = ButtonKind.Danger, icon = RunovaIcons.Undo)
        }
        RunovaText(
            "Keeping it checks that the computer still gets in over a new connection.",
            style = RunovaType.caption,
            color = colors.mutedForeground,
        )
    }
}

@Composable
private fun ModeCard(origin: CloudflareOriginView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RunovaText("How Cloudflare reaches this server", style = RunovaType.label)
        ChoiceChips(
            listOf(CloudflareOriginMode.TUNNEL to "Cloudflare Tunnel", CloudflareOriginMode.IPS to "Cloudflare IPs only"),
            origin.mode,
            enabled = !origin.modeLocked,
        ) { intents.originMode(it) }
        RunovaText(
            if (origin.mode == CloudflareOriginMode.TUNNEL) {
                "No open web ports: the server dials out to Cloudflare."
            } else {
                "Ports 80 and 443 answer Cloudflare's addresses only."
            },
            style = RunovaType.small,
            color = colors.mutedForeground,
        )
        origin.modeNote?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
    }
}

@Composable
private fun StateLine(label: String, tone: CloudflareTone, working: Boolean = false) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(toneColor(tone)))
        RunovaText(label, Modifier.weight(1f), RunovaType.labelStrong)
        if (working) RunovaBadge("Working", BadgeTone.Warning)
    }
}

@Composable
private fun Lines(lines: List<String>, color: Color) {
    lines.forEach { RunovaText(it, style = RunovaType.small, color = color) }
}

@Composable
private fun LockCard(lock: CloudflareOriginLockView, origin: CloudflareOriginView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            StateLine(lock.stateLabel, lock.tone)
            Lines(lock.details, colors.mutedForeground)
            Lines(lock.drift, colors.destructive)
            Lines(lock.warnings, colors.warning)
            if (origin.canAdmin && origin.pending == null) {
                Wrap {
                    lock.enableLabel?.let { label ->
                        RunovaButton(label, { intents.lockOpen(true) }, icon = RunovaIcons.Shield)
                    }
                    if (lock.enabled) {
                        RunovaButton("Turn off", { intents.lockOpen(false) }, kind = ButtonKind.Danger)
                    }
                }
            }
        }
    }
}

@Composable
private fun TunnelCard(tunnel: CloudflareTunnelView, origin: CloudflareOriginView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            StateLine(tunnel.stateLabel, tunnel.tone, tunnel.working)
            tunnel.intro?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
            tunnel.facts.forEach { fact ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaText(fact.label, Modifier.weight(1f), RunovaType.small, colors.mutedForeground)
                    RunovaText(fact.value, style = RunovaType.small)
                }
            }
            Lines(tunnel.drift, colors.destructive)
            tunnel.lastError?.let { ErrorText(it) }
            Lines(tunnel.warnings, colors.warning)
            tunnel.hint?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
            if (tunnel.enabled && tunnel.facts.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            RunovaText("Reopen SSH if the tunnel stays down", style = RunovaType.label)
                            RunovaText(tunnel.breakGlassText, style = RunovaType.small, color = colors.mutedForeground)
                        }
                        RunovaToggle(
                            tunnel.breakGlass,
                            { intents.tunnelBreakGlass(it, tunnel.breakGlassMinutes) },
                            "Reopen SSH if the tunnel stays down",
                            enabled = origin.canOwn,
                        )
                    }
                    if (tunnel.breakGlass) {
                        ChoiceChips(
                            BREAK_GLASS_MINUTES.map { it to minutesLabel(it) },
                            tunnel.breakGlassMinutes,
                            enabled = origin.canOwn,
                        ) { intents.tunnelBreakGlass(true, it) }
                    }
                }
            }
            if (origin.canAdmin) {
                Wrap {
                    tunnel.setUpLabel?.let { RunovaButton(it, intents.tunnelSetupOpen, icon = RunovaIcons.Cloud) }
                    if (tunnel.canClosePorts) RunovaButton("Close ports 80 and 443", intents.tunnelPortsOpen, icon = RunovaIcons.Lock)
                    if (tunnel.canChangeSsh) RunovaButton("Change SSH access", intents.tunnelSshOpen, kind = ButtonKind.Soft, icon = RunovaIcons.Key)
                    if (tunnel.canTurnOff) RunovaButton("Turn off", intents.tunnelOffOpen, kind = ButtonKind.Danger)
                }
            }
        }
    }
}

@Composable
private fun Commands(commands: List<String>) {
    if (commands.isEmpty()) return
    val colors = RunovaTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.foreground.copy(alpha = 0.05f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        commands.forEach { RunovaText(it, style = RunovaType.mono.copy(fontSize = RunovaType.caption.fontSize)) }
    }
}

@Composable
internal fun OriginDialogScreen(d: CloudflareOriginDialogView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    var phrase by remember(d.kind) { mutableStateOf("") }
    var password by remember(d.kind) { mutableStateOf("") }
    var sshName by remember(d.kind, d.loading) { mutableStateOf(d.sshName) }
    FormScreen(d.title, null, intents.closeOriginDialog) {
        RunovaText(d.description, style = RunovaType.small, color = colors.mutedForeground)
        if (d.loading && d.steps.isEmpty()) LoadingRows()
        d.blocked?.let { ErrorText(it) }
        when (d.kind) {
            CloudflareOriginDialogKind.LOCK_ON -> SwitchRow(
                "Authenticated Origin Pulls",
                "Also require Cloudflare's client certificate on HTTPS. It is turned on for the zones of this server's sites first.",
                RunovaIcons.Shield,
                d.aop,
                !d.loading,
            ) { intents.lockSetAop(it) }
            CloudflareOriginDialogKind.SETUP -> if (!d.loading) {
                if (d.accounts.size > 1) {
                    Field("Cloudflare account") {
                        ChoiceChips(d.accounts.map { it.id to it.name }, d.account) { intents.tunnelSetupAccount(it) }
                    }
                }
            }
            CloudflareOriginDialogKind.OFF -> {
                Field(
                    "Ports 80 and 443 afterwards",
                    if (d.reopenWeb) "Anyone can reach the sites at the server address again." else "Turn the IP lock on next, or the sites stop answering until you do.",
                ) {
                    ChoiceChips(listOf(true to "Open to everyone", false to "Keep closed for the IP lock"), d.reopenWeb) { intents.tunnelOffReopen(it) }
                }
                SwitchRow(
                    "Point the names back at the server",
                    "Proxied through Cloudflare, once the tunnel is gone.",
                    RunovaIcons.Globe,
                    d.pointBack,
                    true,
                ) { intents.tunnelOffPointBack(it) }
            }
            CloudflareOriginDialogKind.SSH -> {
                d.sshModes.forEach { mode ->
                    ModeRow(mode.title, mode.line, mode.risk, mode.value == d.sshMode, mode.available, mode.now) {
                        if (mode.available) intents.tunnelSshMode(mode.value)
                    }
                }
                if (d.sshMode == "mesh") {
                    d.meshAddress?.let { RunovaText("Mesh address: $it", style = RunovaType.mono) }
                    if (d.canJoinMesh) RunovaButton("Add to Mesh", intents.tunnelJoinMesh, kind = ButtonKind.Soft, enabled = !d.saving, icon = RunovaIcons.Network)
                }
                d.testLabel?.let { label ->
                    RunovaButton(label, intents.tunnelSshTest, Modifier.fillMaxWidth(), kind = ButtonKind.Soft, enabled = d.canTest, icon = RunovaIcons.Play)
                }
                d.probe?.let { RunovaText(it, style = RunovaType.small, color = if (d.probeOk) colors.primary else colors.warning) }
            }
            else -> {}
        }
        if (d.rows.isNotEmpty()) {
            d.rowsTitle?.let { RunovaText(it, style = RunovaType.label) }
            RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)) {
                Column {
                    d.rows.forEach { row ->
                        Column(Modifier.padding(vertical = 6.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                RunovaText(row.label, style = RunovaType.mono, maxLines = 1)
                                row.chip?.let { RunovaBadge(it, BadgeTone.Primary) }
                            }
                            RunovaText(row.text, style = RunovaType.small, color = if (row.ok) colors.mutedForeground else colors.warning)
                        }
                    }
                }
            }
        }
        d.rowsWarning?.let { warning ->
            if (d.kind == CloudflareOriginDialogKind.SETUP) {
                SwitchRow("Go ahead without them", warning, RunovaIcons.Warning, d.acked, true) { intents.tunnelSetupAck(it) }
            } else {
                RunovaText(warning, style = RunovaType.small, color = colors.warning)
            }
        }
        if (d.kind == CloudflareOriginDialogKind.SETUP && !d.loading) {
            SwitchRow(
                "Give SSH a name on the tunnel, behind Cloudflare Access",
                "Needed to close SSH's own port later and still get in from the app. Nothing about SSH changes now.",
                RunovaIcons.Key,
                d.routeSsh,
                true,
            ) { intents.tunnelSetupSsh(it, sshName) }
            if (d.routeSsh) {
                Field("SSH name") {
                    RunovaTextField(sshName, { sshName = it; intents.tunnelSetupSsh(true, it) }, "ssh.example.com", label = "SSH name")
                }
                d.sshNameProblem?.let { ErrorText(it) }
            }
        }
        d.firewallTitle?.let { RunovaText(it, style = RunovaType.label) }
        Commands(d.commands)
        d.notes.forEach { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
        if (d.steps.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                d.steps.forEachIndexed { index, step ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                        val (icon, tone) = when (step.state) {
                            CloudflareStepState.DONE -> RunovaIcons.Success to colors.primary
                            CloudflareStepState.FAILED -> RunovaIcons.Error to colors.destructive
                            CloudflareStepState.RUNNING -> RunovaIcons.Clock to colors.warning
                            CloudflareStepState.WAITING -> RunovaIcons.Minus to colors.mutedForeground
                        }
                        RunovaIcon(icon, size = 14.dp, color = tone)
                        Column(Modifier.weight(1f)) {
                            RunovaText("${index + 1}. ${step.label}", style = RunovaType.small)
                            step.detail?.let { RunovaText(it, style = RunovaType.caption, color = colors.mutedForeground) }
                        }
                    }
                }
            }
        }
        d.phrase?.let { expected ->
            RunovaText("No SSH connection will reach this server. Type the phrase to go ahead.", style = RunovaType.small, color = colors.destructive)
            Field("Type $expected") { RunovaTextField(phrase, { phrase = it }, expected, label = "Confirmation phrase") }
            Field("Your password on the server core") {
                RunovaTextField(password, { password = it }, "Password", secure = true, icon = RunovaIcons.Key, label = "Password on the server core")
            }
        }
        d.problem?.let { ErrorText(it) }
        RunovaButton(
            if (d.saving) "Working" else d.applyLabel,
            {
                if (d.kind == CloudflareOriginDialogKind.SSH) intents.tunnelSshApply(phrase, password) else intents.originApply()
            },
            Modifier.fillMaxWidth(),
            kind = if (d.danger) ButtonKind.Danger else ButtonKind.Primary,
            enabled = d.canApply && !d.saving && (d.phrase == null || (phrase.isNotBlank() && password.isNotEmpty())),
            icon = RunovaIcons.Check,
        )
    }
}

@Composable
private fun ModeRow(title: String, line: String, risk: String, chosen: Boolean, available: Boolean, now: Boolean, onClick: () -> Unit) {
    val colors = RunovaTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (chosen) colors.primary.copy(alpha = 0.10f) else colors.foreground.copy(alpha = 0.04f))
            .clickable(enabled = available, role = Role.RadioButton, onClick = onClick)
            .semantics { selected = chosen }
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            RunovaText(title, Modifier.weight(1f), RunovaType.label, if (available) colors.foreground else colors.mutedForeground)
            if (now) RunovaBadge("Now", BadgeTone.Neutral)
        }
        RunovaText(line, style = RunovaType.small, color = colors.mutedForeground)
        RunovaText(risk, style = RunovaType.caption, color = if (available) colors.warning else colors.mutedForeground)
    }
}
