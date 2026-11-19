package com.runovahq.app.ui

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.runovahq.app.PasskeyPrompt
import com.runovahq.app.PasskeyResult
import com.runovahq.app.design.RunovaTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.PasskeySignInView

private const val OPTIONS = """{"challenge":"AQID","rpId":"runovahq.com"}"""

/** Signing in with a passkey (E115): the button, the wait, and handing the platform's answer to the core. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class PasskeySignInTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: AppIntents = AppIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "systems", {}, intents) } }
    }

    private fun signedOut(passkey: PasskeySignInView? = null) = appView(AuthState.SIGNED_OUT, passkeySignIn = passkey)

    @Test
    fun theSignInScreenOffersAPasskey() {
        var asked = false
        show(signedOut(), AppIntents(signInWithPasskey = { asked = true }))

        compose.onNodeWithText("Use a passkey").performClick()

        assertTrue(asked)
    }

    @Test
    fun itWaitsWhileTheChallengeIsOnItsWay() {
        show(signedOut(PasskeySignInView("", null)))

        compose.onNodeWithText("Waiting for your passkey…").assertIsNotEnabled()
    }

    @Test
    fun theOptionsGoToThePlatformPromptOnce() {
        val prompts = mutableListOf<Pair<String, String>>()
        show(signedOut(PasskeySignInView("challenge-1", OPTIONS)), AppIntents(promptPasskey = { id, json -> prompts += id to json }))

        compose.waitForIdle()

        assertEquals(listOf("challenge-1" to OPTIONS), prompts)
    }

    @Test
    fun anAnswerGoesToTheCoreWithItsChallenge() = runBlocking {
        val calls = mutableListOf<String>()
        val prompt = PasskeyPrompt(
            provider = { json -> PasskeyResult.Answered("""{"id":"AQI","for":$json}""") },
            finish = { id, answer -> calls += "finish $id $answer" },
            cancel = { noPasskey -> calls += "cancel $noPasskey" },
        )

        prompt.answer("challenge-1", OPTIONS)

        assertEquals(listOf("""finish challenge-1 {"id":"AQI","for":$OPTIONS}"""), calls)
    }

    @Test
    fun closingThePromptCancelsQuietly() = runBlocking {
        assertEquals(listOf("cancel false"), outcome(PasskeyResult.Cancelled))
    }

    @Test
    fun noPasskeyOnThePhoneCancelsSoTheCoreCanExplain() = runBlocking {
        assertEquals(listOf("cancel true"), outcome(PasskeyResult.NoPasskey))
    }

    @Test
    fun aPlatformFailureCancelsQuietly() = runBlocking {
        assertEquals(listOf("cancel false"), outcome(PasskeyResult.Failed("provider misconfigured")))
    }

    private suspend fun outcome(result: PasskeyResult): List<String> {
        val calls = mutableListOf<String>()
        PasskeyPrompt(
            provider = { result },
            finish = { id, _ -> calls += "finish $id" },
            cancel = { noPasskey -> calls += "cancel $noPasskey" },
        ).answer("challenge-1", OPTIONS)
        return calls
    }
}
