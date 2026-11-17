package com.runovahq.app.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.runovahq.app.design.BadgeTone
import com.runovahq.app.design.ButtonKind
import com.runovahq.app.design.ChipTone
import com.runovahq.app.design.RunovaButton
import com.runovahq.app.design.RunovaCard
import com.runovahq.app.design.RunovaChip
import com.runovahq.app.design.RunovaHeroIcon
import com.runovahq.app.design.RunovaIcon
import com.runovahq.app.design.RunovaIconTile
import com.runovahq.app.design.RunovaIcons
import com.runovahq.app.design.RunovaListRow
import com.runovahq.app.design.RunovaScreen
import com.runovahq.app.design.RunovaText
import com.runovahq.app.design.RunovaTextField
import com.runovahq.app.design.RunovaTheme
import com.runovahq.app.design.RunovaToggle
import com.runovahq.app.design.RunovaType
import uniffi.runova_ffi.AutoLock
import uniffi.runova_ffi.BiometricKind
import uniffi.runova_ffi.LockScreen
import uniffi.runova_ffi.PasscodeEntryView
import uniffi.runova_ffi.PasscodeKind
import uniffi.runova_ffi.PasscodeSettingsScreen
import uniffi.runova_ffi.PasscodeStep

/** What the lock screen can ask for. The core decides what each one means. */
data class LockIntents(
    val key: (Int) -> Unit = {},
    val backspace: () -> Unit = {},
    val submit: (String) -> Unit = {},
    val useBiometric: () -> Unit = {},
    val forgot: () -> Unit = {},
    val forgotConfirm: (Boolean) -> Unit = {},
)

/** What the Passcode lock settings can ask for. */
data class PasscodeIntents(
    val open: () -> Unit = {},
    val close: () -> Unit = {},
    val start: (PasscodeKind) -> Unit = {},
    val key: (Int) -> Unit = {},
    val backspace: () -> Unit = {},
    val submit: (String) -> Unit = {},
    val off: () -> Unit = {},
    val setAutoLock: (AutoLock) -> Unit = {},
    val setBiometric: (Boolean) -> Unit = {},
    val lockNow: () -> Unit = {},
)

private val KEY_SIZE = 72.dp
private val LETTERS = mapOf(
    2 to "ABC", 3 to "DEF", 4 to "GHI", 5 to "JKL", 6 to "MNO", 7 to "PQRS", 8 to "TUV", 9 to "WXYZ",
)

private fun noun(kind: PasscodeKind) = if (kind == PasscodeKind.PASSWORD) "password" else "passcode"

private fun biometricIcon(kind: BiometricKind) =
    if (kind == BiometricKind.FACE) RunovaIcons.Face else RunovaIcons.Fingerprint

/** The phone's own check, offered beside the keypad. */
private data class BiometricKey(val label: String, val kind: BiometricKind, val onClick: () -> Unit)

/** Covers the whole app until the passcode or biometrics open it. Nothing behind it is drawn. */
@Composable
fun AppLockScreen(lock: LockScreen, intents: LockIntents) {
    val colors = RunovaTheme.colors
    val biometric = lock.biometricLabel?.let { BiometricKey(it, lock.biometricKind, intents.useBiometric) }
    Box(
        Modifier
            .fillMaxSize()
            .background(colors.background)
            .clickable(interactionSource = null, indication = null) {},
    ) {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))
            RunovaHeroIcon(RunovaIcons.Lock)
            Spacer(Modifier.height(20.dp))
            PasscodeEntry(lock.entry, intents.key, intents.backspace, intents.submit, "Unlock", biometric)
            Spacer(Modifier.weight(1f))
            RunovaText(
                "Forgot ${noun(lock.entry.kind)}?",
                Modifier
                    .padding(top = 12.dp)
                    .clip(CircleShape)
                    .clickable(role = Role.Button, onClick = intents.forgot)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                style = RunovaType.label,
                color = colors.primary,
            )
        }
        if (lock.confirmForgot) ForgotSheet(lock.entry.kind, intents.forgotConfirm)
    }
}

@Composable
private fun ForgotSheet(kind: PasscodeKind, answer: (Boolean) -> Unit) {
    val colors = RunovaTheme.colors
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable(interactionSource = null, indication = null) { answer(false) },
        contentAlignment = Alignment.Center,
    ) {
        RunovaCard(Modifier.padding(24.dp).fillMaxWidth().clickable(interactionSource = null, indication = null) {}) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RunovaText("Forgot your ${noun(kind)}?", style = RunovaType.title)
                RunovaText(
                    "The only way back in is to sign this phone out. The ${noun(kind)} is removed, and you sign " +
                        "in again. Nothing on your computers changes.",
                    color = colors.mutedForeground,
                )
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunovaButton("Cancel", onClick = { answer(false) }, Modifier.weight(1f), kind = ButtonKind.Soft)
                    RunovaButton("Sign out", onClick = { answer(true) }, Modifier.weight(1f), kind = ButtonKind.Danger)
                }
            }
        }
    }
}

/** The title, dots or password field, the line under them and the keypad. */
@Composable
private fun PasscodeEntry(
    entry: PasscodeEntryView,
    onKey: (Int) -> Unit,
    onBackspace: () -> Unit,
    onSubmit: (String) -> Unit,
    submitLabel: String,
    biometric: BiometricKey?,
    /** While choosing a new passcode: switches between a 4-digit, a 6-digit code and a password. */
    onKind: ((PasscodeKind) -> Unit)? = null,
) {
    val colors = RunovaTheme.colors
    val open = entry.waitSeconds == 0u && !entry.busy
    Column(Modifier.widthIn(max = 360.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        RunovaText(entry.title, style = RunovaType.heading, align = TextAlign.Center)
        Spacer(Modifier.height(22.dp))
        if (entry.length > 0u) {
            PinDots(entry.length.toInt(), entry.filled.toInt(), entry.shake, entry.busy)
        } else {
            PasswordField(entry, open, onSubmit, submitLabel)
        }
        RunovaText(
            entry.error.orEmpty(),
            Modifier
                .padding(top = 14.dp)
                .heightIn(min = 18.dp)
                .semantics { liveRegion = LiveRegionMode.Polite },
            style = RunovaType.small,
            color = colors.destructive,
            align = TextAlign.Center,
        )
        if (onKind != null) {
            Spacer(Modifier.height(10.dp))
            KindChoice(entry.kind, onKind)
        }
        Spacer(Modifier.height(20.dp))
        if (entry.length > 0u) {
            Keypad(open, onKey, onBackspace, biometric)
        } else if (biometric != null) {
            RunovaButton(
                "Use ${biometric.label}",
                onClick = biometric.onClick,
                Modifier.semantics { contentDescription = "Unlock with ${biometric.label}" },
                kind = ButtonKind.Soft,
                icon = biometricIcon(biometric.kind),
            )
        }
    }
}

/** One dot a digit. They fill with a spring and shake once for each wrong code. */
@Composable
private fun PinDots(length: Int, filled: Int, shake: ULong, busy: Boolean) {
    val colors = RunovaTheme.colors
    val haptics = LocalHapticFeedback.current
    val offset = remember { Animatable(0f) }
    var seen by remember { mutableStateOf(shake) }
    LaunchedEffect(shake) {
        if (shake == seen) return@LaunchedEffect
        seen = shake
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        offset.animateTo(
            0f,
            keyframes {
                durationMillis = 380
                -14f at 50
                14f at 110
                -10f at 170
                10f at 230
                -4f at 300
            },
        )
    }
    Row(
        Modifier
            .offset(x = offset.value.dp)
            .alpha(if (busy) 0.5f else 1f)
            .clearAndSetSemantics { contentDescription = "$filled of $length digits entered" },
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        repeat(length) { index ->
            val on = index < filled
            val scale by animateFloatAsState(if (on) 1f else 0.82f, spring(dampingRatio = 0.45f), label = "dot")
            Box(
                Modifier
                    .size(14.dp)
                    .scale(scale)
                    .clip(CircleShape)
                    .background(if (on) colors.primary else Color.Transparent)
                    .border(1.5.dp, if (on) colors.primary else colors.foreground.copy(alpha = 0.35f), CircleShape),
            )
        }
    }
}

@Composable
private fun PasswordField(entry: PasscodeEntryView, open: Boolean, onSubmit: (String) -> Unit, submitLabel: String) {
    var text by rememberSaveable { mutableStateOf("") }
    // A wrong password empties the field, as the dots empty for a code.
    LaunchedEffect(entry.shake) { text = "" }
    val send = { if (open && text.isNotEmpty()) onSubmit(text) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        RunovaTextField(
            text,
            { text = it },
            "Password",
            secure = true,
            icon = RunovaIcons.Key,
            label = "Password",
            onDone = send,
        )
        RunovaButton(submitLabel, onClick = send, Modifier.fillMaxWidth(), enabled = open && text.isNotEmpty())
    }
}

@Composable
private fun Keypad(enabled: Boolean, onKey: (Int) -> Unit, onBackspace: () -> Unit, biometric: BiometricKey?) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        for (row in listOf(listOf(1, 2, 3), listOf(4, 5, 6), listOf(7, 8, 9))) {
            Row(horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                row.forEach { DigitKey(it, enabled, onKey) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(22.dp)) {
            if (biometric != null) {
                IconKey(biometricIcon(biometric.kind), "Unlock with ${biometric.label}", true, biometric.onClick)
            } else {
                Spacer(Modifier.size(KEY_SIZE))
            }
            DigitKey(0, enabled, onKey)
            IconKey(RunovaIcons.Backspace, "Delete", enabled, onBackspace)
        }
    }
}

@Composable
private fun DigitKey(digit: Int, enabled: Boolean, onKey: (Int) -> Unit) {
    val colors = RunovaTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        Modifier
            .size(KEY_SIZE)
            .alpha(if (enabled) 1f else 0.35f)
            .clip(CircleShape)
            .background(colors.foreground.copy(alpha = if (pressed) 0.16f else 0.06f))
            .clickable(interaction, null, enabled = enabled, role = Role.Button) { onKey(digit) }
            .semantics(mergeDescendants = true) { contentDescription = "$digit" },
        contentAlignment = Alignment.Center,
    ) {
        Column(Modifier.clearAndSetSemantics {}, horizontalAlignment = Alignment.CenterHorizontally) {
            RunovaText(
                "$digit",
                style = RunovaType.heading.copy(fontSize = 28.sp, lineHeight = 30.sp, fontWeight = FontWeight.Normal),
            )
            val letters = LETTERS[digit]
            if (letters != null) {
                RunovaText(
                    letters,
                    style = RunovaType.caption.copy(fontSize = 9.sp, lineHeight = 10.sp, letterSpacing = 1.5.sp),
                    color = colors.mutedForeground,
                )
            }
        }
    }
}

@Composable
private fun IconKey(icon: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = RunovaTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        Modifier
            .size(KEY_SIZE)
            .alpha(if (enabled) 1f else 0.35f)
            .clip(CircleShape)
            .background(colors.foreground.copy(alpha = if (pressed) 0.1f else 0f))
            .clickable(interaction, null, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        RunovaIcon(icon, size = 26.dp, color = colors.foreground.copy(alpha = 0.85f))
    }
}

/** Passcode lock, opened from the Account tab. */
@Composable
fun PasscodeSettings(screen: PasscodeSettingsScreen, intents: PasscodeIntents) {
    RunovaScreen("Passcode lock", onBack = intents.close) {
        when (screen.step) {
            PasscodeStep.OFF -> PasscodeOff(intents)
            PasscodeStep.ON -> PasscodeOn(screen, intents)
            else -> Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val choosing = screen.step == PasscodeStep.CHOOSE
                PasscodeEntry(
                    screen.entry,
                    intents.key,
                    intents.backspace,
                    intents.submit,
                    if (screen.step == PasscodeStep.VERIFY) "Continue" else "Next",
                    null,
                    onKind = if (choosing) intents.start else null,
                )
            }
        }
    }
}

@Composable
private fun KindChoice(current: PasscodeKind, choose: (PasscodeKind) -> Unit) {
    val kinds = listOf(PasscodeKind.PIN4 to "4-digit code", PasscodeKind.PIN6 to "6-digit code", PasscodeKind.PASSWORD to "Password")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        kinds.forEach { (kind, label) ->
            RunovaChip(
                label,
                { if (kind != current) choose(kind) },
                Modifier.semantics { selected = kind == current },
                tone = if (kind == current) ChipTone.Primary else ChipTone.Soft,
            )
        }
    }
}

@Composable
private fun PasscodeOff(intents: PasscodeIntents) {
    val colors = RunovaTheme.colors
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        RunovaHeroIcon(RunovaIcons.Lock)
        Spacer(Modifier.height(20.dp))
        RunovaText("Lock Runova with a passcode", style = RunovaType.heading, align = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        RunovaText(
            "Runova asks for it each time it opens, and can use your fingerprint or face instead. " +
                "If you forget it, the only way back in is to sign this phone out.",
            Modifier.widthIn(max = 320.dp),
            color = colors.mutedForeground,
            align = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        RunovaButton(
            "Turn passcode on",
            onClick = { intents.start(PasscodeKind.PIN4) },
            Modifier.widthIn(min = 220.dp),
            icon = RunovaIcons.Lock,
        )
    }
}

@Composable
private fun PasscodeOn(screen: PasscodeSettingsScreen, intents: PasscodeIntents) {
    val colors = RunovaTheme.colors
    val kind = screen.entry.kind
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "status") {
            RunovaCard(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    RunovaIconTile(RunovaIcons.Lock, BadgeTone.Success)
                    Column(Modifier.weight(1f)) {
                        RunovaText("Passcode lock is on", style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold))
                        RunovaText(
                            "Runova asks for your ${noun(kind)} when it opens.",
                            style = RunovaType.small,
                            color = colors.mutedForeground,
                        )
                    }
                }
            }
        }
        val biometricLabel = screen.biometricLabel
        if (biometricLabel != null) {
            item(key = "biometric") {
                RunovaCard(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        RunovaIconTile(biometricIcon(screen.biometricKind))
                        Column(Modifier.weight(1f)) {
                            RunovaText("Unlock with $biometricLabel", style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold))
                            RunovaText(
                                "Use it instead of typing the ${noun(kind)}.",
                                style = RunovaType.small,
                                color = colors.mutedForeground,
                            )
                        }
                        RunovaToggle(screen.biometricOn, intents.setBiometric, "Unlock with $biometricLabel")
                    }
                }
            }
        }
        item(key = "auto-lock") { AutoLockCard(screen, intents.setAutoLock) }
        item(key = "change") {
            RunovaListRow("Change ${noun(kind)}", icon = RunovaIcons.Key, onClick = { intents.start(kind) })
        }
        item(key = "lock-now") {
            RunovaListRow("Lock now", icon = RunovaIcons.Lock, onClick = intents.lockNow)
        }
        item(key = "off") {
            RunovaButton(
                "Turn passcode off",
                onClick = intents.off,
                Modifier.fillMaxWidth().padding(top = 4.dp),
                kind = ButtonKind.Danger,
                icon = RunovaIcons.Unlock,
            )
        }
        item(key = "note") {
            RunovaText(
                "If you forget your ${noun(kind)}, the only way back in is to sign this phone out.",
                Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                style = RunovaType.caption,
                color = colors.mutedForeground,
                align = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun AutoLockCard(screen: PasscodeSettingsScreen, choose: (AutoLock) -> Unit) {
    val colors = RunovaTheme.colors
    RunovaCard(Modifier.fillMaxWidth(), padding = PaddingValues(vertical = 12.dp)) {
        Column {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp)) {
                RunovaText("Auto-lock", style = RunovaType.label.copy(fontWeight = FontWeight.SemiBold))
                RunovaText("How long Runova can be away before it locks.", style = RunovaType.small, color = colors.mutedForeground)
            }
            screen.autoLockChoices.forEach { choice ->
                val chosen = choice.value == screen.autoLock
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .clickable(role = Role.RadioButton) { choose(choice.value) }
                        .semantics { selected = chosen }
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RunovaText(choice.label, Modifier.weight(1f), color = if (chosen) colors.foreground else colors.foreground.copy(alpha = 0.85f))
                    if (chosen) RunovaIcon(RunovaIcons.Check, size = 14.dp, color = colors.primary)
                }
            }
        }
    }
}
