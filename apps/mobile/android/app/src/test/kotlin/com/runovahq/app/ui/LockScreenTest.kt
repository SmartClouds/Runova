package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
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
import uniffi.runova_ffi.BiometricKind
import uniffi.runova_ffi.LockScreen
import uniffi.runova_ffi.PasscodeKind
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
class LockScreenTest {
    @get:Rule val compose = createComposeRule()

    private fun show(lock: LockScreen, intents: LockIntents = LockIntents(), dark: Boolean = true) {
        compose.setContent {
            RunovaTheme(dark = dark) {
                AppRoot(appView(account = account, lock = lock), "account", {}, AppIntents(lock = intents))
            }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theKeypadSendsDigitsAndDeletes() {
        val keys = mutableListOf<Int>()
        var deleted = 0
        show(locked(entry(filled = 2)), LockIntents(key = { keys += it }, backspace = { deleted++ }))
        snapshot("lock-pin")

        compose.onNodeWithText("Enter your passcode").assertExists()
        compose.onNode(hasContentDescription("5")).performClick()
        compose.onNode(hasContentDescription("0")).performClick()
        compose.onNode(hasContentDescription("Delete")).performClick()

        assertEquals(listOf(5, 0), keys)
        assertEquals(1, deleted)
    }

    @Test
    fun nothingBehindTheLockIsDrawn() {
        show(locked())

        compose.onNodeWithText("sam@example.com").assertDoesNotExist()
    }

    @Test
    fun aSixDigitCodeShowsSixDots() {
        show(locked(entry(kind = PasscodeKind.PIN6, filled = 4)), dark = false)
        snapshot("lock-pin6-light")

        compose.onNode(hasContentDescription("4 of 6 digits entered")).assertExists()
    }

    @Test
    fun theBiometricKeyShowsOnlyWhenItCanBeUsed() {
        var asked = false
        show(
            locked(biometricLabel = "Face unlock", biometricKind = BiometricKind.FACE),
            LockIntents(useBiometric = { asked = true }),
        )
        snapshot("lock-biometric")

        compose.onNode(hasContentDescription("Unlock with Face unlock")).performClick()
        assertTrue(asked)
    }

    @Test
    fun withoutBiometricsThereIsNoBiometricKey() {
        show(locked())

        compose.onNode(hasContentDescription("Unlock with Fingerprint")).assertDoesNotExist()
        compose.onNode(hasContentDescription("Unlock with Face unlock")).assertDoesNotExist()
    }

    @Test
    fun duringAWaitTheKeypadIsOff() {
        val keys = mutableListOf<Int>()
        show(
            locked(entry(error = "Try again in 0:28", waitSeconds = 28, shake = 5)),
            LockIntents(key = { keys += it }),
        )
        snapshot("lock-wait")

        compose.onNodeWithText("Try again in 0:28").assertExists()
        compose.onNode(hasContentDescription("5")).performClick()
        assertEquals(emptyList<Int>(), keys)
    }

    @Test
    fun aPasswordIsTypedAndSent() {
        var sent: String? = null
        show(
            locked(entry(kind = PasscodeKind.PASSWORD, title = "Enter your password")),
            LockIntents(submit = { sent = it }),
        )
        snapshot("lock-password")

        compose.onNode(hasSetTextAction()).performTextInput("correct horse")
        compose.onNodeWithText("Unlock").performClick()

        assertEquals("correct horse", sent)
    }

    @Test
    fun forgotAsksBeforeSigningOut() {
        var forgot = false
        show(locked(), LockIntents(forgot = { forgot = true }))
        compose.onNodeWithText("Forgot passcode?").performClick()
        assertTrue(forgot)
    }

    @Test
    fun theForgotQuestionSignsOutOrGoesBack() {
        val answers = mutableListOf<Boolean>()
        show(locked(confirmForgot = true), LockIntents(forgotConfirm = { answers += it }))
        snapshot("lock-forgot")

        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Sign out").performClick()

        assertEquals(listOf(false, true), answers)
    }
}
