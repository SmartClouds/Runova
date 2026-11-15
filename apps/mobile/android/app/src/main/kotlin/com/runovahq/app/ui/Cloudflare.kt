package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
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
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaSkeleton
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.CloudflareAccountView
import uniffi.runova_ffi.CloudflareAddDomainView
import uniffi.runova_ffi.CloudflarePointDomainView
import uniffi.runova_ffi.CloudflareRecordFormView
import uniffi.runova_ffi.CloudflareRecordView
import uniffi.runova_ffi.CloudflareRevealedSecretView
import uniffi.runova_ffi.CloudflareTab
import uniffi.runova_ffi.CloudflareTogglesView
import uniffi.runova_ffi.CloudflareTokenFormView
import uniffi.runova_ffi.CloudflareTone
import uniffi.runova_ffi.CloudflareZoneView
import uniffi.runova_ffi.RecordDraft
import uniffi.runova_ffi.WidgetDraft

/** Cloudflare's own page for API tokens, where the user makes one for Runova. */
private const val TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens"

private val RECORD_TYPES = listOf("A", "AAAA", "CNAME", "TXT", "MX", "CAA", "SRV")
private val PROXIABLE = setOf("A", "AAAA", "CNAME")
private val CAA_TAGS = listOf("issue" to "Issue", "issuewild" to "Issue wildcard", "iodef" to "Report to")

/** The TTLs the desktop's editor offers, in seconds. 1 is Cloudflare's "Auto". */
private val TTLS = listOf(
    1u to "Auto", 60u to "1 min", 300u to "5 min", 1800u to "30 min",
    3600u to "1 hr", 18000u to "5 hr", 43200u to "12 hr", 86400u to "1 day",
)

data class CloudflareIntents(
    val openZone: (String) -> Unit = {},
    val closeZone: () -> Unit = {},
    val setDevMode: (Boolean) -> Unit = {},
    val setUnderAttack: (Boolean) -> Unit = {},
    val setAiBotsBlocked: (Boolean) -> Unit = {},
    val newRecord: () -> Unit = {},
    val editRecord: (String) -> Unit = {},
    val closeRecordForm: () -> Unit = {},
    val saveRecord: (RecordDraft) -> Unit = {},
    val setProxied: (String, Boolean) -> Unit = { _, _ -> },
    val deleteRecord: (String) -> Unit = {},
    val openTokenForm: (String?) -> Unit = {},
    val closeTokenForm: () -> Unit = {},
    val saveToken: (String, String) -> Unit = { _, _ -> },
    val checkToken: (String) -> Unit = {},
    val removeToken: (String) -> Unit = {},
    val openAddDomain: (String) -> Unit = {},
    val closeAddDomain: () -> Unit = {},
    val addDomain: (String, String) -> Unit = { _, _ -> },
    val checkActivation: () -> Unit = {},
    val openPointDomain: () -> Unit = {},
    val closePointDomain: () -> Unit = {},
    val previewPointDomain: (String, String, Boolean, Boolean) -> Unit = { _, _, _, _ -> },
    val applyPointDomain: () -> Unit = {},
    val openTab: (CloudflareTab) -> Unit = {},
    val changeSetting: (String, String) -> Unit = { _, _ -> },
    val setRuleEnabled: (String, Boolean) -> Unit = { _, _ -> },
    val deleteRule: (String) -> Unit = {},
    val openRuleBuilder: () -> Unit = {},
    val closeRuleBuilder: () -> Unit = {},
    val addRule: (String, String, String, Boolean, String) -> Unit = { _, _, _, _, _ -> },
    val openAccessRuleForm: () -> Unit = {},
    val closeAccessRuleForm: () -> Unit = {},
    val addAccessRule: (String, String, String) -> Unit = { _, _, _ -> },
    val deleteAccessRule: (String) -> Unit = {},
    val purgeEverything: () -> Unit = {},
    val purgeUrls: (String) -> Unit = {},
    val gatePrepare: (String) -> Unit = {},
    val gateSwitch: (String, Boolean) -> Unit = { _, _ -> },
    val gateEdit: (String) -> Unit = {},
    val gateClose: () -> Unit = {},
    val gateAddPeople: (String) -> Unit = {},
    val gateRemovePerson: (String, Boolean) -> Unit = { _, _ -> },
    val gateSetSession: (String) -> Unit = {},
    val gateSave: () -> Unit = {},
    val gateTurnOff: (String) -> Unit = {},
    val gateProxy: (String) -> Unit = {},
    val gateLetThrough: (String) -> Unit = {},
    val openIpLimit: (String?) -> Unit = {},
    val closeIpLimit: () -> Unit = {},
    val ipLimitSetName: (String) -> Unit = {},
    val ipLimitSetScope: (Boolean) -> Unit = {},
    val ipLimitSetPath: (String) -> Unit = {},
    val ipLimitSetPrefix: (Boolean) -> Unit = {},
    val ipLimitAddAddresses: (String) -> Unit = {},
    val ipLimitRemoveAddress: (String) -> Unit = {},
    val ipLimitAddThisComputer: () -> Unit = {},
    val ipLimitSave: () -> Unit = {},
    val ipLimitSetEnabled: (String, Boolean) -> Unit = { _, _ -> },
    val ipLimitDelete: (String) -> Unit = {},
    val newWidget: () -> Unit = {},
    val editWidget: (String) -> Unit = {},
    val closeWidgetForm: () -> Unit = {},
    val saveWidget: (WidgetDraft) -> Unit = {},
    val deleteWidget: (String) -> Unit = {},
    val revealSecret: (String) -> Unit = {},
    val hideSecret: () -> Unit = {},
    val rotateSecret: (String, Boolean) -> Unit = { _, _ -> },
    val dnsTokenMint: (String) -> Unit = {},
    val dnsTokenPaste: (String, String) -> Unit = { _, _ -> },
    val dnsTokenRemove: (String) -> Unit = {},
)

internal fun CloudflareTone.badge() = when (this) {
    CloudflareTone.GOOD -> BadgeTone.Success
    CloudflareTone.WARNING -> BadgeTone.Warning
    CloudflareTone.BAD -> BadgeTone.Danger
}

/** A form, a domain or the token page takes over the whole device screen. */
@Composable
fun CloudflareOverlay(view: AppView, intents: CloudflareIntents): Boolean {
    val screen = view.cloudflare
    screen.tokenForm?.let { TokenScreen(it, view.error, intents); return true }
    screen.addDomain?.let { AddDomainScreen(it, intents); return true }
    val zone = screen.zone ?: return false
    screen.recordForm?.let { RecordScreen(it, intents); return true }
    screen.pointDomain?.let { PointDomainScreen(it, intents); return true }
    screen.ruleBuilder?.let { RuleBuilderScreen(it, intents); return true }
    screen.accessRuleForm?.let { AccessRuleScreen(it, intents); return true }
    screen.emailGateForm?.let { EmailGateScreen(it, intents); return true }
    screen.ipLimitForm?.let { IpLimitScreen(it, intents); return true }
    screen.widgetForm?.let { WidgetScreen(it, intents); return true }
    ZoneScreen(zone, screen.revealedSecret, view.error, intents)
    return true
}

@Composable
fun CloudflareTab(view: AppView, intents: CloudflareIntents) {
    val screen = view.cloudflare
    when {
        screen.problem != null -> RunovaEmptyState(RunovaIcons.Warning, "Can't open Cloudflare", screen.problem!!, tone = BadgeTone.Warning)
        screen.loading && screen.accounts.isEmpty() -> LoadingRows()
        !screen.configured -> Column(
            Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            RunovaEmptyState(
                RunovaIcons.Cloud,
                "Connect Cloudflare",
                "Manage domains, DNS and security from here. The token is saved on the computer, not on this phone.",
            )
            RunovaButton("Connect an account", { intents.openTokenForm(null) }, icon = RunovaIcons.Add)
        }
        else -> LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(screen.accounts, key = { it.id }) { AccountCard(it, intents) }
            item(key = "connect") {
                RunovaButton(
                    "Connect another account",
                    { intents.openTokenForm(null) },
                    Modifier.fillMaxWidth(),
                    kind = ButtonKind.Soft,
                    icon = RunovaIcons.Add,
                )
            }
        }
    }
}

@Composable
private fun AccountCard(account: CloudflareAccountView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(0.dp)) {
        Column {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RunovaIconTile(RunovaIcons.Cloud, account.tone.badge())
                    RunovaText(account.label, Modifier.weight(1f), RunovaType.title, maxLines = 1)
                    RunovaBadge(account.statusLabel, account.tone.badge(), dot = true)
                }
                account.detail?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
                account.missing.forEach { permission ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        RunovaIcon(RunovaIcons.Key, size = 12.dp, color = colors.warning)
                        RunovaText(permission, style = RunovaType.mono.copy(fontSize = RunovaType.small.fontSize), color = colors.foreground)
                    }
                }
                Wrap {
                    if (!account.locked) {
                        RunovaChip("Check token", { intents.checkToken(account.id) }, icon = RunovaIcons.Refresh)
                    }
                    RunovaChip("Replace token", { intents.openTokenForm(account.id) }, icon = RunovaIcons.Key)
                    RunovaChip("Remove", { intents.removeToken(account.id) }, icon = RunovaIcons.Trash, tone = ChipTone.Danger)
                }
            }
            when {
                account.zonesLoading -> Column(Modifier.padding(16.dp)) { RunovaSkeleton(Modifier.fillMaxWidth()) }
                account.zonesProblem != null -> RunovaText(
                    account.zonesProblem!!,
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    RunovaType.small,
                    colors.destructive,
                )
                else -> Column(Modifier.padding(horizontal = 8.dp)) {
                    account.zones.forEach { zone ->
                        RunovaListRow(
                            title = zone.name,
                            detail = "${zone.statusLabel} · ${zone.plan}",
                            icon = RunovaIcons.Globe,
                            iconTone = if (zone.active) BadgeTone.Primary else BadgeTone.Warning,
                            onClick = { intents.openZone(zone.id) },
                            flat = true,
                        )
                    }
                }
            }
            if (!account.locked) {
                Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp, top = 4.dp)) {
                    RunovaChip("Add a domain", { intents.openAddDomain(account.id) }, icon = RunovaIcons.Add, tone = ChipTone.Primary)
                }
            }
        }
    }
}

@Composable
private fun ZoneScreen(
    zone: CloudflareZoneView,
    revealed: CloudflareRevealedSecretView?,
    error: String?,
    intents: CloudflareIntents,
) {
    RunovaScreen(zone.name, subtitle = "${zone.statusLabel} · ${zone.plan}", onBack = intents.closeZone) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (zone.pending) {
                item(key = "pending") { PendingCard(zone, intents) }
            }
            zone.toggles?.let { toggles -> item(key = "toggles") { TogglesCard(toggles, intents) } }
            item(key = "tabs") { ZoneTabs(zone.tab, intents.openTab) }
            if (zone.tab != CloudflareTab.DNS) {
                zoneTab(zone, revealed, intents)
                return@LazyColumn
            }
            item(key = "dns-title") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RunovaSectionTitle("DNS records", Modifier.weight(1f))
                }
            }
            item(key = "dns-actions") {
                Wrap {
                    RunovaChip("Add record", intents.newRecord, icon = RunovaIcons.Add, tone = ChipTone.Primary)
                    RunovaChip("Point to a server", intents.openPointDomain, icon = RunovaIcons.Server)
                }
            }
            when {
                zone.dns.loading -> item(key = "dns-loading") { LoadingRows() }
                zone.dns.problem != null -> item(key = "dns-problem") { ErrorText(zone.dns.problem!!) }
                zone.dns.records.isEmpty() -> item(key = "dns-empty") {
                    RunovaText("No records yet.", style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
                }
                else -> item(key = "records") {
                    RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 4.dp)) {
                        Column { zone.dns.records.forEach { RecordRow(it, intents) } }
                    }
                }
            }
        }
        error?.let { ErrorText(it, Modifier.padding(16.dp)) }
    }
}

@Composable
private fun PendingCard(zone: CloudflareZoneView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                RunovaIcon(RunovaIcons.Clock, color = colors.warning)
                RunovaText("Waiting for name servers", style = RunovaType.title)
            }
            RunovaText(
                "At your registrar, replace the name servers with these. It can take a few hours to switch over.",
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            zone.nameServers.forEach { RunovaText(it, style = RunovaType.mono) }
            RunovaButton("Check again", intents.checkActivation, kind = ButtonKind.Soft, icon = RunovaIcons.Refresh)
        }
    }
}

@Composable
private fun TogglesCard(toggles: CloudflareTogglesView, intents: CloudflareIntents) {
    RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)) {
        Column {
            SwitchRow("Development mode", toggles.devModeDetail, RunovaIcons.Bolt, toggles.devMode, toggles.devModeEditable && !toggles.saving, intents.setDevMode)
            SwitchRow(
                "I'm Under Attack",
                if (toggles.underAttack) "On, visitors are checked" else "Off",
                RunovaIcons.Shield,
                toggles.underAttack,
                toggles.underAttackEditable && !toggles.saving,
                intents.setUnderAttack,
            )
            if (toggles.aiBotsAvailable) {
                SwitchRow("Block AI bots", toggles.aiBotsDetail, RunovaIcons.Ban, toggles.aiBotsBlocked, !toggles.saving, intents.setAiBotsBlocked)
            }
        }
    }
}

@Composable
internal fun SwitchRow(title: String, detail: String, icon: String, on: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RunovaIcon(icon, color = if (on) colors.primary else colors.mutedForeground)
        Column(Modifier.weight(1f)) {
            RunovaText(title, style = RunovaType.label)
            RunovaText(detail, style = RunovaType.small, color = colors.mutedForeground)
        }
        RunovaToggle(on, onChange, title, enabled = enabled)
    }
}

@Composable
private fun RecordRow(record: CloudflareRecordView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = record.editable, role = Role.Button) { intents.editRecord(record.id) }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaText(
            record.recordType,
            Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(colors.foreground.copy(alpha = 0.06f))
                .padding(horizontal = 6.dp, vertical = 2.dp),
            RunovaType.caption,
            colors.mutedForeground,
        )
        Column(Modifier.weight(1f)) {
            RunovaText(record.name, style = RunovaType.labelStrong, maxLines = 1)
            val priority = record.priority?.let { "$it  " }.orEmpty()
            RunovaText(priority + record.content, style = RunovaType.mono.copy(fontSize = RunovaType.small.fontSize), color = colors.mutedForeground, maxLines = 1)
        }
        if (record.proxiable) {
            ProxyPill(record, intents)
        } else {
            RunovaText(record.ttlLabel, style = RunovaType.caption, color = colors.mutedForeground)
        }
    }
}

/** Cloudflare's orange cloud: through the proxy, or straight to the server. */
@Composable
private fun ProxyPill(record: CloudflareRecordView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    val ink = if (record.proxied) colors.warning else colors.mutedForeground
    Row(
        Modifier
            .clip(CircleShape)
            .background(if (record.proxied) colors.warning.copy(alpha = 0.14f) else colors.foreground.copy(alpha = 0.06f))
            .clickable(enabled = record.editable, role = Role.Switch) { intents.setProxied(record.id, !record.proxied) }
            .semantics { contentDescription = "Proxy for ${record.name} ${record.recordType}" }
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        RunovaIcon(RunovaIcons.Cloud, size = 12.dp, color = ink)
        RunovaText(if (record.proxied) "Proxied" else "DNS only", style = RunovaType.caption, color = ink)
    }
}

@Composable
internal fun FormScreen(title: String, subtitle: String?, onBack: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    RunovaScreen(title, subtitle = subtitle, onBack = onBack) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
    }
}

@Composable
internal fun Field(label: String, hint: String? = null, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaText(label, style = RunovaType.label)
        content()
        hint?.let { RunovaText(it, style = RunovaType.small, color = RunovaTheme.colors.mutedForeground) }
    }
}

/** Chips that wrap onto more lines rather than run off the edge. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Wrap(content: @Composable () -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        content()
    }
}

@Composable
internal fun <T> ChoiceChips(options: List<Pair<T, String>>, selected: T, enabled: Boolean = true, onSelect: (T) -> Unit) {
    Wrap {
        options.forEach { (value, label) ->
            RunovaChip(
                label,
                { if (enabled) onSelect(value) },
                Modifier.semantics { if (value == selected) contentDescription = "$label, chosen" },
                icon = if (value == selected) RunovaIcons.Check else null,
                tone = if (value == selected) ChipTone.Primary else ChipTone.Soft,
            )
        }
    }
}

@Composable
internal fun ErrorText(message: String, modifier: Modifier = Modifier) {
    RunovaText(message, modifier, RunovaType.small, RunovaTheme.colors.destructive)
}

private fun String.digits() = filter { it.isDigit() }.take(5)

@Composable
private fun RecordScreen(form: CloudflareRecordFormView, intents: CloudflareIntents) {
    val start = form.draft
    var type by remember(form.recordId) { mutableStateOf(start.recordType) }
    var name by remember(form.recordId) { mutableStateOf(start.name) }
    var content by remember(form.recordId) { mutableStateOf(start.content) }
    var ttl by remember(form.recordId) { mutableStateOf(start.ttl) }
    var proxied by remember(form.recordId) { mutableStateOf(start.proxied) }
    var priority by remember(form.recordId) { mutableStateOf(start.priority.toString()) }
    var comment by remember(form.recordId) { mutableStateOf(start.comment) }
    var caaFlags by remember(form.recordId) { mutableStateOf(start.caaFlags.toString()) }
    var caaTag by remember(form.recordId) { mutableStateOf(start.caaTag) }
    var caaValue by remember(form.recordId) { mutableStateOf(start.caaValue) }
    var srvPriority by remember(form.recordId) { mutableStateOf(start.srvPriority.toString()) }
    var srvWeight by remember(form.recordId) { mutableStateOf(start.srvWeight.toString()) }
    var srvPort by remember(form.recordId) { mutableStateOf(start.srvPort.toString()) }
    var srvTarget by remember(form.recordId) { mutableStateOf(start.srvTarget) }
    val proxiable = type in PROXIABLE
    FormScreen(form.title, form.zoneName, intents.closeRecordForm) {
        if (form.recordId == null) {
            Field("Type") { ChoiceChips(RECORD_TYPES.map { it to it }, type) { type = it } }
        }
        Field("Name", "Use @ for ${form.zoneName} itself, or a name like www.") {
            RunovaTextField(name, { name = it }, "@ or www", label = "Name")
        }
        when (type) {
            "A" -> Field("IPv4 address") { RunovaTextField(content, { content = it }, "203.0.113.10", label = "IPv4 address") }
            "AAAA" -> Field("IPv6 address") { RunovaTextField(content, { content = it }, "2001:db8::1", label = "IPv6 address") }
            "CNAME" -> Field("Target", "The name this one points at.") {
                RunovaTextField(content, { content = it }, "example.net", label = "Target")
            }
            "TXT" -> Field("Content") { RunovaTextField(content, { content = it }, "v=spf1 include:example.net ~all", label = "Content") }
            "MX" -> {
                Field("Mail server") { RunovaTextField(content, { content = it }, "mx.example.net", label = "Mail server") }
                Field("Priority", "Lower numbers are tried first.") {
                    RunovaTextField(priority, { priority = it.digits() }, "10", label = "Priority")
                }
            }
            "CAA" -> {
                Field("Tag") { ChoiceChips(CAA_TAGS, caaTag) { caaTag = it } }
                Field("Value", "Such as letsencrypt.org") { RunovaTextField(caaValue, { caaValue = it }, "letsencrypt.org", label = "Value") }
                Field("Flags") { RunovaTextField(caaFlags, { caaFlags = it.digits().take(3) }, "0", label = "Flags") }
            }
            "SRV" -> {
                Field("Target") { RunovaTextField(srvTarget, { srvTarget = it }, "sip.example.com", label = "Target") }
                RunovaText("Priority, weight and port", style = RunovaType.label)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { RunovaTextField(srvPriority, { srvPriority = it.digits() }, "Priority", label = "Priority") }
                    Box(Modifier.weight(1f)) { RunovaTextField(srvWeight, { srvWeight = it.digits() }, "Weight", label = "Weight") }
                    Box(Modifier.weight(1f)) { RunovaTextField(srvPort, { srvPort = it.digits() }, "Port", label = "Port") }
                }
            }
        }
        if (proxiable) {
            SwitchRow(
                "Proxy through Cloudflare",
                "Hides the server's address and adds caching and protection.",
                RunovaIcons.Cloud,
                proxied,
                true,
            ) { proxied = it }
        }
        if (proxiable && proxied) {
            RunovaText("TTL is Auto while the record is proxied.", style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
        } else {
            Field("TTL") { ChoiceChips(TTLS, ttl) { ttl = it } }
        }
        Field("Comment", "Only you see it, in Cloudflare.") {
            RunovaTextField(comment, { comment = it }, "Optional", label = "Comment")
        }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            if (form.saving) "Saving" else "Save record",
            {
                intents.saveRecord(
                    RecordDraft(
                        type, name, content, ttl, proxied, priority.toUIntOrNull() ?: 0u, comment,
                        (caaFlags.toIntOrNull() ?: 0).coerceIn(0, 255).toUByte(), caaTag, caaValue,
                        srvPriority.toUIntOrNull() ?: 0u, srvWeight.toUIntOrNull() ?: 0u, srvPort.toUIntOrNull() ?: 0u, srvTarget,
                    ),
                )
            },
            Modifier.fillMaxWidth(),
            enabled = !form.saving,
            icon = RunovaIcons.Check,
        )
        form.recordId?.let { id ->
            RunovaButton("Delete record", { intents.deleteRecord(id) }, Modifier.fillMaxWidth(), kind = ButtonKind.Danger, icon = RunovaIcons.Trash)
        }
    }
}

@Composable
private fun TokenScreen(form: CloudflareTokenFormView, error: String?, intents: CloudflareIntents) {
    val links = LocalUriHandler.current
    var label by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    val replacing = form.accountId != null
    FormScreen(
        if (replacing) "Replace token" else "Connect Cloudflare",
        form.accountLabel,
        intents.closeTokenForm,
    ) {
        RunovaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Step(1, "Open Cloudflare's API tokens page and create a token for Runova.")
                Step(2, "Give it the permissions Runova lists on the computer, for all zones.")
                Step(3, "Paste it here. It's checked and saved on the computer, never on this phone.")
                RunovaButton("Open Cloudflare's token page", { links.openUri(TOKEN_PAGE) }, kind = ButtonKind.Soft, icon = RunovaIcons.External)
            }
        }
        if (!replacing) {
            Field("Account name", "What you call this account, such as Work.") {
                RunovaTextField(label, { label = it }, "Work", label = "Account name")
            }
        }
        Field("API token", "You'll confirm it's you before the token leaves this phone.") {
            RunovaTextField(token, { token = it }, "Paste the token", secure = true, icon = RunovaIcons.Key, label = "API token")
        }
        (form.problem ?: error)?.let { ErrorText(it) }
        RunovaButton(
            when {
                form.saving -> "Checking the token"
                replacing -> "Replace token"
                else -> "Connect"
            },
            { intents.saveToken(token, label) },
            Modifier.fillMaxWidth(),
            enabled = token.isNotBlank() && !form.saving,
            icon = RunovaIcons.Lock,
        )
    }
}

@Composable
private fun Step(number: Int, text: String) {
    val colors = RunovaTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(20.dp).clip(CircleShape).background(colors.primary.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            RunovaText("$number", style = RunovaType.caption, color = colors.primary)
        }
        RunovaText(text, Modifier.weight(1f), RunovaType.small, colors.foreground)
    }
}

@Composable
private fun AddDomainScreen(form: CloudflareAddDomainView, intents: CloudflareIntents) {
    var name by remember { mutableStateOf("") }
    var account by remember(form.choices) { mutableStateOf(form.choices.firstOrNull()?.id.orEmpty()) }
    FormScreen("Add a domain", null, intents.closeAddDomain) {
        Field("Domain", "Cloudflare gives you two name servers to set at your registrar.") {
            RunovaTextField(name, { name = it }, "example.com", icon = RunovaIcons.Globe, label = "Domain")
        }
        when {
            form.loading -> RunovaSkeleton(Modifier.fillMaxWidth())
            form.choices.size > 1 -> Field("Cloudflare account") {
                ChoiceChips(form.choices.map { it.id to it.name }, account) { account = it }
            }
        }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            if (form.saving) "Adding" else "Add domain",
            { intents.addDomain(name, account) },
            Modifier.fillMaxWidth(),
            enabled = name.isNotBlank() && account.isNotEmpty() && !form.saving,
            icon = RunovaIcons.Add,
        )
    }
}

@Composable
private fun PointDomainScreen(form: CloudflarePointDomainView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    var name by remember { mutableStateOf("@") }
    var server by remember(form.servers) { mutableStateOf(form.servers.firstOrNull()?.id.orEmpty()) }
    var www by remember { mutableStateOf(true) }
    var proxied by remember { mutableStateOf(true) }
    var stale by remember { mutableStateOf(false) }
    FormScreen("Point to a server", form.zoneName, intents.closePointDomain) {
        Field("Name", "@ is ${form.zoneName} itself.") {
            RunovaTextField(name, { name = it; stale = true }, "@ or app", label = "Name")
        }
        Field("Server") {
            if (form.servers.isEmpty() && !form.loading) {
                RunovaText("No saved servers yet. Add one in Deploy on the computer.", style = RunovaType.small, color = colors.mutedForeground)
            } else {
                ChoiceChips(form.servers.map { it.id to it.name }, server) { server = it; stale = true }
            }
        }
        SwitchRow("Also point www", "www.${form.zoneName} goes to the same server.", RunovaIcons.Globe, www, true) { www = it; stale = true }
        SwitchRow("Through Cloudflare's proxy", "Hides the server's address.", RunovaIcons.Cloud, proxied, true) { proxied = it; stale = true }
        RunovaButton(
            "Preview changes",
            { stale = false; intents.previewPointDomain(name, server, www, proxied) },
            Modifier.fillMaxWidth(),
            kind = ButtonKind.Soft,
            enabled = server.isNotEmpty() && !form.loading,
            icon = RunovaIcons.Show,
        )
        if (form.loading && form.servers.isNotEmpty()) RunovaSkeleton(Modifier.fillMaxWidth())
        form.plan?.takeIf { !stale }?.let { plan ->
            RunovaCard(Modifier.fillMaxWidth()) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    RunovaText(plan.summary, style = RunovaType.label)
                    plan.changes.forEach { change ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            RunovaBadge(change.actionLabel, change.tone.badge())
                            Column(Modifier.weight(1f)) {
                                RunovaText("${change.recordType}  ${change.name}  →  ${change.content}", style = RunovaType.mono.copy(fontSize = RunovaType.small.fontSize), maxLines = 1)
                                change.previous?.let { RunovaText("was $it", style = RunovaType.caption, color = colors.mutedForeground) }
                                change.reason?.let { RunovaText(it, style = RunovaType.caption, color = colors.mutedForeground) }
                            }
                        }
                    }
                }
            }
        }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            if (form.saving) "Applying" else "Apply",
            intents.applyPointDomain,
            Modifier.fillMaxWidth(),
            enabled = form.plan?.upToDate == false && !stale && !form.saving,
            icon = RunovaIcons.Check,
        )
    }
}
