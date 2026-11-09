package com.runovahq.app.ui

import android.provider.Settings
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.runovahq.app.R
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaHeroIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaProgress
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTokens
import com.runovahq.app.design.RunovaType
import com.runovahq.app.design.runovaGlass
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Set by tests, so a screenshot is always the finished picture. */
val LocalMotion = compositionLocalOf<Boolean?> { null }

/** Whether to animate, which the phone's own setting can turn off. */
@Composable
fun motionOn(): Boolean {
    val forced = LocalMotion.current
    val context = LocalContext.current
    val setting = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }
    return forced ?: setting
}

/** The app's mark, in the version drawn for this theme. */
@Composable
fun RunovaLogo(size: Dp, modifier: Modifier = Modifier) {
    val dark = RunovaTheme.colors.background.luminance() < 0.5f
    Image(
        painterResource(if (dark) R.drawable.runova_logo else R.drawable.runova_logo_light),
        "Runova",
        modifier.size(size),
    )
}

@Composable
private fun swing(motion: Boolean, from: Float, to: Float, millis: Int): Float {
    if (!motion) return to
    val transition = rememberInfiniteTransition(label = "swing")
    val value by transition.animateFloat(
        from,
        to,
        infiniteRepeatable(tween(millis, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "swing value",
    )
    return value
}

@Composable
private fun flow(motion: Boolean, millis: Int): Float {
    if (!motion) return 0.3f
    val transition = rememberInfiniteTransition(label = "flow")
    val value by transition.animateFloat(
        0f,
        1f,
        infiniteRepeatable(tween(millis, easing = LinearEasing)),
        label = "flow value",
    )
    return value
}

/** Lifts a piece of a page into place each time the page comes round. */
@Composable
private fun rise(active: Boolean, motion: Boolean, delayMillis: Int): Modifier {
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(active) { started = active }
    val progress by animateFloatAsState(
        if (!motion || started) 1f else 0f,
        tween(520, delayMillis, FastOutSlowInEasing),
        label = "rise",
    )
    return Modifier.graphicsLayer {
        alpha = progress
        translationY = (1f - progress) * 16.dp.toPx()
    }
}

/** A soft light behind the page, in the app's accent. */
@Composable
private fun Aurora(motion: Boolean) {
    val primary = RunovaTheme.colors.primary
    val drift = swing(motion, 0f, 1f, 7000)
    Canvas(Modifier.fillMaxSize()) {
        val width = size.width
        val height = size.height
        drawRect(
            Brush.radialGradient(
                listOf(primary.copy(alpha = 0.26f), Color.Transparent),
                Offset(width * (0.22f + 0.5f * drift), height * 0.2f),
                width * 0.95f,
            ),
        )
        drawRect(
            Brush.radialGradient(
                listOf(primary.copy(alpha = 0.1f), Color.Transparent),
                Offset(width * (0.9f - 0.5f * drift), height * 0.56f),
                width * 0.8f,
            ),
        )
    }
}

/** What fills the screen while the app gets going. */
@Composable
fun RunovaSplash() {
    val motion = motionOn()
    val scale = swing(motion, 0.94f, 1f, 1400)
    val glow = swing(motion, 0.65f, 1f, 1400)
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Aurora(motion)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier.graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    alpha = glow
                },
            ) { RunovaLogo(132.dp) }
            Spacer(Modifier.height(12.dp))
            RunovaText("Runova", style = RunovaType.heading)
        }
    }
}

private data class IntroPage(val title: String, val detail: String)

private val IntroPages = listOf(
    IntroPage(
        "Every computer, in your pocket",
        "See which of your machines are online and step into any of them, from anywhere.",
    ),
    IntroPage(
        "Your agents, one tap away",
        "Follow Claude Code, Codex and your shells as they run, and answer the moment one needs you.",
    ),
    IntroPage(
        "Ship from wherever you are",
        "Review a diff, commit, restart a container or rerun a pipeline. When something breaks, your phone hears first.",
    ),
    IntroPage(
        "Private by design",
        "Your phone connects straight to your computer whenever it can, and anything relayed stays end-to-end encrypted.",
    ),
)

/** The welcome a new install opens on. Always dark, because the art is lit from behind. */
@Composable
fun IntroScreen(onDone: () -> Unit, startPage: Int = 0) {
    RunovaTheme(dark = true) {
        val colors = RunovaTheme.colors
        val motion = motionOn()
        val pager = rememberPagerState(startPage) { IntroPages.size }
        val scope = rememberCoroutineScope()
        val last = pager.currentPage == IntroPages.lastIndex
        Box(Modifier.fillMaxSize().background(colors.background)) {
            Aurora(motion)
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RunovaLogo(30.dp)
                    Spacer(Modifier.width(6.dp))
                    RunovaText("Runova", Modifier.weight(1f), RunovaType.labelStrong)
                    if (!last) RunovaChip("Skip", onClick = onDone)
                }
                HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth()) { page ->
                    val active = page == pager.currentPage
                    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(
                            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 28.dp).clearAndSetSemantics {},
                            contentAlignment = Alignment.Center,
                        ) {
                            when (page) {
                                0 -> DevicesArt(active, motion)
                                1 -> TerminalArt(active, motion)
                                2 -> ShipArt(active, motion)
                                else -> PrivateArt(active, motion)
                            }
                        }
                        RunovaText(
                            IntroPages[page].title,
                            Modifier.padding(horizontal = 28.dp),
                            RunovaType.heading,
                            align = TextAlign.Center,
                        )
                        Spacer(Modifier.height(10.dp))
                        RunovaText(
                            IntroPages[page].detail,
                            Modifier.padding(horizontal = 32.dp).heightIn(min = 72.dp),
                            color = colors.mutedForeground,
                            align = TextAlign.Center,
                        )
                    }
                }
                PageDots(pager.currentPage, IntroPages.size)
                RunovaButton(
                    if (last) "Get started" else "Next",
                    onClick = {
                        if (last) onDone() else scope.launch { pager.animateScrollToPage(pager.currentPage + 1) }
                    },
                    Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 24.dp),
                    icon = RunovaIcons.Forward,
                )
            }
        }
    }
}

@Composable
private fun PageDots(current: Int, count: Int) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 18.dp).clearAndSetSemantics {},
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
    ) {
        repeat(count) { index ->
            val on = index == current
            val width by animateDpAsState(if (on) 24.dp else 6.dp, tween(260), label = "dot")
            Box(
                Modifier
                    .height(6.dp)
                    .width(width)
                    .clip(CircleShape)
                    .background(if (on) colors.primary else colors.foreground.copy(alpha = 0.2f)),
            )
        }
    }
}

@Composable
private fun ArtRow(
    icon: String,
    tone: BadgeTone,
    title: String,
    detail: String,
    badge: String,
    badgeTone: BadgeTone,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth().runovaGlass().padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RunovaIconTile(icon, tone, size = 36.dp)
        Column(Modifier.weight(1f)) {
            RunovaText(title, style = RunovaType.labelStrong, maxLines = 1)
            RunovaText(detail, style = RunovaType.small, color = RunovaTheme.colors.mutedForeground, maxLines = 1)
        }
        RunovaBadge(badge, badgeTone, dot = true)
    }
}

@Composable
private fun DevicesArt(active: Boolean, motion: Boolean) {
    val float = swing(motion, -5f, 5f, 3200)
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.padding(bottom = 8.dp).graphicsLayer { translationY = float.dp.toPx() }) { RunovaLogo(136.dp) }
        ArtRow(
            RunovaIcons.Systems, BadgeTone.Primary, "Studio PC", "Windows, 3 agents running",
            "Online", BadgeTone.Success, rise(active, motion, 120),
        )
        ArtRow(
            RunovaIcons.Systems, BadgeTone.Primary, "MacBook Pro", "macOS",
            "Online", BadgeTone.Success, rise(active, motion, 240).padding(horizontal = 10.dp),
        )
        ArtRow(
            RunovaIcons.Server, BadgeTone.Neutral, "Build server", "Linux",
            "Offline", BadgeTone.Neutral, rise(active, motion, 360).padding(horizontal = 20.dp),
        )
    }
}

private data class TerminalLine(val text: String, val strong: Boolean = false)

private val TerminalLines = listOf(
    TerminalLine("> Fix the login redirect", true),
    TerminalLine("Reading auth/session.ts"),
    TerminalLine("Edited 2 files"),
    TerminalLine("All 243 tests passed", true),
)

@Composable
private fun TerminalArt(active: Boolean, motion: Boolean) {
    val colors = RunovaTheme.colors
    val theme = RunovaTokens.Terminal
    var shown by remember { mutableIntStateOf(TerminalLines.size) }
    LaunchedEffect(active, motion) {
        if (!active || !motion) {
            shown = TerminalLines.size
            return@LaunchedEffect
        }
        while (true) {
            shown = 0
            for (line in 1..TerminalLines.size) {
                delay(700)
                shown = line
            }
            delay(2800)
        }
    }
    val asking by animateFloatAsState(if (shown == TerminalLines.size) 1f else 0f, tween(320), label = "asking")
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(theme.background)
                .border(1.dp, colors.foreground.copy(alpha = 0.12f), shape)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(colors.destructive, colors.warning, colors.primary).forEach {
                    Box(Modifier.size(9.dp).clip(CircleShape).background(it))
                }
                RunovaText(
                    "claude",
                    Modifier.weight(1f).padding(start = 8.dp),
                    RunovaType.small,
                    colors.mutedForeground,
                )
                RunovaBadge(if (asking > 0.5f) "Needs input" else "Working", if (asking > 0.5f) BadgeTone.Warning else BadgeTone.Primary, dot = true)
            }
            Spacer(Modifier.height(4.dp))
            TerminalLines.forEachIndexed { index, line ->
                val seen by animateFloatAsState(if (index < shown) 1f else 0f, tween(220), label = "line")
                RunovaText(
                    line.text,
                    Modifier.alpha(seen),
                    RunovaType.mono,
                    if (line.strong) theme.foreground else colors.mutedForeground,
                    maxLines = 1,
                )
            }
        }
        ArtRow(
            RunovaIcons.Agent, BadgeTone.Warning, "Apply this change?", "Claude Code is waiting",
            "Yes", BadgeTone.Primary, Modifier.alpha(asking),
        )
    }
}

@Composable
private fun ShipArt(active: Boolean, motion: Boolean) {
    val colors = RunovaTheme.colors
    var done by remember { mutableIntStateOf(2) }
    LaunchedEffect(active, motion) {
        if (!active || !motion) {
            done = 2
            return@LaunchedEffect
        }
        while (true) {
            done = 0
            delay(900)
            done = 1
            delay(900)
            done = 2
            delay(1400)
            done = 3
            delay(2600)
        }
    }
    val percent by animateFloatAsState((done * 32 + 4).coerceAtMost(100).toFloat(), tween(700), label = "deploy")
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(
            Modifier.fillMaxWidth().runovaGlass().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaIconTile(RunovaIcons.Git, size = 30.dp)
                RunovaText("main", Modifier.weight(1f), RunovaType.labelStrong)
                RunovaText("2 commits ahead", style = RunovaType.small, color = colors.mutedForeground)
            }
            Row(verticalAlignment = Alignment.Top) {
                PipelineStep("Build", 0, done)
                PipelineLink(done > 0, Modifier.weight(1f))
                PipelineStep("Test", 1, done)
                PipelineLink(done > 1, Modifier.weight(1f))
                PipelineStep("Deploy", 2, done)
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row {
                    RunovaText("Deploying to production", Modifier.weight(1f), RunovaType.small, colors.mutedForeground)
                    RunovaText("${percent.toInt()}%", style = RunovaType.small)
                }
                RunovaProgress(percent.toDouble())
            }
        }
        ArtRow(
            RunovaIcons.Deploy, BadgeTone.Success, "web-1", "Restarted just now",
            "Running", BadgeTone.Success, rise(active, motion, 200),
        )
    }
}

@Composable
private fun PipelineStep(label: String, index: Int, done: Int) {
    val finished = index < done
    val running = index == done
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RunovaIconTile(
            when {
                finished -> RunovaIcons.Check
                running -> RunovaIcons.Bolt
                else -> RunovaIcons.Clock
            },
            when {
                finished -> BadgeTone.Success
                running -> BadgeTone.Primary
                else -> BadgeTone.Neutral
            },
            size = 44.dp,
        )
        RunovaText(label, style = RunovaType.caption, color = RunovaTheme.colors.mutedForeground)
    }
}

@Composable
private fun PipelineLink(on: Boolean, modifier: Modifier) {
    val colors = RunovaTheme.colors
    Box(
        modifier
            .padding(start = 6.dp, end = 6.dp, top = 21.dp)
            .height(2.dp)
            .clip(CircleShape)
            .background(if (on) colors.primary else colors.foreground.copy(alpha = 0.12f)),
    )
}

@Composable
private fun PrivateArt(active: Boolean, motion: Boolean) {
    val colors = RunovaTheme.colors
    val travel = flow(motion, 1800)
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        RunovaHeroIcon(RunovaIcons.Shield)
        Spacer(Modifier.height(32.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            RunovaIconTile(RunovaIcons.Mobile, size = 68.dp)
            Canvas(Modifier.weight(1f).height(24.dp).padding(horizontal = 10.dp)) {
                val middle = size.height / 2
                drawLine(
                    colors.foreground.copy(alpha = 0.22f),
                    Offset(0f, middle),
                    Offset(size.width, middle),
                    2.dp.toPx(),
                    StrokeCap.Round,
                    PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 7.dp.toPx())),
                )
                repeat(3) { index ->
                    val place = (travel + index / 3f) % 1f
                    drawCircle(colors.primary, 4.dp.toPx(), Offset(size.width * place, middle))
                }
            }
            RunovaIconTile(RunovaIcons.Systems, size = 68.dp)
        }
        Spacer(Modifier.height(24.dp))
        Row(rise(active, motion, 160), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RunovaBadge("Direct", BadgeTone.Primary, dot = true)
            RunovaBadge("End-to-end encrypted", BadgeTone.Success, dot = true)
        }
    }
}
