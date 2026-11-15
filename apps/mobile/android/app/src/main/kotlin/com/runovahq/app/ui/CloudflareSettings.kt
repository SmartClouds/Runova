package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
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
import com.runovahq.app.design.RunovaTextArea
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.CloudflareAccessRuleView
import uniffi.runova_ffi.CloudflareFormView
import uniffi.runova_ffi.CloudflareRevealedSecretView
import uniffi.runova_ffi.CloudflareRuleView
import uniffi.runova_ffi.CloudflareSettingKind
import uniffi.runova_ffi.CloudflareSettingView
import uniffi.runova_ffi.CloudflareSettingsGroup
import uniffi.runova_ffi.CloudflareTab
import uniffi.runova_ffi.CloudflareTone
import uniffi.runova_ffi.CloudflareZoneView

/** The tabs of a domain, in the desktop's order. */
private val ZONE_TABS = listOf(
    CloudflareTab.DNS to "DNS",
    CloudflareTab.SSL to "SSL/TLS",
    CloudflareTab.CACHING to "Caching",
    CloudflareTab.SECURITY to "Security",
    CloudflareTab.ACCESS to "Access",
    CloudflareTab.SERVERS to "Servers",
    CloudflareTab.TURNSTILE to "Turnstile",
)

/** A choice with more options than this folds away behind its current value. */
private const val FOLD_FROM = 7

private val RULE_KINDS = listOf(
    Triple("block-countries", "Block countries", "Visitors from these countries get an error page."),
    Triple("challenge-path", "Challenge a path", "Visitors to a page, such as a login, prove they are human first."),
    Triple("allow-ips", "Allow IP addresses", "Requests from these addresses skip the other custom rules."),
)

private val ACCESS_MODES = listOf(
    "block" to "Block",
    "managed_challenge" to "Managed challenge",
    "challenge" to "Interactive challenge",
    "js_challenge" to "JavaScript challenge",
    "whitelist" to "Allow",
)

/** The desktop's tab strip, as a row of pills that wraps on a narrow phone. */
@Composable
internal fun ZoneTabs(selected: CloudflareTab, onSelect: (CloudflareTab) -> Unit) {
    val colors = RunovaTheme.colors
    // Scrolls sideways when the tabs are wider than the phone, and keeps the open one in view.
    val strip = rememberLazyListState()
    val index = ZONE_TABS.indexOfFirst { it.first == selected }.coerceAtLeast(0)
    LaunchedEffect(index) { strip.animateScrollToItem(index) }
    LazyRow(
        Modifier
            .fillMaxWidth()
            .clip(CircleShape)
            .background(colors.foreground.copy(alpha = 0.05f)),
        state = strip,
        contentPadding = PaddingValues(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        items(ZONE_TABS, key = { it.second }) { (tab, label) ->
            val on = tab == selected
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(if (on) colors.primary.copy(alpha = 0.14f) else colors.foreground.copy(alpha = 0f))
                    .clickable(role = Role.Tab) { onSelect(tab) }
                    .semantics { this.selected = on }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                RunovaText(label, style = RunovaType.labelStrong, color = if (on) colors.primary else colors.mutedForeground, maxLines = 1)
            }
        }
    }
}

/** Everything a tab other than DNS shows, under the switches and the tab strip. */
internal fun LazyListScope.zoneTab(
    zone: CloudflareZoneView,
    revealed: CloudflareRevealedSecretView?,
    intents: CloudflareIntents,
) {
    when (zone.tab) {
        CloudflareTab.ACCESS -> return accessTab(zone.access, intents)
        CloudflareTab.TURNSTILE -> return turnstileTab(zone, revealed, intents)
        CloudflareTab.SERVERS -> return serversTab(zone, intents)
        else -> {}
    }
    if (zone.settings.isEmpty()) {
        item(key = "settings-loading") { LoadingRows() }
    }
    zone.settings.forEach { group ->
        item(key = "group/${group.title}") { GroupCard(group, intents) }
    }
    when (zone.tab) {
        CloudflareTab.CACHING -> item(key = "purge") { PurgeCard(intents) }
        CloudflareTab.SECURITY -> {
            item(key = "rules") { RulesCard(zone, intents) }
            item(key = "access") { AccessRulesCard(zone, intents) }
        }
        else -> {}
    }
}

@Composable
private fun GroupCard(group: CloudflareSettingsGroup, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle(group.title)
        RunovaText(group.detail, style = RunovaType.small, color = colors.mutedForeground)
        RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)) {
            Column { group.items.forEach { SettingItem(it, intents) } }
        }
    }
}

@Composable
private fun SettingItem(item: CloudflareSettingView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    if (item.kind == CloudflareSettingKind.SWITCH) {
        Column {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    RunovaText(item.title, style = RunovaType.label)
                    RunovaText(item.detail, style = RunovaType.small, color = colors.mutedForeground)
                }
                RunovaToggle(item.on, { intents.changeSetting(item.key, if (it) "on" else "off") }, item.title, enabled = item.editable)
            }
            item.note?.let { Note(it, item.noteTone) }
        }
        return
    }
    var open by remember(item.key) { mutableStateOf(false) }
    val current = item.options.firstOrNull { it.value == item.value }?.label ?: item.value
    val folds = item.options.size >= FOLD_FROM
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                RunovaText(item.title, style = RunovaType.label)
                RunovaText(item.detail, style = RunovaType.small, color = colors.mutedForeground)
            }
            if (folds) {
                RunovaChip(
                    current,
                    { open = !open },
                    Modifier.semantics { contentDescription = "${item.title}: $current" },
                    icon = if (open) RunovaIcons.Close else RunovaIcons.Edit,
                )
            }
        }
        if (!folds || open) {
            ChoiceChips(item.options.map { it.value to it.label }, item.value, enabled = item.editable) {
                open = false
                if (it != item.value) intents.changeSetting(item.key, it)
            }
        }
        item.note?.let { Note(it, item.noteTone) }
    }
}

@Composable
private fun Note(text: String, tone: CloudflareTone) {
    val colors = RunovaTheme.colors
    val ink = when (tone) {
        CloudflareTone.GOOD -> colors.mutedForeground
        CloudflareTone.WARNING -> colors.warning
        CloudflareTone.BAD -> colors.destructive
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 6.dp)) {
        if (tone != CloudflareTone.GOOD) RunovaIcon(RunovaIcons.Warning, size = 12.dp, color = ink)
        RunovaText(text, style = RunovaType.small, color = ink)
    }
}

@Composable
private fun PurgeCard(intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    var urls by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle("Purge cache")
        RunovaText(
            "Cloudflare keeps copies of your files close to visitors. Purge them when a change does not show up.",
            style = RunovaType.small,
            color = colors.mutedForeground,
        )
        RunovaCard(Modifier.fillMaxWidth()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                RunovaTextArea(urls, { urls = it }, "https://example.com/style.css, one per line", minHeight = 72.dp)
                Wrap {
                    RunovaButton("Purge these files", { intents.purgeUrls(urls) }, kind = ButtonKind.Soft, enabled = urls.isNotBlank(), icon = RunovaIcons.File)
                    RunovaButton("Purge everything", intents.purgeEverything, kind = ButtonKind.Danger, icon = RunovaIcons.Eraser)
                }
            }
        }
    }
}

@Composable
private fun RulesCard(zone: CloudflareZoneView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle("WAF custom rules")
        RunovaText("Cloudflare runs them top to bottom. An allow rule skips the ones below it.", style = RunovaType.small, color = colors.mutedForeground)
        RunovaChip("Add rule", intents.openRuleBuilder, icon = RunovaIcons.Add, tone = ChipTone.Primary)
        when {
            zone.rules.loading -> LoadingRows()
            zone.rules.problem != null -> ErrorText(zone.rules.problem!!)
            zone.rules.custom.isEmpty() -> RunovaText(
                "No custom rules yet. Add one to block countries, challenge a login page or let your office through.",
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            else -> RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 4.dp)) {
                Column { zone.rules.custom.forEach { RuleRow(it, intents) } }
            }
        }
    }
}

@Composable
private fun RuleRow(rule: CloudflareRuleView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            RunovaText(rule.description, style = RunovaType.labelStrong, maxLines = 2)
            RunovaBadge(rule.actionLabel, rule.tone.badge())
            RunovaText(rule.expression, style = RunovaType.mono.copy(fontSize = RunovaType.small.fontSize), color = colors.mutedForeground, maxLines = 2)
        }
        RunovaToggle(rule.enabled, { intents.setRuleEnabled(rule.id, it) }, rule.description)
        TrashButton("Delete the rule ${rule.description}") { intents.deleteRule(rule.id) }
    }
}

@Composable
private fun AccessRulesCard(zone: CloudflareZoneView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaSectionTitle("IP access rules")
        RunovaText("Block, challenge or allow an address, a range, a country or a network for the whole domain.", style = RunovaType.small, color = colors.mutedForeground)
        RunovaChip("Add access rule", intents.openAccessRuleForm, icon = RunovaIcons.Add, tone = ChipTone.Primary)
        when {
            zone.rules.accessProblem != null -> ErrorText(zone.rules.accessProblem!!)
            zone.rules.access.isEmpty() -> RunovaText("No access rules yet.", style = RunovaType.small, color = colors.mutedForeground)
            else -> RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 4.dp)) {
                Column { zone.rules.access.forEach { AccessRow(it, intents) } }
            }
        }
    }
}

@Composable
private fun AccessRow(rule: CloudflareAccessRuleView, intents: CloudflareIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            RunovaText(rule.value, style = RunovaType.mono)
            RunovaText(
                listOf(rule.targetLabel, rule.notes).filter { it.isNotBlank() }.joinToString(" · "),
                style = RunovaType.small,
                color = colors.mutedForeground,
                maxLines = 1,
            )
        }
        RunovaBadge(rule.modeLabel, rule.tone.badge())
        TrashButton("Delete the access rule for ${rule.value}") { intents.deleteAccessRule(rule.id) }
    }
}

@Composable
private fun TrashButton(label: String, onClick: () -> Unit) {
    val colors = RunovaTheme.colors
    Box(
        Modifier
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .padding(8.dp),
    ) {
        RunovaIcon(RunovaIcons.Trash, size = 14.dp, color = colors.mutedForeground)
    }
}

@Composable
internal fun RuleBuilderScreen(form: CloudflareFormView, intents: CloudflareIntents) {
    var kind by remember { mutableStateOf("block-countries") }
    var countries by remember { mutableStateOf("") }
    var path by remember { mutableStateOf("") }
    var prefix by remember { mutableStateOf(false) }
    var ips by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    val filled = when (kind) {
        "block-countries" -> countries.isNotBlank()
        "challenge-path" -> path.isNotBlank()
        else -> ips.isNotBlank()
    }
    FormScreen("Add a custom rule", "Runs for every request, before it reaches your server.", intents.closeRuleBuilder) {
        Field("Rule") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RULE_KINDS.forEach { (value, label, detail) -> KindRow(label, detail, value == kind) { kind = value } }
            }
        }
        when (kind) {
            "block-countries" -> Field("Country codes", "Two-letter codes separated by commas, such as CN, RU. T1 stands for Tor.") {
                RunovaTextField(countries, { countries = it }, "CN, RU", label = "Country codes")
            }
            "challenge-path" -> {
                Field("Path") { RunovaTextField(path, { path = it }, "/wp-login.php", label = "Path") }
                Field("Match") {
                    ChoiceChips(listOf(false to "Exactly this path", true to "This path and everything under it"), prefix) { prefix = it }
                }
            }
            else -> Field("Addresses and ranges", "One per line, or separated by commas, such as 203.0.113.10 or 2001:db8::/32.") {
                RunovaTextArea(ips, { ips = it }, "203.0.113.10", minHeight = 72.dp)
            }
        }
        Field("Description", "Left empty, it is written from the rule.") {
            RunovaTextField(description, { description = it }, "Optional", label = "Description")
        }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            if (form.saving) "Adding" else "Add rule",
            { intents.addRule(kind, if (kind == "block-countries") countries else ips, path, prefix, description) },
            Modifier.fillMaxWidth(),
            enabled = filled && !form.saving,
            icon = RunovaIcons.Shield,
        )
    }
}

@Composable
private fun KindRow(label: String, detail: String, chosen: Boolean, onClick: () -> Unit) {
    val colors = RunovaTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
            .background(if (chosen) colors.primary.copy(alpha = 0.10f) else colors.foreground.copy(alpha = 0.04f))
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { selected = chosen }
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (chosen) {
            RunovaIcon(RunovaIcons.Success, size = 16.dp, color = colors.primary)
        } else {
            Box(Modifier.size(16.dp).border(1.5.dp, colors.mutedForeground.copy(alpha = 0.6f), CircleShape))
        }
        Column(Modifier.weight(1f)) {
            RunovaText(label, style = RunovaType.label)
            RunovaText(detail, style = RunovaType.small, color = colors.mutedForeground)
        }
    }
}

@Composable
internal fun AccessRuleScreen(form: CloudflareFormView, intents: CloudflareIntents) {
    var value by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("block") }
    var notes by remember { mutableStateOf("") }
    FormScreen("Add an access rule", "For the whole domain.", intents.closeAccessRuleForm) {
        Field("Address, range, country or network", "Such as 203.0.113.10, 203.0.113.0/24, DE or AS13335.") {
            RunovaTextField(value, { value = it }, "203.0.113.0/24", label = "Address, range, country or network")
        }
        Field("Action") { ChoiceChips(ACCESS_MODES, mode) { mode = it } }
        Field("Notes") { RunovaTextField(notes, { notes = it }, "Optional", label = "Notes") }
        form.problem?.let { ErrorText(it) }
        RunovaButton(
            if (form.saving) "Adding" else "Add access rule",
            { intents.addAccessRule(value, mode, notes) },
            Modifier.fillMaxWidth(),
            enabled = value.isNotBlank() && !form.saving,
            icon = RunovaIcons.Shield,
        )
    }
}
