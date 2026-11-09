package com.runovahq.app.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.runovahq.app.design.RunovaTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView

private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private const val FIRST_TITLE = "Every computer, in your pocket"

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class IntroTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: AppIntents = AppIntents(), tab: String = "account") {
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = true) { AppRoot(view, tab, {}, intents) }
            }
        }
    }

    private fun showIntro(page: Int = 0, onDone: () -> Unit = {}) {
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) { IntroScreen(onDone, startPage = page) }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun aNewInstallOpensOnTheIntro() {
        show(appView(AuthState.SIGNED_OUT, showIntro = true))

        compose.onNodeWithText(FIRST_TITLE).assertExists()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
    }

    @Test
    fun onceSeenSignInComesFirst() {
        show(appView(AuthState.SIGNED_OUT))

        compose.onNodeWithText("Sign in").assertExists()
        compose.onNodeWithText(FIRST_TITLE).assertDoesNotExist()
    }

    @Test
    fun someoneSignedInNeverSeesIt() {
        show(appView(showIntro = true))

        compose.onNodeWithText(FIRST_TITLE).assertDoesNotExist()
    }

    @Test
    fun nextWalksThePagesAndTheLastOneFinishes() {
        var done = 0
        showIntro(onDone = { done++ })

        repeat(3) { compose.onNodeWithText("Next").performClick() }
        compose.onNodeWithText("Skip").assertDoesNotExist()
        compose.onNodeWithText("Get started").performClick()

        assertEquals(1, done)
    }

    @Test
    fun skipFinishesFromAnyPage() {
        var done = 0
        showIntro(page = 1, onDone = { done++ })

        compose.onNodeWithText("Skip").performClick()

        assertEquals(1, done)
    }

    @Test
    fun finishingTellsTheCore() {
        var done = 0
        show(appView(AuthState.SIGNED_OUT, showIntro = true), AppIntents(finishIntro = { done++ }))

        compose.onNodeWithText("Skip").performClick()

        assertEquals(1, done)
    }

    @Test
    fun theFourPagesLookRight() {
        showIntro(page = 0)
        snapshot("intro-computers")
    }

    @Test
    fun theAgentsPageLooksRight() {
        showIntro(page = 1)
        snapshot("intro-agents")
    }

    @Test
    fun theShipPageLooksRight() {
        showIntro(page = 2)
        snapshot("intro-ship")
    }

    @Test
    fun thePrivatePageLooksRight() {
        showIntro(page = 3)
        snapshot("intro-private")
    }

    @Test
    fun aboutOpensFromMoreAndCloses() {
        val computer = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)
        show(appView(connection = computer, appVersion = "1.4.2"), tab = "more")

        compose.onNodeWithText("About Runova").performClick()
        compose.onNodeWithText("v1.4.2").assertExists()
        compose.onNodeWithContentDescription("Close").performClick()

        compose.onNodeWithText("v1.4.2").assertDoesNotExist()
    }

    @Test
    fun aboutLinksLeaveForTheBrowser() {
        val opened = mutableListOf<String>()
        val handler = object : UriHandler {
            override fun openUri(uri: String) {
                opened += uri
            }
        }
        compose.setContent {
            CompositionLocalProvider(LocalUriHandler provides handler) {
                RunovaTheme(dark = true) { AboutSheet("1.4.2", {}) }
            }
        }

        compose.onNodeWithText("Website").performClick()
        compose.onNodeWithText("Source").performClick()
        compose.onNodeWithText("SmartClouds").performClick()

        assertEquals(
            listOf("https://runovahq.com", "https://github.com/SmartClouds/Runova", "https://smartclouds.co"),
            opened,
        )
    }

    @Test
    fun aboutLooksRight() {
        compose.setContent { RunovaTheme(dark = true) { AboutSheet("1.4.2", {}, year = 2026) } }
        snapshot("about")
    }

    @Test
    fun aboutLooksRightInTheLightTheme() {
        compose.setContent { RunovaTheme(dark = false) { AboutSheet("1.4.2", {}, year = 2026) } }
        snapshot("about-light")
    }
}
