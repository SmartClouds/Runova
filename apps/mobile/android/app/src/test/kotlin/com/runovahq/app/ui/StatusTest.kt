package com.runovahq.app.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
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
import uniffi.runova_ffi.ComputerItemView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.LimitChipView
import uniffi.runova_ffi.LimitState
import uniffi.runova_ffi.LimitWindowView
import uniffi.runova_ffi.ProviderState
import uniffi.runova_ffi.ProviderUsageView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.StatusScreen
import uniffi.runova_ffi.SystemStatsView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)
private val system = SystemStatsView(12.5, "12.5%", "Ryzen 9, 16 cores", 50.0, "8 GB of 16 GB", "1.5 MB/s", "2 KB/s")

private fun window(percent: Double, resets: String? = "Resets in 3h 12m") =
    LimitWindowView("5 hours", percent, "${percent.toInt()}%", resets)

private val limits = listOf(
    LimitChipView("claude-code", "Claude", "Max", LimitState.OK, listOf(window(25.0)), null),
    LimitChipView("codex", "Codex", null, LimitState.STALE, listOf(window(92.0, null)), "Offline"),
    LimitChipView("cursor", "Cursor", null, LimitState.UNAVAILABLE, emptyList(), "Signed out"),
)
private val providers = listOf(
    ProviderUsageView("claude-code", "Claude", ProviderState.OK, null, "$1.50", "$10.00", "$40.00", listOf(1.0, 3.0, 2.0)),
    ProviderUsageView("gemini", "Gemini", ProviderState.ERROR, "Bad key", null, null, null, emptyList()),
)

private val computer = listOf(
    ComputerItemView("agents", "Agents", "1 waiting on you, 2 working", null, true),
    ComputerItemView("github", "GitHub", "@sam", null, false),
    ComputerItemView("keep-awake", "Keep awake", "Awake now", "Set to Agent, awake for an agent at work", false),
)

private fun status(detail: String? = null, items: List<ComputerItemView> = computer) =
    StatusScreen(system, false, limits, providers, detail, items)

private fun view(screen: StatusScreen = status()) = appView(connection = connected, status = screen)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class StatusTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: AppIntents = AppIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "status", {}, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theComputersNumbersAreShown() {
        show(view())

        compose.onNodeWithText("12.5%").assertExists()
        compose.onNodeWithText("8 GB of 16 GB").assertExists()
        snapshot("status")
    }

    @Test
    fun whatTheComputerIsDoingIsListed() {
        show(view())

        compose.onNodeWithText("ON THIS COMPUTER").assertExists()
        compose.onNodeWithText("1 waiting on you, 2 working").assertExists()
        compose.onNodeWithText("@sam").assertExists()
        compose.onNodeWithText("Set to Agent, awake for an agent at work").assertExists()
    }

    @Test
    fun nothingToListLeavesTheHeadingOut() {
        show(view(status(items = emptyList())))

        compose.onNodeWithText("ON THIS COMPUTER").assertDoesNotExist()
    }

    @Test
    fun itRefreshesOnlyWhileOnShow() {
        val sections = mutableListOf<Section?>()
        show(view(), AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.STATUS), sections)
    }

    @Test
    fun aLimitShowsHowMuchIsUsedAndWhenItResets() {
        show(view())

        compose.onNodeWithText("Max").assertExists()
        compose.onNodeWithText("25%").assertExists()
        compose.onNodeWithText("Resets in 3h 12m").assertExists()
    }

    @Test
    fun anOutOfDateOrMissingLimitSaysSo() {
        show(view())

        compose.onNodeWithText("Out of date").assertExists()
        compose.onNodeWithText("Unavailable").assertExists()
        compose.onNodeWithText("Signed out").assertExists()
    }

    @Test
    fun aProviderOpensItsDetail() {
        var opened = ""
        show(view(status(items = emptyList())), AppIntents(status = StatusIntents(openProvider = { opened = it })))

        compose.onNodeWithText("Gemini").performClick()

        assertEquals("gemini", opened)
    }

    @Test
    fun theDetailShowsCostsAndCloses() {
        var closed = false
        show(view(status("claude-code")), AppIntents(status = StatusIntents(closeProvider = { closed = true })))

        compose.onNodeWithText("$1.50").assertExists()
        compose.onNodeWithText("$40.00").assertExists()
        snapshot("status-provider")
        compose.onNode(androidx.compose.ui.test.hasContentDescription("Back")).performClick()

        assertEquals(true, closed)
    }

    @Test
    fun aProviderThatFailedSaysWhy() {
        show(view(status("gemini")))

        compose.onNodeWithText("Bad key").assertExists()
    }

    @Test
    fun beforeTheFirstReadingItIsLoading() {
        show(view(StatusScreen(null, true, emptyList(), emptyList(), null, emptyList())))

        compose.onNodeWithText("CPU").assertDoesNotExist()
    }
}
