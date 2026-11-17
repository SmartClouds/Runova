package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.runovahq.app.design.RunovaTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.runova_ffi.AccountScreen
import uniffi.runova_ffi.AutoLock
import uniffi.runova_ffi.BiometricKind
import uniffi.runova_ffi.LockScreen
import uniffi.runova_ffi.PasscodeKind
import uniffi.runova_ffi.PasscodeSettingsScreen
import uniffi.runova_ffi.PasscodeStep
import uniffi.runova_ffi.ProfileView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val account = AccountScreen(
    ProfileView("Sam", "sam@example.com", true), false, emptyList(), emptyList(), emptyList(), emptyList(), null, null,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class PasscodeSettingsTest {
    @get:Rule val compose = createComposeRule()

    private fun show(
        passcode: PasscodeSettingsScreen,
        intents: PasscodeIntents = PasscodeIntents(),
        lock: LockScreen = noLock,
        dark: Boolean = true,
    ) {
        compose.setContent {
            RunovaTheme(dark = dark) {
                AppRoot(
                    appView(account = account, lock = lock, passcode = passcode),
                    "account",
                    {},
                    AppIntents(passcode = intents),
                )
            }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    private val on = LockScreen(true, false, entry(), null, BiometricKind.NONE, null, false)

    @Test
    fun theAccountTabHasASecurityRow() {
        var opened = false
        show(noPasscode, PasscodeIntents(open = { opened = true }))

        compose.onNodeWithText("Passcode lock").performScrollTo().performClick()
        compose.onNodeWithText("Off").assertExists()
        assertTrue(opened)
    }

    @Test
    fun theRowSaysWhenTheLockIsOn() {
        show(noPasscode, lock = on)

        compose.onNodeWithText("Passcode lock").performScrollTo()
        compose.onNodeWithText("On").assertExists()
    }

    @Test
    fun offExplainsAndTurnsItOn() {
        var started: PasscodeKind? = null
        var closed = false
        show(passcodeScreen(step = PasscodeStep.OFF), PasscodeIntents(start = { started = it }, close = { closed = true }))
        snapshot("passcode-off")

        compose.onNodeWithText("Turn passcode on").performClick()
        compose.onNode(hasContentDescription("Back")).performClick()

        assertEquals(PasscodeKind.PIN4, started)
        assertTrue(closed)
    }

    @Test
    fun choosingOffersTheKindsAndTakesDigits() {
        var started: PasscodeKind? = null
        val keys = mutableListOf<Int>()
        show(
            passcodeScreen(step = PasscodeStep.CHOOSE, entry = entry(filled = 1, title = "Choose a passcode")),
            PasscodeIntents(start = { started = it }, key = { keys += it }),
        )
        snapshot("passcode-choose")

        compose.onNodeWithText("Choose a passcode").assertExists()
        compose.onNodeWithText("6-digit code").performClick()
        compose.onNode(hasContentDescription("7")).performClick()

        assertEquals(PasscodeKind.PIN6, started)
        assertEquals(listOf(7), keys)
    }

    @Test
    fun confirmingHidesTheKinds() {
        show(passcodeScreen(step = PasscodeStep.CONFIRM, entry = entry(title = "Enter your new passcode again")))

        compose.onNodeWithText("Enter your new passcode again").assertExists()
        compose.onNodeWithText("6-digit code").assertDoesNotExist()
    }

    @Test
    fun aMismatchIsSaidUnderTheDots() {
        show(
            passcodeScreen(
                step = PasscodeStep.CHOOSE,
                entry = entry(title = "Choose a passcode", error = "Those didn't match. Try again.", shake = 1),
            ),
        )

        compose.onNodeWithText("Those didn't match. Try again.").assertExists()
    }

    @Test
    fun theSettingsChangeAutoLockAndBiometrics() {
        var autoLock: AutoLock? = null
        var biometric: Boolean? = null
        var started: PasscodeKind? = null
        var lockedNow = false
        var off = false
        show(
            passcodeScreen(
                step = PasscodeStep.ON,
                entry = entry(kind = PasscodeKind.PIN6, title = ""),
                biometricLabel = "Fingerprint",
                biometricKind = BiometricKind.FINGERPRINT,
            ),
            PasscodeIntents(
                setAutoLock = { autoLock = it },
                setBiometric = { biometric = it },
                start = { started = it },
                lockNow = { lockedNow = true },
                off = { off = true },
            ),
            lock = on,
        )
        snapshot("passcode-on")

        compose.onNode(hasContentDescription("Unlock with Fingerprint")).performClick()
        compose.onNodeWithText("After 5 minutes").performClick()
        compose.onNodeWithText("Change passcode").performScrollTo().performClick()
        compose.onNodeWithText("Lock now").performScrollTo().performClick()
        compose.onNodeWithText("Turn passcode off").performScrollTo().performClick()

        assertEquals(true, biometric)
        assertEquals(AutoLock.FIVE_MINUTES, autoLock)
        assertEquals(PasscodeKind.PIN6, started)
        assertTrue(lockedNow)
        assertTrue(off)
    }

    @Test
    fun aPhoneWithoutBiometricsHasNoSwitch() {
        show(passcodeScreen(step = PasscodeStep.ON), lock = on, dark = false)
        snapshot("passcode-on-light")

        compose.onNodeWithText("Auto-lock").assertExists()
        compose.onNode(hasContentDescription("Unlock with Fingerprint")).assertDoesNotExist()
    }
}
