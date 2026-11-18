package com.runovahq.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.TrafficAttackView
import uniffi.runova_ffi.TrafficBlockedItemView
import uniffi.runova_ffi.TrafficBreakdownView
import uniffi.runova_ffi.TrafficChartView
import uniffi.runova_ffi.TrafficDimensionView
import uniffi.runova_ffi.TrafficKpiView
import uniffi.runova_ffi.TrafficRange
import uniffi.runova_ffi.TrafficRowView
import uniffi.runova_ffi.TrafficScreen
import uniffi.runova_ffi.TrafficSettingsView
import uniffi.runova_ffi.TrafficTab
import uniffi.runova_ffi.TrafficTone
import uniffi.runova_ffi.TrafficTrend

/** What the traffic screens ask the core for (E111). */
data class TrafficIntents(
    val open: () -> Unit = {},
    val close: () -> Unit = {},
    val setTab: (TrafficTab) -> Unit = {},
    val setRange: (TrafficRange) -> Unit = {},
    val setSite: (String?) -> Unit = {},
    val setGranularity: (String) -> Unit = {},
    val block: (Long) -> Unit = {},
    val unblock: (Long) -> Unit = {},
    val openSettings: () -> Unit = {},
    val closeSettings: () -> Unit = {},
    val setStatistics: (Boolean) -> Unit = {},
    val setCountries: (Boolean) -> Unit = {},
    val setHourly: (UInt) -> Unit = {},
    val setDaily: (UInt) -> Unit = {},
    val setDetection: (Boolean) -> Unit = {},
    val saveSettings: () -> Unit = {},
    val openDimension: (String) -> Unit = {},
    val moreDimension: () -> Unit = {},
    val closeDimension: () -> Unit = {},
)

private val TABS = listOf(TrafficTab.OVERVIEW to "Overview", TrafficTab.ATTACKS to "Attacks", TrafficTab.BLOCKED to "Blocked")

/** The palette's own colours for the charts, so both themes read. */
@Composable
private fun visitorsColor() = RunovaTheme.colors.primary

@Composable
private fun pageViewsColor() = RunovaTheme.colors.severityInfo

@Composable
private fun sliceColors(): List<Color> {
    val c = RunovaTheme.colors
    return listOf(c.primary, c.severityInfo, c.warning, c.success, c.severityHigh, c.mutedForeground)
}

/** The traffic screens over the server, or false when none is open. */
@Composable
internal fun TrafficOverlay(traffic: TrafficScreen?, error: String?, intents: TrafficIntents): Boolean {
    traffic ?: return false
    val dimension = traffic.dimension
    val settings = traffic.settings
    when {
        dimension != null -> DimensionScreen(dimension, intents)
        settings != null -> SettingsScreen(settings, traffic.serverName, intents)
        else -> TrafficMain(traffic, error, intents)
    }
    return true
}

@Composable
private fun TrafficMain(traffic: TrafficScreen, error: String?, intents: TrafficIntents) {
    RunovaScreen(
        "Traffic",
        subtitle = traffic.serverName,
        onBack = intents.close,
        trailing = if (traffic.canAdmin) {
            { RunovaChip("Settings", intents.openSettings, Modifier.padding(end = 8.dp), icon = RunovaIcons.Settings) }
        } else {
            null
        },
    ) {
        LazyColumn(
            Modifier.weight(1f),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(key = "tabs") { ChoiceChips(TABS, traffic.tab) { intents.setTab(it) } }
            if (traffic.sites.size > 1) {
                item(key = "sites") {
                    ChoiceChips(traffic.sites.map { it.id to it.label }, traffic.siteId) { intents.setSite(it) }
                }
            }
            when (traffic.tab) {
                TrafficTab.OVERVIEW -> overview(traffic, intents)
                TrafficTab.ATTACKS -> attacks(traffic, intents)
                TrafficTab.BLOCKED -> blocked(traffic, intents)
            }
        }
        error?.let { ErrorText(it, Modifier.padding(16.dp)) }
    }
}

private fun LazyListScope.overview(traffic: TrafficScreen, intents: TrafficIntents) {
    item(key = "ranges") {
        ChoiceChips(traffic.ranges.map { it.range to it.label }, traffic.range) { intents.setRange(it) }
    }
    val buckets = traffic.granularities.filter { it.enabled }
    if (buckets.size > 1) {
        item(key = "buckets") {
            ChoiceChips(buckets.map { it.value to it.label }, buckets.firstOrNull { it.selected }?.value ?: "") {
                intents.setGranularity(it)
            }
        }
    }
    when {
        traffic.loading -> item(key = "loading") { LoadingRows() }
        traffic.problem != null -> item(key = "problem") { ErrorText(traffic.problem!!) }
        traffic.off != null -> item(key = "off") { OffCard(traffic.off!!, traffic.canAdmin, intents) }
        else -> {
            val dim = if (traffic.refreshing) 0.55f else 1f
            traffic.empty?.let { item(key = "empty") { Muted(it) } }
            items(traffic.kpis.chunked(2), key = { "k/${it.first().label}" }) { pair ->
                Row(Modifier.fillMaxWidth().alpha(dim), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    pair.forEach { KpiTile(it, Modifier.weight(1f)) }
                    if (pair.size == 1) Box(Modifier.weight(1f))
                }
            }
            traffic.chart?.let { chart -> item(key = "chart") { ChartCard(chart, Modifier.alpha(dim)) } }
            traffic.devices?.let { devices -> item(key = "devices") { DevicesCard(devices, intents) } }
            traffic.countries?.let { countries ->
                item(key = "countries") { BreakdownCard(countries, intents, traffic.countrySources) }
            }
            items(traffic.breakdowns, key = { "b/${it.dimension}" }) { BreakdownCard(it, intents) }
        }
    }
}

@Composable
private fun Muted(text: String, modifier: Modifier = Modifier) {
    RunovaText(text, modifier, RunovaType.small, RunovaTheme.colors.mutedForeground)
}

@Composable
private fun OffCard(text: String, canAdmin: Boolean, intents: TrafficIntents) {
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaText("Traffic statistics are off", style = RunovaType.title)
            Muted(text)
            if (canAdmin) RunovaButton("Settings", intents.openSettings, icon = RunovaIcons.Settings)
        }
    }
}

@Composable
private fun toneColor(tone: TrafficTone): Color = when (tone) {
    TrafficTone.GOOD -> RunovaTheme.colors.success
    TrafficTone.BAD -> RunovaTheme.colors.destructive
    TrafficTone.NEUTRAL -> RunovaTheme.colors.mutedForeground
}

private fun arrow(trend: TrafficTrend) = when (trend) {
    TrafficTrend.UP -> "↑ "
    TrafficTrend.DOWN -> "↓ "
    TrafficTrend.FLAT -> ""
}

@Composable
private fun KpiTile(kpi: TrafficKpiView, modifier: Modifier = Modifier) {
    val change = kpi.change
    val spoken = listOfNotNull(kpi.label, kpi.prefix, kpi.value, change?.text).joinToString(" ")
    RunovaCard(modifier.semantics(mergeDescendants = true) { contentDescription = spoken }, padding = PaddingValues(12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Muted(kpi.label)
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                kpi.prefix?.let { Muted(it, Modifier.padding(bottom = 2.dp)) }
                RunovaText(kpi.value, style = RunovaType.heading)
            }
            change?.let {
                RunovaText(arrow(it.trend) + it.text, style = RunovaType.caption, color = toneColor(it.tone))
            }
        }
    }
}

@Composable
private fun Legend(color: Color, label: String, dashed: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.size(width = 16.dp, height = 8.dp)) {
            drawLine(
                color,
                Offset(0f, size.height / 2),
                Offset(size.width, size.height / 2),
                strokeWidth = 2.dp.toPx(),
                pathEffect = if (dashed) PathEffect.dashPathEffect(floatArrayOf(6f, 4f)) else null,
            )
        }
        Muted(label)
    }
}

/** Visitors and page views, the period before dashed; a finger on it reads a point out. */
@Composable
private fun ChartCard(chart: TrafficChartView, modifier: Modifier = Modifier) {
    val visitors = visitorsColor()
    val pageViews = pageViewsColor()
    val grid = RunovaTheme.colors.border
    val highlight = RunovaTheme.colors.foreground.copy(alpha = 0.35f)
    var picked by remember(chart) { mutableStateOf<Int?>(null) }
    val count = chart.points.size
    RunovaCard(modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaText("Visitors and page views", style = RunovaType.title)
            val point = picked?.let { chart.points.getOrNull(it) }
            Column(Modifier.height(36.dp)) {
                if (point != null) {
                    RunovaText(point.readout, style = RunovaType.small, maxLines = 1)
                    point.previousReadout?.let { Muted(it) }
                } else {
                    Muted("Touch the chart to read a point.")
                }
            }
            Row {
                Column(Modifier.height(160.dp).padding(end = 6.dp), verticalArrangement = Arrangement.SpaceBetween) {
                    chart.yLabels.forEach { RunovaText(it, style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground) }
                }
                fun indexAt(x: Float, width: Float): Int =
                    if (count <= 1) 0 else ((x / width) * (count - 1)).let { Math.round(it) }.coerceIn(0, count - 1)
                Canvas(
                    Modifier
                        .weight(1f)
                        .height(160.dp)
                        .semantics { contentDescription = "Chart of visitors and page views. Touch to read a point." }
                        .pointerInput(chart) {
                            detectTapGestures { picked = indexAt(it.x, size.width.toFloat()) }
                        }
                        .pointerInput(chart) {
                            detectDragGestures { change, _ -> picked = indexAt(change.position.x, size.width.toFloat()) }
                        },
                ) {
                    val max = chart.max.toFloat().coerceAtLeast(1f)
                    for (i in 0..2) {
                        val y = size.height * i / 2f
                        drawLine(grid, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
                    }
                    fun x(i: Int) = if (count <= 1) size.width / 2 else size.width * i / (count - 1)
                    fun y(v: Double) = size.height - (v.toFloat() / max) * size.height
                    fun line(values: List<Double?>, color: Color, dashed: Boolean) {
                        val path = Path()
                        var started = false
                        values.forEachIndexed { i, v ->
                            if (v == null) return@forEachIndexed
                            if (started) path.lineTo(x(i), y(v)) else path.moveTo(x(i), y(v))
                            started = true
                        }
                        drawPath(
                            path,
                            color.copy(alpha = if (dashed) 0.55f else 1f),
                            style = Stroke(
                                width = 2.dp.toPx(),
                                cap = StrokeCap.Round,
                                pathEffect = if (dashed) PathEffect.dashPathEffect(floatArrayOf(10f, 8f)) else null,
                            ),
                        )
                    }
                    line(chart.points.map { it.previousPageViews }, pageViews, true)
                    line(chart.points.map { it.previousVisitors }, visitors, true)
                    line(chart.points.map { it.pageViews }, pageViews, false)
                    line(chart.points.map { it.visitors }, visitors, false)
                    picked?.let { i ->
                        drawLine(highlight, Offset(x(i), 0f), Offset(x(i), size.height), strokeWidth = 1.dp.toPx())
                        val p = chart.points[i]
                        drawCircle(pageViews, 4.dp.toPx(), Offset(x(i), y(p.pageViews)))
                        drawCircle(visitors, 4.dp.toPx(), Offset(x(i), y(p.visitors)))
                    }
                }
            }
            if (count > 0) {
                Row(Modifier.fillMaxWidth().padding(start = 30.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf(0, count / 2, count - 1).distinct().forEach {
                        RunovaText(chart.points[it].axis, style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Legend(visitors, "Visitors")
                Legend(pageViews, "Page views")
                Legend(RunovaTheme.colors.mutedForeground, "Period before", dashed = true)
            }
        }
    }
}

@Composable
private fun ShareRow(row: TrafficRowView) {
    val bar = RunovaTheme.colors.primary.copy(alpha = 0.12f)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .semantics(mergeDescendants = true) { contentDescription = "${row.label}, ${row.value}, ${row.shareLabel}" },
    ) {
        Box(Modifier.matchParentSize()) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(row.share.coerceIn(0f, 1f)).background(bar))
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            row.flag?.let { RunovaText(it, style = RunovaType.label) }
            RunovaText(row.label, Modifier.weight(1f), RunovaType.label, maxLines = 1)
            RunovaText(row.value, style = RunovaType.label)
            RunovaText(row.shareLabel, Modifier.width(44.dp), RunovaType.small, RunovaTheme.colors.mutedForeground)
        }
    }
}

@Composable
private fun BreakdownCard(breakdown: TrafficBreakdownView, intents: TrafficIntents, note: String? = null) {
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    RunovaText(breakdown.title, style = RunovaType.title)
                    Muted(breakdown.unit)
                }
                if (breakdown.rows.isNotEmpty()) {
                    RunovaChip(
                        "See all",
                        { intents.openDimension(breakdown.dimension) },
                        Modifier.semantics { contentDescription = "See all ${breakdown.title.lowercase()}" },
                    )
                }
            }
            if (breakdown.rows.isEmpty()) Muted("Nothing in this range.")
            breakdown.rows.forEach { ShareRow(it) }
            note?.let { Muted(it) }
        }
    }
}

/** Devices as a ring, with the same shares beside it. */
@Composable
private fun DevicesCard(devices: TrafficBreakdownView, intents: TrafficIntents) {
    val colors = sliceColors()
    val track = RunovaTheme.colors.muted
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaText(devices.title, style = RunovaType.title)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Canvas(Modifier.size(96.dp).semantics { contentDescription = "Devices" }) {
                    val stroke = 14.dp.toPx()
                    val inset = stroke / 2
                    val arc = Size(size.width - stroke, size.height - stroke)
                    drawArc(track, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
                    var start = -90f
                    devices.rows.forEachIndexed { i, row ->
                        val sweep = 360f * row.share.coerceIn(0f, 1f)
                        drawArc(colors[i % colors.size], start, sweep, false, Offset(inset, inset), arc, style = Stroke(stroke))
                        start += sweep
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    devices.rows.forEachIndexed { i, row ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(10.dp).clip(CircleShape).background(colors[i % colors.size]))
                            RunovaText(row.label, Modifier.weight(1f), RunovaType.label)
                            RunovaText(row.shareLabel, style = RunovaType.small, color = RunovaTheme.colors.mutedForeground)
                        }
                    }
                    if (devices.rows.isEmpty()) Muted("Nothing in this range.")
                }
            }
        }
    }
}

private fun LazyListScope.attacks(traffic: TrafficScreen, intents: TrafficIntents) {
    val attacks = traffic.attacks
    when {
        attacks.loading && attacks.items.isEmpty() -> item(key = "a/loading") { LoadingRows() }
        attacks.problem != null -> item(key = "a/problem") { ErrorText(attacks.problem!!) }
        else -> {
            item(key = "a/summary") { Muted(attacks.summary) }
            items(attacks.items, key = { "a/${it.id}" }) { AttackCard(it, intents) }
        }
    }
}

@Composable
private fun AttackCard(attack: TrafficAttackView, intents: TrafficIntents) {
    RunovaCard(Modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                attack.flag?.let { RunovaText(it, style = RunovaType.title) }
                Column(Modifier.weight(1f)) {
                    RunovaText(attack.address, style = RunovaType.labelStrong, maxLines = 1)
                    Muted(listOfNotNull(attack.kindLabel, attack.country, attack.site).joinToString(" · "))
                }
                when {
                    attack.blocked -> RunovaText("Blocked", style = RunovaType.caption, color = RunovaTheme.colors.success)
                    attack.canBlock -> RunovaChip(
                        "Block",
                        { intents.block(attack.id) },
                        Modifier.semantics { contentDescription = "Block ${attack.address}" },
                        icon = RunovaIcons.Shield,
                        tone = ChipTone.Danger,
                    )
                }
            }
            Muted("${attack.countLabel}, last ${attack.whenLabel}")
            attack.paths.forEach {
                RunovaText(it, style = RunovaType.mono, color = RunovaTheme.colors.mutedForeground, maxLines = 1)
            }
        }
    }
}

private fun LazyListScope.blocked(traffic: TrafficScreen, intents: TrafficIntents) {
    val list = traffic.blocked
    when {
        list.loading && list.items.isEmpty() -> item(key = "b/loading") { LoadingRows() }
        list.problem != null -> item(key = "b/problem") { ErrorText(list.problem!!) }
        list.items.isEmpty() -> item(key = "b/none") { Muted("No address is blocked.") }
        else -> items(list.items, key = { "b/${it.id}" }) { BlockedRow(it, intents) }
    }
}

@Composable
private fun BlockedRow(item: TrafficBlockedItemView, intents: TrafficIntents) {
    RunovaCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                RunovaText(item.network, style = RunovaType.labelStrong)
                if (item.reason.isNotEmpty()) RunovaText(item.reason, style = RunovaType.small)
                Muted(item.detail)
            }
            if (item.canUnblock) {
                RunovaChip(
                    "Unblock",
                    { intents.unblock(item.id) },
                    Modifier.semantics { contentDescription = "Unblock ${item.network}" },
                )
            }
        }
    }
}

private fun daysLabel(days: UInt) = when {
    days >= 365u && days % 365u == 0u -> if (days == 365u) "1 year" else "${days / 365u} years"
    else -> "$days days"
}

@Composable
private fun SettingsScreen(settings: TrafficSettingsView, server: String, intents: TrafficIntents) {
    FormScreen("Traffic settings", server, intents.closeSettings) {
        if (settings.loading) {
            LoadingRows()
            return@FormScreen
        }
        val editable = !settings.saving
        SwitchRow(
            "Statistics",
            "Read the access logs nginx writes for each website.",
            RunovaIcons.Globe,
            settings.statistics,
            editable,
            intents.setStatistics,
        )
        SwitchRow(
            "Countries",
            "Place visitors by country, from Cloudflare or the DB-IP database.",
            RunovaIcons.Globe,
            settings.countries,
            editable,
            intents.setCountries,
        )
        Field("Keep hourly figures for") {
            ChoiceChips(settings.hourlyChoices.map { it to daysLabel(it) }, settings.hourlyDays, editable) { intents.setHourly(it) }
        }
        Field("Keep daily figures for") {
            ChoiceChips(settings.dailyChoices.map { it to daysLabel(it) }, settings.dailyDays, editable) { intents.setDaily(it) }
        }
        SwitchRow(
            "Attack detection",
            "Watch the same lines for scans, password guessing, floods and injection probes.",
            RunovaIcons.Shield,
            settings.detection,
            editable,
            intents.setDetection,
        )
        Muted(settings.autoBlock)
        Muted(settings.storage)
        settings.problem?.let { ErrorText(it) }
        RunovaButton(
            if (settings.saving) "Saving" else "Save",
            intents.saveSettings,
            Modifier.fillMaxWidth(),
            enabled = settings.dirty && editable,
        )
        RunovaButton("Cancel", intents.closeSettings, Modifier.fillMaxWidth(), kind = ButtonKind.Ghost)
    }
}

@Composable
private fun DimensionScreen(dimension: TrafficDimensionView, intents: TrafficIntents) {
    RunovaScreen(dimension.title, subtitle = dimension.totalLabel.ifEmpty { null }, onBack = intents.closeDimension) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(dimension.rows.withIndex().toList(), key = { "d/${it.index}" }) { ShareRow(it.value) }
            dimension.problem?.let { item(key = "d/problem") { ErrorText(it) } }
            when {
                dimension.loading -> item(key = "d/loading") { LoadingRows() }
                dimension.rows.isEmpty() -> item(key = "d/none") {
                    RunovaEmptyState(RunovaIcons.Search, "Nothing in this range.", "")
                }
                dimension.canLoadMore -> item(key = "d/more") {
                    RunovaButton("Show more", intents.moreDimension, Modifier.fillMaxWidth(), kind = ButtonKind.Soft)
                }
            }
        }
    }
}

/** The way into a server's traffic, on its overview. */
@Composable
internal fun TrafficEntry(onOpen: () -> Unit) {
    Column {
        RunovaSectionTitle("Websites", Modifier.padding(top = 14.dp, bottom = 4.dp))
        com.runovahq.app.design.RunovaListRow(
            title = "Traffic and attacks",
            detail = "Visitors, countries and attacks on the sites",
            icon = RunovaIcons.Globe,
            onClick = onOpen,
        )
    }
}
