package com.runovahq.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.RunovaBadge
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaTopBar
import com.runovahq.app.design.RunovaType
import kotlin.math.abs
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.RemoteKey
import uniffi.runova_ffi.RemotePhase
import uniffi.runova_ffi.RemotePointer
import uniffi.runova_ffi.RemoteView

/** What the remote screen can ask for. Sending and copying clipboards goes through the OS, so it is native. */
data class RemoteIntents(
    val frames: RemoteFrames? = null,
    val open: (Long) -> Unit = {},
    val close: () -> Unit = {},
    val submitPassword: (String) -> Unit = {},
    val usePassword: () -> Unit = {},
    val pointer: (RemotePointer) -> Unit = {},
    val text: (String) -> Unit = {},
    val key: (RemoteKey) -> Unit = {},
    val sendClipboard: () -> Unit = {},
    val copyClipboard: (String) -> Unit = {},
    val clipboardTaken: () -> Unit = {},
    val dismissNote: () -> Unit = {},
)

private const val LONG_PRESS_MS = 500L
private const val LARGEST_ZOOM = 5f
private const val ZOOM_NOTICEABLE = 0.01f

/** Where the computer's screen sits inside the viewer, in the viewer's pixels. */
internal data class ContentRect(val left: Float, val top: Float, val width: Float, val height: Float) {
    /** A point in the viewer as a position on the computer's screen, from 0 to 1. */
    fun normalized(x: Float, y: Float): Pair<Double, Double> =
        ((x - left) / width).toDouble().coerceIn(0.0, 1.0) to ((y - top) / height).toDouble().coerceIn(0.0, 1.0)
}

/** Fits the computer's screen in the viewer, then applies the phone's own zoom and pan. */
internal fun fitContent(
    boxWidth: Float,
    boxHeight: Float,
    screenWidth: Float,
    screenHeight: Float,
    zoom: Float,
    panX: Float,
    panY: Float,
): ContentRect {
    if (screenWidth <= 0f || screenHeight <= 0f) return ContentRect(0f, 0f, boxWidth, boxHeight)
    val fit = minOf(boxWidth / screenWidth, boxHeight / screenHeight)
    val width = screenWidth * fit * zoom
    val height = screenHeight * fit * zoom
    val left = placeAlong(boxWidth, width, panX)
    val top = placeAlong(boxHeight, height, panY)
    return ContentRect(left, top, width, height)
}

/** Centred along one side; once zoomed past the viewer, the pan moves it, within the edges. */
private fun placeAlong(box: Float, content: Float, pan: Float): Float {
    val centred = (box - content) / 2
    return if (content <= box) centred else (centred + pan).coerceIn(box - content, 0f)
}

private fun roomToPan(box: Int, content: Float) = maxOf(0f, (content - box) / 2)

private val ShortcutKeys = listOf(
    "Esc" to RemoteKey.ESCAPE,
    "Tab" to RemoteKey.TAB,
    "Backspace" to RemoteKey.BACKSPACE,
    "Del" to RemoteKey.DELETE,
    "Up" to RemoteKey.UP,
    "Down" to RemoteKey.DOWN,
    "Left" to RemoteKey.LEFT,
    "Right" to RemoteKey.RIGHT,
    "Home" to RemoteKey.HOME,
    "End" to RemoteKey.END,
    "Page up" to RemoteKey.PAGE_UP,
    "Page down" to RemoteKey.PAGE_DOWN,
    "Ctrl C" to RemoteKey.CTRL_C,
    "Ctrl V" to RemoteKey.CTRL_V,
    "Ctrl Z" to RemoteKey.CTRL_Z,
    "Ctrl A" to RemoteKey.CTRL_A,
    "Alt Tab" to RemoteKey.ALT_TAB,
    "Alt F4" to RemoteKey.ALT_F4,
    "Win" to RemoteKey.WINDOWS,
)

/** What a computer's "Remote" section shows while its screen is not open yet. */
@Composable
fun RemoteTab(connection: ConnectionView, intents: RemoteIntents) {
    val colors = RunovaTheme.colors
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) {
        RunovaIcon(RunovaIcons.Remote, size = 36.dp, color = colors.primary)
        RunovaText("Remote", style = RunovaType.title, align = TextAlign.Center)
        RunovaText(
            "See and use ${connection.systemName}'s screen. The rest of this computer's tools pause until you close it.",
            color = colors.mutedForeground,
            align = TextAlign.Center,
        )
        RunovaButton("Open screen", onClick = { intents.open(connection.systemId) })
    }
}

/** A whole-screen takeover: connecting, asking for a password, or the computer's screen. */
@Composable
fun RemoteViewerScreen(view: RemoteView, intents: RemoteIntents) {
    when (view.phase) {
        RemotePhase.LIVE -> LiveViewer(view, intents)
        RemotePhase.NEEDS_PASSWORD -> PasswordPrompt(view, intents)
        RemotePhase.FAILED -> RemoteMessage(view, failed = true, intents)
        else -> RemoteMessage(view, failed = false, intents)
    }
}

private fun waitingText(view: RemoteView) = when (view.phase) {
    RemotePhase.REQUESTING -> "Reaching ${view.systemName}" to "Asking Runova where it is."
    RemotePhase.WAITING_FOR_APPROVAL -> "Waiting at ${view.systemName}" to "Someone at that computer has to say yes."
    RemotePhase.CONNECTING -> "Connecting" to "Looking for the way to ${view.systemName}."
    RemotePhase.SECURING -> "Securing the connection" to "Checking it really is ${view.systemName}."
    RemotePhase.FAILED -> "Couldn't open the screen" to (view.error ?: "Something went wrong.")
    else -> view.systemName to ""
}

@Composable
private fun RemoteMessage(view: RemoteView, failed: Boolean, intents: RemoteIntents) {
    val colors = RunovaTheme.colors
    val (title, detail) = waitingText(view)
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(view.systemName, onBack = intents.close)
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        ) {
            RunovaIcon(
                if (failed) RunovaIcons.Warning else RunovaIcons.Remote,
                size = 36.dp,
                color = if (failed) colors.destructive else colors.primary,
            )
            RunovaText(title, style = RunovaType.title, align = TextAlign.Center)
            RunovaText(detail, color = colors.mutedForeground, align = TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            if (failed) {
                RunovaButton("Back", onClick = intents.close, kind = ButtonKind.Soft)
            } else if (view.canUsePassword) {
                RunovaButton("Use password instead", onClick = intents.usePassword, kind = ButtonKind.Soft)
            }
        }
    }
}

@Composable
private fun PasswordPrompt(view: RemoteView, intents: RemoteIntents) {
    val colors = RunovaTheme.colors
    var password by remember(view.systemId) { mutableStateOf("") }
    val submit = {
        if (password.isNotEmpty()) {
            intents.submitPassword(password)
            password = ""
        }
    }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(view.systemName, onBack = intents.close)
        Column(
            Modifier.weight(1f).fillMaxWidth().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            RunovaText("Enter this computer's password", style = RunovaType.title)
            RunovaText(
                "The password set for unattended access on ${view.systemName}.",
                color = colors.mutedForeground,
            )
            RunovaTextField(password, { password = it }, "Password", secure = true)
            view.error?.let {
                RunovaText(it, style = RunovaType.small, color = colors.destructive)
            }
            RunovaButton("Connect", onClick = submit, modifier = Modifier.fillMaxWidth(), enabled = password.isNotEmpty())
        }
    }
}

@Composable
private fun LiveViewer(view: RemoteView, intents: RemoteIntents) {
    var keyboardOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        RunovaTopBar(
            view.systemName,
            onBack = intents.close,
            trailing = {
                RunovaBadge(
                    when {
                        view.agent -> "Agent"
                        view.direct == true -> "Direct"
                        else -> "Relay"
                    },
                    if (view.direct == true) BadgeTone.Primary else BadgeTone.Warning,
                    Modifier.padding(end = 8.dp),
                )
            },
        )
        ScreenCanvas(view, intents, Modifier.weight(1f).fillMaxWidth())
        view.clipboard?.let { ClipboardBar(it, intents) }
        view.note?.let { Note(it, intents.dismissNote) }
        if (keyboardOpen) KeyboardPanel(intents)
        Toolbar(keyboardOpen, { keyboardOpen = !keyboardOpen }, intents)
    }
}

@Composable
private fun ToolButton(icon: String, label: String, onClick: () -> Unit, active: Boolean = false) {
    val colors = RunovaTheme.colors
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(if (active) colors.primary else colors.secondary)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        RunovaIcon(icon, size = 16.dp, color = if (active) colors.primaryForeground else colors.secondaryForeground)
    }
}

@Composable
private fun Toolbar(keyboardOpen: Boolean, onKeyboard: () -> Unit, intents: RemoteIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().background(colors.card).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ToolButton(RunovaIcons.Keyboard, "Keyboard", onKeyboard, active = keyboardOpen)
        ToolButton(RunovaIcons.Copy, "Send clipboard", intents.sendClipboard)
        Spacer(Modifier.weight(1f))
        RunovaButton("Close", onClick = intents.close, kind = ButtonKind.Soft, icon = RunovaIcons.Close)
    }
}

@Composable
private fun KeyboardPanel(intents: RemoteIntents) {
    val colors = RunovaTheme.colors
    var text by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxWidth().background(colors.card).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ShortcutKeys.forEach { (label, key) -> RunovaChip(label, { intents.key(key) }) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            RunovaTextField(text, { text = it }, "Type on the computer", Modifier.weight(1f))
            RunovaButton(
                "Send",
                onClick = {
                    if (text.isNotEmpty()) intents.text(text)
                    intents.key(RemoteKey.ENTER)
                    text = ""
                },
                icon = RunovaIcons.Send,
            )
        }
    }
}

@Composable
private fun ClipboardBar(text: String, intents: RemoteIntents) {
    val colors = RunovaTheme.colors
    Row(
        Modifier.fillMaxWidth().background(colors.secondary).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RunovaText("The computer shared its clipboard.", Modifier.weight(1f), style = RunovaType.small, maxLines = 1)
        RunovaChip("Copy", { intents.copyClipboard(text) })
        RunovaChip("Ignore", intents.clipboardTaken)
    }
}

@Composable
private fun Note(message: String, onDismiss: () -> Unit) {
    val colors = RunovaTheme.colors
    RunovaText(
        message,
        Modifier
            .fillMaxWidth()
            .background(colors.secondary)
            .clickable(role = Role.Button, onClick = onDismiss)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        style = RunovaType.small,
    )
}

/** The computer's screen, in the middle, and all touches on it. */
@Composable
private fun ScreenCanvas(view: RemoteView, intents: RemoteIntents, modifier: Modifier) {
    val frames = intents.frames
    val bitmap = frames?.bitmap
    var zoom by remember { mutableFloatStateOf(1f) }
    var panX by remember { mutableFloatStateOf(0f) }
    var panY by remember { mutableFloatStateOf(0f) }
    val current by rememberUpdatedState(view)
    val latestPointer by rememberUpdatedState(intents.pointer)
    val rect = { size: IntSize ->
        fitContent(size.width.toFloat(), size.height.toFloat(), current.width.toFloat(), current.height.toFloat(), zoom, panX, panY)
    }
    Box(
        modifier
            .clipToBounds()
            .background(Color.Black)
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = down.position
                    var last = start
                    var dragging = false
                    var twoFingers = false
                    var longPressed = false
                    var pressed = true
                    while (pressed) {
                        val event = if (!dragging && !twoFingers && !longPressed) {
                            withTimeoutOrNull(LONG_PRESS_MS) { awaitPointerEvent(PointerEventPass.Main) }
                        } else {
                            awaitPointerEvent(PointerEventPass.Main)
                        }
                        if (event == null) {
                            longPressed = true
                            val (x, y) = rect(size).normalized(start.x, start.y)
                            latestPointer(RemotePointer.RightTap(x, y))
                            continue
                        }
                        val active = event.changes.filter { it.pressed }
                        pressed = active.isNotEmpty()
                        if (active.size >= 2) {
                            twoFingers = true
                            val zoomChange = event.calculateZoom()
                            val pan = event.calculatePan()
                            if (abs(zoomChange - 1f) > ZOOM_NOTICEABLE) {
                                zoom = (zoom * zoomChange).coerceIn(1f, LARGEST_ZOOM)
                            }
                            if (zoom > 1.02f) {
                                val placed = rect(size)
                                panX = (panX + pan.x).coerceIn(-roomToPan(size.width, placed.width), roomToPan(size.width, placed.width))
                                panY = (panY + pan.y).coerceIn(-roomToPan(size.height, placed.height), roomToPan(size.height, placed.height))
                            } else {
                                val centroid = event.calculateCentroid(useCurrent = true)
                                val (x, y) = rect(size).normalized(centroid.x, centroid.y)
                                latestPointer(
                                    RemotePointer.Scroll(x, y, (pan.x / density).toDouble(), (pan.y / density).toDouble()),
                                )
                            }
                            event.changes.forEach { it.consume() }
                            continue
                        }
                        val finger = active.firstOrNull() ?: event.changes.firstOrNull() ?: continue
                        if (!twoFingers && pressed) {
                            last = finger.position
                            val moved = (finger.position - start).getDistance()
                            if (!dragging && moved > viewConfiguration.touchSlop && !longPressed) {
                                dragging = true
                                val (x, y) = rect(size).normalized(start.x, start.y)
                                latestPointer(RemotePointer.DragStart(x, y))
                            }
                            if (dragging && finger.positionChange() != Offset.Zero) {
                                val (x, y) = rect(size).normalized(finger.position.x, finger.position.y)
                                latestPointer(RemotePointer.DragMove(x, y))
                            }
                        }
                        finger.consume()
                    }
                    val (x, y) = rect(size).normalized(last.x, last.y)
                    when {
                        dragging -> latestPointer(RemotePointer.DragEnd(x, y))
                        !twoFingers && !longPressed -> latestPointer(RemotePointer.Tap(x, y))
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap == null) {
            RunovaText("Waiting for the screen", color = RunovaTheme.colors.mutedForeground)
        } else {
            Canvas(Modifier.fillMaxSize().semantics { contentDescription = "Remote screen" }) {
                // Reading it here redraws the screen each time tiles land.
                frames.revision
                val placed = fitContent(size.width, size.height, bitmap.width.toFloat(), bitmap.height.toFloat(), zoom, panX, panY)
                drawImage(
                    bitmap.asImageBitmap(),
                    dstOffset = IntOffset(placed.left.toInt(), placed.top.toInt()),
                    dstSize = IntSize(placed.width.toInt(), placed.height.toInt()),
                    filterQuality = FilterQuality.Low,
                )
            }
        }
    }
}
