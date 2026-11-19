package com.runovahq.app.ui

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.runovahq.app.GooglePrompt
import com.runovahq.app.GoogleResult
import com.runovahq.app.design.RunovaTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ProviderSignInView

private const val CLIENT = "web.apps.googleusercontent.com"

/**
 * Continue with Google, Apple or Microsoft (E117): Google through the phone's own sheet, the other
 * two through the browser sign-in, which goes straight to that provider.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class ProviderSignInTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: AppIntents = AppIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "systems", {}, intents) } }
    }

    private fun signedOut(sheet: ProviderSignInView? = null, continueInBrowser: String? = null) =
        appView(AuthState.SIGNED_OUT, providerSignIn = sheet, continueInBrowser = continueInBrowser)

    @Test
    fun googleUsesThePhonesOwnSheetAndTheOthersTheBrowser() {
        val calls = mutableListOf<String>()
        show(
            signedOut(),
            AppIntents(
                signInWithProvider = { calls += "sheet $it" },
                signInInBrowser = { calls += "browser $it" },
            ),
        )

        compose.onNodeWithText("Continue with Google").performScrollTo().performClick()
        compose.onNodeWithText("Continue with Apple").performScrollTo().performClick()
        compose.onNodeWithText("Continue with Microsoft").performScrollTo().performClick()

        assertEquals(listOf("sheet google", "browser apple", "browser microsoft"), calls)
    }

    @Test
    fun itWaitsWhileTheNonceIsOnItsWay() {
        show(signedOut(ProviderSignInView("google", null, null)))

        compose.onNodeWithText("Waiting for Google…").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun theNonceGoesToGooglesSheetOnce() {
        val sheets = mutableListOf<Pair<String, String?>>()
        show(
            signedOut(ProviderSignInView("google", "nonce-1", CLIENT)),
            AppIntents(promptGoogle = { nonce, client -> sheets += nonce to client }),
        )

        compose.waitForIdle()

        assertEquals(listOf("nonce-1" to CLIENT), sheets)
    }

    @Test
    fun twoStepSignInOpensTheBrowserForThatProviderOnce() {
        val opened = mutableListOf<String>()
        show(signedOut(continueInBrowser = "google"), AppIntents(signInInBrowser = { opened += it }))

        compose.waitForIdle()

        assertEquals(listOf("google"), opened)
    }

    @Test
    fun aTokenFromTheSheetGoesToTheCoreWithItsNonce() = runBlocking {
        assertEquals(listOf("finish nonce-1 eyJ"), outcome(GoogleResult.Token("eyJ")))
    }

    @Test
    fun closingTheSheetOrAFailureCancels() = runBlocking {
        assertEquals(listOf("cancel"), outcome(GoogleResult.Cancelled))
        assertEquals(listOf("cancel"), outcome(GoogleResult.Failed("no Google account on the phone")))
    }

    private suspend fun outcome(result: GoogleResult): List<String> {
        val calls = mutableListOf<String>()
        GooglePrompt(
            provider = { _, _ -> result },
            finish = { nonce, token -> calls += "finish $nonce $token" },
            cancel = { calls += "cancel" },
        ).answer("nonce-1", CLIENT)
        return calls
    }
}
