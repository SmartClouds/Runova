package com.runovahq.app.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaEmptyState
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaProgress
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaSectionTitle
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.runovaGlass
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.StudioChangeView
import uniffi.runova_ffi.StudioComposerView
import uniffi.runova_ffi.StudioProposalView
import uniffi.runova_ffi.StudioRenderSheetView
import uniffi.runova_ffi.StudioRenderState
import uniffi.runova_ffi.StudioRenderView
import uniffi.runova_ffi.StudioRunView
import uniffi.runova_ffi.StudioSceneView
import uniffi.runova_ffi.StudioStepState
import uniffi.runova_ffi.StudioStepView
import uniffi.runova_ffi.StudioStyleView
import uniffi.runova_ffi.StudioToolsScreen
import uniffi.runova_ffi.StudioVideoItemView
import uniffi.runova_ffi.StudioVideoView

data class StudioIntents(
    val openComposer: () -> Unit = {},
    val closeComposer: () -> Unit = {},
    val create: (String, String, String, UInt, String?) -> Unit = { _, _, _, _, _ -> },
    val openVideo: (String) -> Unit = {},
    val closeVideo: () -> Unit = {},
    val ask: (String) -> Unit = {},
    val applyProposal: () -> Unit = {},
    val discardProposal: () -> Unit = {},
    val undo: () -> Unit = {},
    val animate: (String) -> Unit = {},
    val animateAll: () -> Unit = {},
    val cancelRun: () -> Unit = {},
    val openRender: () -> Unit = {},
    val closeRender: () -> Unit = {},
    val render: (String) -> Unit = {},
    val cancelRender: (String) -> Unit = {},
    val thumbnail: (String) -> ByteArray? = { null },
    val openVoice: () -> Unit = {},
    val closeVoice: () -> Unit = {},
    val pickEngine: (String) -> Unit = {},
    val pickVoice: (String) -> Unit = {},
    val speak: () -> Unit = {},
    val cancelSpeak: () -> Unit = {},
    val caption: (String) -> Unit = {},
    val openTimeline: () -> Unit = {},
    val closeTimeline: () -> Unit = {},
    val nudge: (String, Double) -> Unit = { _, _ -> },
    val trim: (String, Boolean, Double) -> Unit = { _, _, _ -> },
    val gain: (String, Double) -> Unit = { _, _ -> },
    val fades: (String, Double) -> Unit = { _, _ -> },
    val removeClip: (String) -> Unit = {},
    val addMusic: (String) -> Unit = {},
    val muteTrack: (String, Boolean) -> Unit = { _, _ -> },
    val download: (String) -> Unit = {},
    val downloadStop: () -> Unit = {},
    val downloadDismiss: () -> Unit = {},
    val shareVideo: (String) -> Unit = {},
)

private val FilmShape = RoundedCornerShape(10.dp)
private val PanelShape = RoundedCornerShape(18.dp)

/** A title always gets the same poster colour, so a library doesn't read as one grey list. */
private fun posterHue(title: String): Float {
    var hash = 0
    for (char in title) hash = (hash * 31 + char.code) and 0xFFFFFF
    return (hash % 360).toFloat()
}

private fun ratioOf(aspect: String): Float {
    val parts = aspect.split(":").mapNotNull { it.toFloatOrNull() }
    return if (parts.size == 2 && parts[1] > 0f) parts[0] / parts[1] else 16f / 9f
}

private fun colorOf(hex: String): Color =
    hex.removePrefix("#").toLongOrNull(16)?.let { Color(0xFF000000 or it) } ?: Color.Transparent

@Composable
private fun spin(motion: Boolean): Float {
    if (!motion) return 0f
    val transition = rememberInfiniteTransition(label = "spin")
    val angle by transition.animateFloat(
        0f,
        360f,
        infiniteRepeatable(tween(2400, easing = LinearEasing)),
        label = "spin angle",
    )
    return angle
}

@Composable
private fun pulse(motion: Boolean): Float {
    if (!motion) return 1f
    val transition = rememberInfiniteTransition(label = "pulse")
    val value by transition.animateFloat(
        0.45f,
        1f,
        infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "pulse value",
    )
    return value
}

/** The composer or an open video take over the screen. */
@Composable
fun StudioOverlay(view: AppView, intents: StudioIntents): Boolean {
    view.studio.composer?.let {
        StudioComposer(it, view.busy, view.error, intents)
        return true
    }
    view.studioTools.timeline?.let {
        StudioTimelineScreen(it, view.error, intents)
        return true
    }
    view.studio.video?.let {
        StudioVideoScreen(it, view.busy, view.error, view.notice, view.studioTools, intents)
        return true
    }
    return false
}

@Composable
fun StudioTab(view: AppView, intents: StudioIntents) {
    val screen = view.studio
    when {
        screen.note != null && screen.videos.isEmpty() -> RunovaEmptyState(RunovaIcons.Studio, "Studio is off", screen.note!!)
        screen.videos.isEmpty() && screen.loading -> LoadingRows()
        else -> LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item(key = "hero") { StudioHero(intents.openComposer) }
            if (screen.videos.isEmpty()) {
                item(key = "empty") {
                    RunovaText(
                        "Your videos will show up here.",
                        Modifier.fillMaxWidth().padding(top = 28.dp),
                        color = RunovaTheme.colors.mutedForeground,
                        align = TextAlign.Center,
                    )
                }
            } else {
                item(key = "title") { RunovaSectionTitle("Your videos", Modifier.padding(top = 8.dp)) }
                items(screen.videos, key = { it.id }) { StudioVideoRow(it, intents) }
            }
        }
    }
}

/** A strip of film: the mark that makes these screens Studio's own. */
@Composable
private fun FilmStrip(modifier: Modifier = Modifier, color: Color) {
    Canvas(modifier.fillMaxWidth().height(8.dp)) {
        val hole = 7.dp.toPx()
        val gap = 7.dp.toPx()
        var x = gap / 2
        while (x < size.width) {
            drawRoundRect(color, Offset(x, 1.dp.toPx()), Size(hole, size.height - 2.dp.toPx()), CornerRadius(1.5.dp.toPx()))
            x += hole + gap
        }
    }
}

@Composable
private fun StudioHero(onNew: () -> Unit) {
    val colors = RunovaTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(PanelShape)
            .background(
                Brush.linearGradient(
                    listOf(colors.primary.copy(alpha = 0.24f), colors.primary.copy(alpha = 0.04f)),
                ),
            )
            .border(1.dp, colors.primary.copy(alpha = 0.26f), PanelShape)
            .padding(vertical = 10.dp),
    ) {
        FilmStrip(color = colors.primary.copy(alpha = 0.22f))
        Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp)) {
            RunovaIconTile(RunovaIcons.Studio, size = 44.dp)
            Spacer(Modifier.height(14.dp))
            RunovaText("Make a video from a sentence", style = RunovaType.heading)
            Spacer(Modifier.height(4.dp))
            RunovaText(
                "Describe it here. The AI on this computer writes the scenes, animates them and renders the film.",
                style = RunovaType.small,
                color = colors.mutedForeground,
            )
            Spacer(Modifier.height(16.dp))
            RunovaButton("New video", onClick = onNew, Modifier.fillMaxWidth(), icon = RunovaIcons.Sparkles)
        }
        FilmStrip(color = colors.primary.copy(alpha = 0.22f))
    }
}

@Composable
private fun StudioVideoRow(video: StudioVideoItemView, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .runovaGlass()
            .clickable(role = Role.Button, enabled = !video.missing) { intents.openVideo(video.id) }
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Poster(video.title, 84.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RunovaText(video.title, Modifier.weight(1f, fill = false), RunovaType.labelStrong, maxLines = 1)
                if (video.pinned) RunovaIcon(RunovaIcons.Bolt, size = 10.dp, color = colors.primary)
            }
            RunovaText(
                if (video.missing) "The folder is missing" else video.detail,
                style = RunovaType.small,
                color = if (video.missing) colors.warning else colors.mutedForeground,
                maxLines = 1,
            )
            video.renderLabel?.let {
                Spacer(Modifier.height(4.dp))
                RunovaBadge(it, renderTone(video.renderState), dot = true)
            }
        }
        RunovaIcon(RunovaIcons.Forward, size = 11.dp, color = colors.mutedForeground.copy(alpha = 0.7f))
    }
}

private fun renderTone(state: StudioRenderState?) = when (state) {
    StudioRenderState.DONE -> BadgeTone.Success
    StudioRenderState.RUNNING -> BadgeTone.Primary
    StudioRenderState.FAILED -> BadgeTone.Danger
    StudioRenderState.QUEUED -> BadgeTone.Warning
    else -> BadgeTone.Neutral
}

@Composable
private fun Poster(title: String, width: Dp) {
    val hue = posterHue(title)
    Box(
        Modifier
            .size(width, width * 9f / 16f)
            .clip(FilmShape)
            .background(
                Brush.linearGradient(
                    listOf(Color.hsv(hue, 0.62f, 0.42f), Color.hsv((hue + 48f) % 360f, 0.7f, 0.2f)),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        RunovaIcon(RunovaIcons.Studio, size = 18.dp, color = Color.White.copy(alpha = 0.88f))
    }
}

private val ASPECTS = listOf("16:9" to "Wide", "9:16" to "Tall", "1:1" to "Square", "4:5" to "Post")
private val LENGTHS = listOf(15u to "15s", 30u to "30s", 60u to "1 min", 120u to "2 min")

@Composable
private fun StudioComposer(composer: StudioComposerView, busy: Boolean, error: String?, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    var brief by remember { mutableStateOf("") }
    var aspect by remember { mutableStateOf("16:9") }
    var seconds by remember { mutableStateOf(30u) }
    var style by remember { mutableStateOf<String?>(null) }
    var language by remember { mutableStateOf("en") }
    RunovaScreen("New video", onBack = intents.closeComposer) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            PromptBox(brief, { brief = it })
            RunovaSectionTitle("Shape", Modifier.padding(top = 8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ASPECTS.forEach { (value, label) ->
                    AspectOption(value, label, value == aspect, Modifier.weight(1f)) { aspect = value }
                }
            }
            RunovaSectionTitle("Length", Modifier.padding(top = 8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LENGTHS.forEach { (value, label) ->
                    RunovaChip(
                        label,
                        onClick = { seconds = value },
                        Modifier.weight(1f),
                        tone = if (value == seconds) ChipTone.Primary else ChipTone.Soft,
                    )
                }
            }
            if (composer.styles.isNotEmpty()) {
                RunovaSectionTitle("Look", Modifier.padding(top = 8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StyleCard("Let the AI pick", null, style == null) { style = null }
                    composer.styles.forEach { option ->
                        StyleCard(option.name, option, style == option.id) { style = option.id }
                    }
                }
            }
            if (composer.languages.isNotEmpty()) {
                RunovaSectionTitle("Language", Modifier.padding(top = 8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    composer.languages.forEach { option ->
                        RunovaChip(
                            option.native,
                            onClick = { language = option.code },
                            tone = if (option.code == language) ChipTone.Primary else ChipTone.Soft,
                        )
                    }
                }
            }
            error?.let { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
        }
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaButton(
                "Write the scenes",
                onClick = { intents.create(brief.trim(), aspect, language, seconds, style) },
                Modifier.fillMaxWidth(),
                enabled = brief.isNotBlank() && !busy,
                icon = RunovaIcons.Sparkles,
            )
            RunovaText(
                "Your AI CLI on this computer does the writing.",
                Modifier.fillMaxWidth(),
                RunovaType.caption,
                colors.mutedForeground,
                align = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun PromptBox(value: String, onChange: (String) -> Unit) {
    val colors = RunovaTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(PanelShape)
            .background(colors.foreground.copy(alpha = 0.05f))
            .border(1.dp, colors.primary.copy(alpha = 0.3f), PanelShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaIcon(RunovaIcons.Sparkles, size = 13.dp, color = colors.primary)
            RunovaText("What's the video about?", style = RunovaType.labelStrong)
        }
        Box {
            if (value.isEmpty()) {
                RunovaText(
                    "A 30 second launch film for our new app, upbeat, ending on the logo.",
                    color = colors.mutedForeground.copy(alpha = 0.7f),
                )
            }
            BasicTextField(
                value,
                onChange,
                Modifier.fillMaxWidth().heightIn(min = 84.dp).semantics { contentDescription = "What the video is about" },
                textStyle = RunovaType.body.copy(color = colors.foreground),
                cursorBrush = SolidColor(colors.primary),
            )
        }
    }
}

@Composable
private fun AspectOption(aspect: String, label: String, on: Boolean, modifier: Modifier, onPick: () -> Unit) {
    val colors = RunovaTheme.colors
    val ink = if (on) colors.primary else colors.mutedForeground
    val ratio = ratioOf(aspect)
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier
            .clip(shape)
            .background(if (on) colors.primary.copy(alpha = 0.13f) else colors.foreground.copy(alpha = 0.05f))
            .border(1.dp, if (on) colors.primary.copy(alpha = 0.45f) else colors.foreground.copy(alpha = 0.08f), shape)
            .clickable(role = Role.Button, onClick = onPick)
            .padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(38.dp), contentAlignment = Alignment.Center) {
            val width = if (ratio >= 1f) 38.dp else 38.dp * ratio
            val height = if (ratio >= 1f) 38.dp / ratio else 38.dp
            Box(Modifier.size(width, height).clip(RoundedCornerShape(4.dp)).border(1.5.dp, ink, RoundedCornerShape(4.dp)))
        }
        RunovaText(label, style = RunovaType.small, color = ink)
    }
}

@Composable
private fun StyleCard(label: String, style: StudioStyleView?, on: Boolean, onPick: () -> Unit) {
    val colors = RunovaTheme.colors
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier
            .width(118.dp)
            .clip(shape)
            .background(if (on) colors.primary.copy(alpha = 0.13f) else colors.foreground.copy(alpha = 0.05f))
            .border(1.dp, if (on) colors.primary.copy(alpha = 0.45f) else colors.foreground.copy(alpha = 0.08f), shape)
            .clickable(role = Role.Button, onClick = onPick)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(34.dp).clip(RoundedCornerShape(8.dp))) {
            if (style == null) {
                Box(
                    Modifier.fillMaxSize().background(
                        Brush.linearGradient(listOf(colors.primary.copy(alpha = 0.5f), colors.primary.copy(alpha = 0.1f))),
                    ),
                    contentAlignment = Alignment.Center,
                ) { RunovaIcon(RunovaIcons.Sparkles, size = 14.dp, color = colors.foreground) }
            } else {
                style.colors.forEach { Box(Modifier.weight(1f).fillMaxSize().background(colorOf(it))) }
            }
        }
        RunovaText(label, style = RunovaType.small, color = if (on) colors.primary else colors.foreground, maxLines = 1)
    }
}

@Composable
private fun StudioVideoScreen(
    video: StudioVideoView,
    busy: Boolean,
    error: String?,
    notice: String?,
    tools: StudioToolsScreen,
    intents: StudioIntents,
) {
    val colors = RunovaTheme.colors
    Box(Modifier.fillMaxSize()) {
        RunovaScreen(
            video.title.ifBlank { "Video" },
            onBack = intents.closeVideo,
            trailing = if (video.canUndo) {
                { RunovaChip("Undo", onClick = intents.undo, Modifier.padding(end = 8.dp), icon = RunovaIcons.Undo) }
            } else {
                null
            },
        ) {
            if (video.loading) {
                Box(Modifier.weight(1f)) { LoadingRows() }
            } else {
                LazyColumn(
                    Modifier.weight(1f),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    item(key = "steps") { StepBar(video.steps) }
                    (video.problem ?: error)?.let { problem ->
                        item(key = "problem") { ProblemCard(problem) }
                    }
                    notice?.let { message ->
                        item(key = "notice") { RunovaText(message, style = RunovaType.small, color = colors.primary) }
                    }
                    video.run?.let { run ->
                        item(key = "run") { RunCard(run, video.animatingAll, intents.cancelRun) }
                    }
                    video.proposal?.let { proposal ->
                        item(key = "proposal") { ProposalCard(proposal, intents) }
                    }
                    tools.narration?.let { narration ->
                        item(key = "narration") { NarrationCard(narration, intents) }
                    }
                    items(video.renders.filter { it.canCancel || it.state == StudioRenderState.DONE }.take(1), key = { "r/${it.id}" }) {
                        RenderCard(it, tools.download == null, intents)
                    }
                    tools.download?.let { download ->
                        item(key = "download") { DownloadCard(download, intents) }
                    }
                    item(key = "actions") { VideoActions(video, busy, intents) }
                    if (video.scenes.isNotEmpty()) {
                        item(key = "scenes") {
                            RunovaSectionTitle("Scenes", Modifier.padding(top = 6.dp))
                        }
                        items(video.scenes, key = { it.id }) { SceneCard(it, video.aspect, busy, intents) }
                    }
                }
                if (video.canAsk) AskBar(intents.ask)
            }
        }
        video.renderSheet?.let { RenderSheet(it, intents) }
        tools.voice?.let { VoiceSheet(it, intents) }
    }
}

@Composable
private fun StepBar(steps: List<StudioStepView>) {
    Row(Modifier.fillMaxWidth().runovaGlass().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.Top) {
        steps.forEachIndexed { index, step ->
            StepNode(index + 1, step)
            if (index < steps.lastIndex) StepLink(step.state == StudioStepState.DONE, Modifier.weight(1f))
        }
    }
}

@Composable
private fun StepNode(number: Int, step: StudioStepView) {
    val colors = RunovaTheme.colors
    val done = step.state == StudioStepState.DONE
    val active = step.state == StudioStepState.ACTIVE
    Column(Modifier.width(76.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Box(
            Modifier
                .size(28.dp)
                .clip(CircleShape)
                .background(
                    when {
                        done -> colors.primary
                        active -> colors.primary.copy(alpha = 0.16f)
                        else -> colors.foreground.copy(alpha = 0.07f)
                    },
                )
                .border(1.dp, if (active) colors.primary else Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (done) {
                RunovaIcon(RunovaIcons.Check, size = 12.dp, color = colors.primaryForeground)
            } else {
                RunovaText(
                    number.toString(),
                    style = RunovaType.caption,
                    color = if (active) colors.primary else colors.mutedForeground,
                )
            }
        }
        RunovaText(step.label, style = RunovaType.labelStrong, maxLines = 1)
        RunovaText(step.detail, style = RunovaType.caption, color = colors.mutedForeground, maxLines = 1)
    }
}

@Composable
private fun StepLink(on: Boolean, modifier: Modifier) {
    val colors = RunovaTheme.colors
    Box(
        modifier
            .padding(top = 13.dp)
            .height(2.dp)
            .clip(CircleShape)
            .background(if (on) colors.primary else colors.foreground.copy(alpha = 0.12f)),
    )
}

@Composable
private fun ProblemCard(message: String) {
    val colors = RunovaTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.destructive.copy(alpha = 0.1f))
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaIcon(RunovaIcons.Warning, size = 14.dp, color = colors.destructive)
        RunovaText(message, style = RunovaType.small, color = colors.destructive)
    }
}

@Composable
private fun RunCard(run: StudioRunView, animatingAll: Boolean, onStop: () -> Unit) {
    val colors = RunovaTheme.colors
    val motion = motionOn()
    val angle = spin(motion)
    val theme = RunovaTokens.Terminal
    Column(
        Modifier
            .fillMaxWidth()
            .clip(PanelShape)
            .background(colors.primary.copy(alpha = 0.08f))
            .border(1.dp, colors.primary.copy(alpha = 0.35f), PanelShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.rotate(angle)) { RunovaIcon(RunovaIcons.Sparkles, size = 16.dp, color = colors.primary) }
            Column(Modifier.weight(1f)) {
                RunovaText(run.title, style = RunovaType.labelStrong, maxLines = 1)
                RunovaText(
                    if (animatingAll) "${run.detail}, then the next scene" else run.detail,
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                    maxLines = 1,
                )
            }
            RunovaChip("Stop", onClick = onStop, icon = RunovaIcons.Stop, tone = ChipTone.Danger)
        }
        if (run.lines.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(theme.background)
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                run.lines.takeLast(4).forEach {
                    RunovaText(it, style = RunovaType.mono, color = theme.foreground.copy(alpha = 0.82f), maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun ProposalCard(proposal: StudioProposalView, intents: StudioIntents) {
    Column(
        Modifier.fillMaxWidth().runovaGlass().padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaIconTile(RunovaIcons.Sparkles, size = 30.dp)
            RunovaText(proposal.summary, Modifier.weight(1f), RunovaType.labelStrong)
        }
        proposal.changes.forEach { ChangeBlock(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaButton("Discard", onClick = intents.discardProposal, Modifier.weight(1f), kind = ButtonKind.Soft, icon = RunovaIcons.Close)
            RunovaButton("Apply", onClick = intents.applyProposal, Modifier.weight(1f), icon = RunovaIcons.Check)
        }
    }
}

@Composable
private fun ChangeBlock(change: StudioChangeView) {
    val colors = RunovaTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        RunovaText(change.title, style = RunovaType.label)
        change.fields.forEach { field ->
            RunovaSectionTitle(field.label)
            RunovaText(
                field.before,
                style = RunovaType.small.copy(textDecoration = TextDecoration.LineThrough),
                color = colors.mutedForeground,
                maxLines = 3,
            )
            RunovaText(field.after, style = RunovaType.small.copy(fontWeight = FontWeight.Medium), color = colors.primary, maxLines = 4)
        }
    }
}

@Composable
private fun RenderCard(render: StudioRenderView, canFetch: Boolean, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    Column(Modifier.fillMaxWidth().runovaGlass().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RunovaIconTile(
                if (render.state == StudioRenderState.DONE) RunovaIcons.Check else RunovaIcons.Film,
                renderTone(render.state),
                size = 34.dp,
            )
            Column(Modifier.weight(1f)) {
                RunovaText(render.fileName, style = RunovaType.labelStrong, maxLines = 1)
                RunovaText(render.label, style = RunovaType.small, color = colors.mutedForeground, maxLines = 2)
            }
            if (render.canCancel) {
                RunovaChip("Stop", onClick = { intents.cancelRender(render.id) }, icon = RunovaIcons.Stop, tone = ChipTone.Danger)
            }
        }
        render.percent?.let { RunovaProgress(it) }
        if (render.state == StudioRenderState.DONE && canFetch) {
            RunovaButton(
                "Get on this phone",
                onClick = { intents.download(render.id) },
                Modifier.fillMaxWidth(),
                kind = ButtonKind.Soft,
                icon = RunovaIcons.Pull,
            )
        }
    }
}

@Composable
private fun VideoActions(video: StudioVideoView, busy: Boolean, intents: StudioIntents) {
    val animate = video.animateAllLabel
    if (video.scenes.isNotEmpty()) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RunovaChip("Voice", intents.openVoice, icon = RunovaIcons.Mic)
            RunovaChip("Timeline", intents.openTimeline, icon = RunovaIcons.Scenes)
        }
    }
    if (animate == null && !video.canRender) return
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (animate != null) {
            RunovaButton(
                animate,
                onClick = intents.animateAll,
                Modifier.weight(1f),
                kind = ButtonKind.Tint,
                enabled = !busy,
                icon = RunovaIcons.Sparkles,
            )
        }
        if (video.canRender) {
            RunovaButton("Render", onClick = intents.openRender, Modifier.weight(1f), enabled = !busy, icon = RunovaIcons.Video)
        }
    }
}

@Composable
private fun SceneThumbnail(scene: StudioSceneView, aspect: String, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    val ratio = ratioOf(aspect)
    val height = 78.dp
    val width = if (ratio >= 1f) height * ratio else height * 0.75f
    val key = scene.thumbnail.takeIf { scene.thumbnailReady }
    val bitmap = remember(key) {
        key?.let(intents.thumbnail)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }?.asImageBitmap()
    }
    Box(
        Modifier
            .size(width, height)
            .clip(FilmShape)
            .background(
                if (scene.animated) colors.foreground.copy(alpha = 0.08f) else colors.foreground.copy(alpha = 0.05f),
            )
            .border(1.dp, colors.foreground.copy(alpha = 0.1f), FilmShape),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) {
            Image(bitmap, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            RunovaIcon(
                if (scene.animated) RunovaIcons.PlayCircle else RunovaIcons.Image,
                size = 18.dp,
                color = colors.mutedForeground.copy(alpha = 0.7f),
            )
        }
        RunovaText(
            scene.number.toString(),
            Modifier
                .align(Alignment.TopStart)
                .padding(4.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.6f))
                .padding(horizontal = 6.dp),
            RunovaType.caption,
            Color.White,
        )
    }
}

@Composable
private fun SceneCard(scene: StudioSceneView, aspect: String, busy: Boolean, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().runovaGlass().padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SceneThumbnail(scene, aspect, intents)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RunovaText(scene.title, Modifier.weight(1f), RunovaType.labelStrong, maxLines = 1)
                if (scene.voiced) RunovaIcon(RunovaIcons.Mic, size = 10.dp, color = colors.primary)
                RunovaText(scene.durationLabel, style = RunovaType.caption, color = colors.mutedForeground)
            }
            RunovaText(scene.narration, style = RunovaType.small, color = colors.mutedForeground, maxLines = 2)
            if (!scene.animated && scene.canAnimate) {
                Spacer(Modifier.height(2.dp))
                RunovaChip(
                    "Animate",
                    onClick = { intents.animate(scene.id) },
                    icon = RunovaIcons.Sparkles,
                    tone = ChipTone.Primary,
                )
            }
            if (scene.voiced) {
                Spacer(Modifier.height(2.dp))
                RunovaChip("Captions", { intents.caption(scene.id) }, icon = RunovaIcons.Captions)
            }
        }
    }
}

@Composable
private fun AskBar(onAsk: (String) -> Unit) {
    val colors = RunovaTheme.colors
    var text by remember { mutableStateOf("") }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp)
            .clip(CircleShape)
            .background(colors.foreground.copy(alpha = 0.06f))
            .border(1.dp, colors.primary.copy(alpha = 0.28f), CircleShape)
            .padding(start = 16.dp, end = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RunovaIcon(RunovaIcons.Sparkles, size = 13.dp, color = colors.primary)
        Box(Modifier.weight(1f)) {
            if (text.isEmpty()) {
                RunovaText("Ask AI to change something", color = colors.mutedForeground.copy(alpha = 0.75f), maxLines = 1)
            }
            BasicTextField(
                text,
                { text = it },
                Modifier.fillMaxWidth().semantics { contentDescription = "Ask AI to change something" },
                textStyle = RunovaType.body.copy(color = colors.foreground),
                cursorBrush = SolidColor(colors.primary),
                singleLine = true,
            )
        }
        Box(
            Modifier
                .padding(vertical = 5.dp)
                .size(36.dp)
                .clip(CircleShape)
                .background(if (text.isBlank()) colors.foreground.copy(alpha = 0.08f) else colors.primary)
                .clickable(role = Role.Button, enabled = text.isNotBlank()) {
                    onAsk(text.trim())
                    text = ""
                }
                .semantics { contentDescription = "Send" },
            contentAlignment = Alignment.Center,
        ) {
            RunovaIcon(
                RunovaIcons.Send,
                size = 13.dp,
                color = if (text.isBlank()) colors.mutedForeground else colors.primaryForeground,
            )
        }
    }
}

private val QUALITIES = listOf("draft" to "Draft", "standard" to "Standard", "high" to "High", "master" to "Master")

@Composable
private fun RenderSheet(sheet: StudioRenderSheetView, intents: StudioIntents) {
    val colors = RunovaTheme.colors
    val motion = motionOn()
    val glow = pulse(motion && sheet.loading)
    var quality by remember { mutableStateOf(sheet.quality) }
    val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null, onClick = intents.closeRender),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(colors.popover)
                .border(1.dp, colors.foreground.copy(alpha = 0.1f), shape)
                .clickable(interactionSource = null, indication = null) {}
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                RunovaIconTile(RunovaIcons.Video, size = 38.dp)
                RunovaText("Render this video", Modifier.weight(1f), RunovaType.heading)
            }
            RunovaSectionTitle("Quality")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QUALITIES.forEach { (value, label) ->
                    RunovaChip(
                        label,
                        onClick = { quality = value },
                        Modifier.weight(1f),
                        tone = if (value == quality) ChipTone.Primary else ChipTone.Soft,
                    )
                }
            }
            when {
                sheet.loading -> RunovaText(
                    "Working out the size",
                    Modifier.clearAndSetSemantics {},
                    RunovaType.small,
                    colors.mutedForeground.copy(alpha = glow),
                )
                sheet.summary != null -> RunovaText(
                    "At ${sheet.quality}: ${sheet.summary}",
                    style = RunovaType.small,
                    color = colors.mutedForeground,
                )
            }
            sheet.warnings.forEach { RunovaText(it, style = RunovaType.small, color = colors.warning) }
            sheet.problems.forEach { RunovaText(it, style = RunovaType.small, color = colors.destructive) }
            RunovaButton(
                "Render on this computer",
                onClick = { intents.render(quality) },
                Modifier.fillMaxWidth(),
                enabled = !sheet.loading && sheet.problems.isEmpty(),
                icon = RunovaIcons.Video,
            )
            RunovaText(
                "The file stays on this computer. You'll get a notification when it's done.",
                Modifier.fillMaxWidth(),
                RunovaType.caption,
                colors.mutedForeground,
                align = TextAlign.Center,
            )
        }
    }
}
