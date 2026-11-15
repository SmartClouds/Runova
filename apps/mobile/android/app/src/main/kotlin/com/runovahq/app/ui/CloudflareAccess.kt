package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
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
import androidx.compose.ui.semantics.contentDescription
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
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.CloudflareAccessView
import uniffi.runova_ffi.CloudflareEmailGateFormView
import uniffi.runova_ffi.CloudflareGateHostView
import uniffi.runova_ffi.CloudflareGateState
import uniffi.runova_ffi.CloudflareIpLimitFormView
import uniffi.runova_ffi.CloudflareIpLimitView

/** A separator typed at the end of a field finishes the entry before it, as on the desktop. */
private val FINISHED = Regex("[\\s,;]$")

/** Everything the Access tab shows, under the switches and the tab strip. */
internal fun LazyListScope.accessTab(access: CloudflareAccessView, intents: CloudflareIntents) {
    when {
        access.loading -> item(key = "access-loading") { LoadingRows() }
        access.problem != null -> item(key = "access-problem") { ErrorText(access.problem!!) }
        else -> {
            item(key = "gate") { GateCard(access, intents) }
            item(key = "limits") { LimitsCard(access, intents) }
        }
    }
}

@Composable
private fun GateCard(access: CloudflareAccessView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle("Email code")
        RunovaText(
            "Visitors type their email, Cloudflare mails them a code, and only the people you list get in.",
            style = RunovaType.small,
            color = colors.mutedForeground,
        )
        if (!access.ready) SetupCard(access, intents)
        RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 4.dp)) {
            Column { access.hosts.forEach { HostRow(it, access.ready, intents) } }
        }
    }
}

@Composable
private fun SetupCard(access: CloudflareAccessView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    var team by remember { mutableStateOf("") }
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaText("Turn on email codes for this Cloudflare account", style = RunovaType.title)
            RunovaText(
                "Codes come from Cloudflare Zero Trust, whose free plan covers small teams." +
                    if (access.needsTeam) " Pick a team name for the sign-in page people see." else "",
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            if (access.needsTeam) {
                RunovaTextField(team, { team = it.lowercase() }, "acme", label = "Team name")
                if (team.isNotBlank()) {
                    RunovaText("${team.trim()}.cloudflareaccess.com", style = RunovaType.mono.copy(fontSize = RunovaType.small.fontSize), color = colors.mutedForeground)
                }
            }
            RunovaButton(
                "Turn on email codes",
                { intents.gatePrepare(team) },
                enabled = !access.needsTeam || team.isNotBlank(),
                icon = RunovaIcons.Envelope,
            )
        }
    }
}

@Composable
private fun HostRow(host: CloudflareGateHostView, ready: Boolean, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    val on = host.state == CloudflareGateState.ON
    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaIcon(
                if (on) RunovaIcons.Lock else RunovaIcons.Unlock,
                size = 14.dp,
                color = if (on) colors.primary else colors.mutedForeground,
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                RunovaText(host.hostname, style = RunovaType.mono, maxLines = 1)
                host.roleLabel?.let { RunovaBadge(it, BadgeTone.Primary) }
                RunovaText(host.summary, style = RunovaType.small, color = colors.mutedForeground)
            }
            if (on) {
                Box(
                    Modifier
                        .clip(CircleShape)
                        .clickable(role = Role.Button) { intents.gateEdit(host.hostname) }
                        .semantics { contentDescription = "Edit email code for ${host.hostname}" }
                        .padding(8.dp),
                ) {
                    RunovaIcon(RunovaIcons.Edit, size = 14.dp, color = colors.mutedForeground)
                }
            }
            if (host.state != CloudflareGateState.ELSEWHERE) {
                RunovaToggle(
                    on,
                    { intents.gateSwitch(host.hostname, it) },
                    "Email code for ${host.hostname}",
                    enabled = ready && host.proxied,
                )
            }
        }
        if (host.canProxy || (host.core && on && !host.thisComputerPass)) {
            Wrap {
                if (host.canProxy) {
                    RunovaChip("Turn on proxy", { intents.gateProxy(host.hostname) }, icon = RunovaIcons.Cloud, tone = ChipTone.Primary)
                }
                if (host.core && on && !host.thisComputerPass) {
                    RunovaChip("Let this computer through", { intents.gateLetThrough(host.hostname) }, icon = RunovaIcons.Key, tone = ChipTone.Primary)
                }
            }
        }
    }
}

@Composable
private fun LimitsCard(access: CloudflareAccessView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle("Limit by IP address")
        RunovaText(
            "Only the addresses you list can open a name or a path. Everyone else gets Cloudflare's block page.",
            style = RunovaType.small,
            color = colors.mutedForeground,
        )
        RunovaChip("Add IP limit", { intents.openIpLimit(null) }, icon = RunovaIcons.Add, tone = ChipTone.Primary)
        when {
            access.limitsProblem != null -> ErrorText(access.limitsProblem!!)
            access.limits.isEmpty() -> RunovaText(
                "No IP limits yet. Keep an admin page to your office, or a whole name to your VPN's address.",
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            else -> RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 4.dp)) {
                Column { access.limits.forEach { LimitRow(it, intents) } }
            }
        }
    }
}

@Composable
private fun LimitRow(limit: CloudflareIpLimitView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            RunovaText(
                limit.target,
                style = RunovaType.mono,
                color = if (limit.enabled) colors.foreground else colors.mutedForeground,
                maxLines = 2,
            )
            Wrap {
                limit.ips.take(3).forEach { AddressPill(it) }
                if (limit.ips.size > 3) {
                    RunovaText("+${limit.ips.size - 3} more", style = RunovaType.caption, color = colors.mutedForeground)
                }
            }
        }
        Box(
            Modifier
                .clip(CircleShape)
                .clickable(role = Role.Button) { intents.openIpLimit(limit.id) }
                .semantics { contentDescription = "Edit IP limit for ${limit.target}" }
                .padding(8.dp),
        ) {
            RunovaIcon(RunovaIcons.Edit, size = 14.dp, color = colors.mutedForeground)
        }
        RunovaToggle(limit.enabled, { intents.ipLimitSetEnabled(limit.id, it) }, "IP limit for ${limit.target}")
        Box(
            Modifier
                .clip(CircleShape)
                .clickable(role = Role.Button) { intents.ipLimitDelete(limit.id) }
                .semantics { contentDescription = "Delete IP limit for ${limit.target}" }
                .padding(8.dp),
        ) {
            RunovaIcon(RunovaIcons.Trash, size = 14.dp, color = colors.mutedForeground)
        }
    }
}

@Composable
private fun AddressPill(address: String, onRemove: (() -> Unit)? = null) {
    val colors = RunovaTheme.colors
    Row(
        Modifier
            .clip(CircleShape)
            .background(colors.primary.copy(alpha = 0.12f))
            .padding(start = 10.dp, end = if (onRemove != null) 4.dp else 10.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        RunovaText(address, style = RunovaType.mono.copy(fontSize = RunovaType.caption.fontSize), color = colors.primary)
        onRemove?.let { RemoveButton("Remove $address", it) }
    }
}

@Composable
private fun RemoveButton(label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(20.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        RunovaIcon(RunovaIcons.Close, size = 10.dp, color = RunovaTheme.colors.primary)
    }
}

/** A field that turns typed or pasted text into chips once a separator ends an entry. */
@Composable
private fun EntryField(placeholder: String, label: String, onEntries: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.weight(1f)) {
            RunovaTextField(
                draft,
                {
                    if (FINISHED.containsMatchIn(it)) {
                        onEntries(it)
                        draft = ""
                    } else {
                        draft = it
                    }
                },
                placeholder,
                label = label,
            )
        }
        RunovaChip("Add", { if (draft.isNotBlank()) onEntries(draft); draft = "" }, icon = RunovaIcons.Add)
    }
}

@Composable
private fun Problems(lines: List<String>) {
    if (lines.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        lines.forEach { RunovaText(it, style = RunovaType.small, color = RunovaTheme.colors.destructive) }
    }
}

@Composable
private fun SayBack(text: String, tone: Color, icon: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(tone.copy(alpha = 0.10f))
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaIcon(icon, size = 14.dp, color = tone)
        RunovaText(text, style = RunovaType.small, color = RunovaTheme.colors.foreground)
    }
}

private val VISITOR_STEPS = listOf(
    RunovaIcons.Lock to "They open the name",
    RunovaIcons.Envelope to "Cloudflare mails a code",
    RunovaIcons.Key to "The code lets them in",
)

@Composable
internal fun EmailGateScreen(form: CloudflareEmailGateFormView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    FormScreen(
        if (form.existing) "Email code for ${form.hostname}" else "Ask for an email code",
        if (form.existing) "Change who can get a code and how long they stay in." else form.hostname,
        intents.gateClose,
    ) {
        if (!form.existing) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VISITOR_STEPS.forEach { (icon, text) ->
                    Column(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(14.dp))
                            .background(colors.foreground.copy(alpha = 0.04f))
                            .padding(10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        RunovaIcon(icon, size = 14.dp, color = colors.primary)
                        RunovaText(text, style = RunovaType.caption, color = colors.foreground, align = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                }
            }
        }
        Field(
            "Who can get a code",
            (if (form.fromLast) "Filled in from the last list you used. " else "") +
                "Add each one with Add or a comma. A domain like @company.com lets in everyone there.",
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (form.people.isNotEmpty()) {
                    Wrap {
                        form.people.forEach { person ->
                            val shown = if (person.domain) "@${person.value}" else person.value
                            AddressPill(shown) { intents.gateRemovePerson(person.value, person.domain) }
                        }
                    }
                }
                EntryField("ana@company.com, or @company.com", "Who can get a code", intents.gateAddPeople)
                Problems(form.invalid)
            }
        }
        Field("Stay in for") {
            ChoiceChips(form.sessions.map { it.value to it.label }, form.session) { intents.gateSetSession(it) }
        }
        SayBack(form.preview, if (form.people.isEmpty()) colors.mutedForeground else colors.primary, RunovaIcons.Lock)
        form.coreNote?.let { SayBack(it, colors.mutedForeground, RunovaIcons.Systems) }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            when {
                form.saving -> "Saving"
                form.existing -> "Save"
                else -> "Turn on email code"
            },
            intents.gateSave,
            Modifier.fillMaxWidth(),
            enabled = form.people.isNotEmpty() && !form.saving,
            icon = RunovaIcons.Lock,
        )
        if (form.existing) {
            RunovaButton("Turn off", { intents.gateTurnOff(form.hostname) }, Modifier.fillMaxWidth(), kind = ButtonKind.Danger, icon = RunovaIcons.Unlock)
        }
    }
}

@Composable
internal fun IpLimitScreen(form: CloudflareIpLimitFormView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    var path by remember(form.ruleId) { mutableStateOf(form.path) }
    FormScreen(
        if (form.ruleId != null) "Change the IP limit" else "Limit by IP address",
        "Everyone not listed gets Cloudflare's block page.",
        intents.closeIpLimit,
    ) {
        Field("Name", "Only names behind Cloudflare's proxy are listed. The others go straight to your server.") {
            ChoiceChips(form.names.map { it.value to it.label }, form.hostname) { intents.ipLimitSetName(it) }
        }
        Field("Covers", if (form.wholeSite) "Let's Encrypt's certificate checks still get through." else null) {
            ChoiceChips(listOf(true to "Every page", false to "One path"), form.wholeSite) { intents.ipLimitSetScope(it) }
        }
        if (!form.wholeSite) {
            Field("Path") {
                RunovaTextField(path, { path = it; intents.ipLimitSetPath(it) }, "/admin", label = "Path")
            }
            form.pathProblem?.let { ErrorText(it) }
            Field("Match") {
                ChoiceChips(listOf(true to "Path and below", false to "Only this path"), form.prefix) { intents.ipLimitSetPrefix(it) }
            }
        }
        Field("Addresses that get in", "A range like 198.51.100.0/24 covers a whole office or VPN.") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (form.ips.isNotEmpty()) {
                    Wrap { form.ips.forEach { ip -> AddressPill(ip) { intents.ipLimitRemoveAddress(ip) } } }
                }
                EntryField("203.0.113.10 or 198.51.100.0/24", "Addresses that get in", intents.ipLimitAddAddresses)
                Problems(form.invalid)
                if (form.canAddThisComputer) {
                    form.thisComputer?.let { ip ->
                        RunovaChip(
                            "This computer, $ip",
                            intents.ipLimitAddThisComputer,
                            Modifier.semantics { contentDescription = "Add this computer, $ip" },
                            icon = RunovaIcons.Add,
                        )
                    }
                }
            }
        }
        SayBack(form.preview, if (form.canSave) colors.primary else colors.mutedForeground, RunovaIcons.Shield)
        if (form.shutOut) {
            SayBack(
                "This computer (${form.thisComputer}) is not on the list, so it gets the block page too.",
                colors.warning,
                RunovaIcons.Warning,
            )
        }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            when {
                form.saving -> "Saving"
                form.ruleId != null -> "Save"
                else -> "Add limit"
            },
            intents.ipLimitSave,
            Modifier.fillMaxWidth(),
            enabled = form.canSave,
            icon = RunovaIcons.Shield,
        )
    }
}
