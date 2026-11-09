package com.runovahq.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaProgress
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.ComputerItemView
import uniffi.runova_ffi.LimitChipView
import uniffi.runova_ffi.LimitState
import uniffi.runova_ffi.LimitWindowView
import uniffi.runova_ffi.ProviderState
import uniffi.runova_ffi.ProviderUsageView
import uniffi.runova_ffi.SystemStatsView

data class StatusIntents(
    val openProvider: (String) -> Unit = {},
    val closeProvider: () -> Unit = {},
)

private fun limitBadge(state: LimitState) = when (state) {
    LimitState.OK -> null
    LimitState.ESTIMATE -> "Estimate" to BadgeTone.Neutral
    LimitState.STALE -> "Out of date" to BadgeTone.Warning
    LimitState.UNAVAILABLE -> "Unavailable" to BadgeTone.Warning
}

private fun providerBadge(state: ProviderState) = when (state) {
    ProviderState.OK -> "Connected" to BadgeTone.Success
    ProviderState.CONNECT -> "Not connected" to BadgeTone.Neutral
    ProviderState.ERROR -> "Problem" to BadgeTone.Warning
}

/** The provider detail, when one is open. It takes over the whole device screen. */
@Composable
fun StatusOverlay(view: AppView, intents: StatusIntents): Boolean {
    val provider = view.status.providers.firstOrNull { it.providerId == view.status.detail } ?: return false
    ProviderScreen(provider, intents)
    return true
}

@Composable
fun StatusTab(view: AppView, intents: StatusIntents) {
    val system = view.status.system
    if (system == null) {
        LoadingRows()
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { ComputerCard(system) }
        if (view.status.computer.isNotEmpty()) item(key = "computer") { ComputerList(view.status.computer) }
        items(view.status.limits, key = { it.providerId }) { LimitCard(it) }
        item { Heading("All providers") }
        items(view.status.providers, key = { "p/${it.providerId}" }) { ProviderRow(it, intents) }
    }
}

@Composable
private fun Heading(text: String) {
    RunovaSectionTitle(text)
}

@Composable
private fun Meter(label: String, value: String, percent: Double, detail: String, icon: String? = null) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (icon != null) RunovaIcon(icon, size = 14.dp, color = colors.primary)
            RunovaText(label, Modifier.weight(1f), RunovaType.label)
            RunovaText(value, style = RunovaType.label)
        }
        RunovaProgress(percent)
        RunovaText(detail, style = RunovaType.small, color = colors.mutedForeground)
    }
}

@Composable
private fun ComputerCard(system: SystemStatsView) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Meter("CPU", system.cpuLabel, system.cpuPercent, system.cpuDetail, RunovaIcons.Cpu)
            Meter("Memory", "${system.memPercent.toInt()}%", system.memPercent, system.memLabel, RunovaIcons.Memory)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaIcon(RunovaIcons.Network, size = 14.dp, color = colors.primary)
                RunovaText(
                    "Down ${system.netDownLabel}, up ${system.netUpLabel}",
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                )
            }
        }
    }
}

private fun computerIcon(id: String) = when (id) {
    "agents" -> RunovaIcons.Agent
    "relay" -> RunovaIcons.Bolt
    "transfers" -> RunovaIcons.File
    "terminals" -> RunovaIcons.Terminal
    "sync" -> RunovaIcons.Cloud
    "github" -> RunovaIcons.Git
    "docker" -> RunovaIcons.Deploy
    "android" -> RunovaIcons.Mobile
    "keep-awake" -> RunovaIcons.Clock
    else -> RunovaIcons.Monitoring
}

/** The rest of the desktop's status bar: what this computer can tell with no window open. */
@Composable
private fun ComputerList(items: List<ComputerItemView>) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Heading("On this computer")
            items.forEach { item ->
                val tone = if (item.attention) BadgeTone.Warning else BadgeTone.Neutral
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    RunovaIconTile(computerIcon(item.id), if (item.attention) BadgeTone.Warning else BadgeTone.Primary, size = 30.dp)
                    Column(Modifier.weight(1f)) {
                        RunovaText(item.title, style = RunovaType.label)
                        item.detail?.let { RunovaText(it, style = RunovaType.small, color = colors.mutedForeground) }
                    }
                    RunovaBadge(item.value, tone, dot = item.attention)
                }
            }
        }
    }
}

@Composable
private fun LimitCard(limit: LimitChipView) {
    val colors = RunovaTheme.colors
    val faded = limit.state == LimitState.STALE
    RunovaCard(Modifier.fillMaxWidth().alpha(if (faded) 0.7f else 1f)) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaIcon(RunovaIcons.Agent, size = 15.dp, color = colors.primary)
                RunovaText(limit.name, style = RunovaType.title)
                limit.plan?.let { RunovaBadge(it) }
                Box(Modifier.weight(1f))
                limitBadge(limit.state)?.let { (text, tone) -> RunovaBadge(text, tone) }
            }
            limit.windows.forEach { LimitWindow(it) }
            limit.problem?.takeIf { limit.state != LimitState.OK }?.let {
                RunovaText(it, style = RunovaType.small, color = colors.mutedForeground)
            }
        }
    }
}

@Composable
private fun LimitWindow(window: LimitWindowView) {
    Meter(window.label, window.percentLabel, window.percent, window.resetsLabel ?: "")
}

@Composable
private fun ProviderRow(provider: ProviderUsageView, intents: StatusIntents) {
    val (text, tone) = providerBadge(provider.state)
    RunovaListRow(
        title = provider.name,
        detail = provider.todayLabel?.let { "$it today" },
        icon = RunovaIcons.Agent,
        iconTone = tone,
        onClick = { intents.openProvider(provider.providerId) },
        trailing = { RunovaBadge(text, tone, dot = true) },
    )
}

@Composable
private fun ProviderScreen(provider: ProviderUsageView, intents: StatusIntents) {
    val colors = RunovaTheme.colors
    RunovaScreen(provider.name, onBack = intents.closeProvider) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            provider.error?.let { RunovaText(it, color = colors.destructive) }
            RunovaCard(Modifier.fillMaxWidth()) {
                Row {
                    Figure("Today", provider.todayLabel, Modifier.weight(1f))
                    Figure("7 days", provider.weekLabel, Modifier.weight(1f))
                    Figure("30 days", provider.monthLabel, Modifier.weight(1f))
                }
            }
            if (provider.series.isNotEmpty()) UsageBars(provider.series)
        }
    }
}

@Composable
private fun Figure(label: String, value: String?, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        RunovaText(label, style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground)
        RunovaText(value ?: "None", style = RunovaType.title)
    }
}

@Composable
private fun UsageBars(series: List<Double>) {
    val colors = RunovaTheme.colors
    val highest = series.maxOrNull()?.takeIf { it > 0 } ?: 1.0
    Row(
        Modifier.fillMaxWidth().height(120.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        series.forEach { value ->
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.BottomCenter) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .fillMaxHeight(((value / highest).toFloat()).coerceIn(0.02f, 1f))
                        .clip(RoundedCornerShape(2.dp))
                        .background(colors.primary),
                )
            }
        }
    }
}
