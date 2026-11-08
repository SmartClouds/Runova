package com.runovahq.app.ui

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
import uniffi.runova_ffi.AgentState
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.CursorView
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.FrameView
import uniffi.runova_ffi.LineView
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.RunView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.TerminalItem
import uniffi.runova_ffi.TerminalProcessView
import uniffi.runova_ffi.TerminalView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)
private val project = ProjectView("p1", "Website", listOf("web"), true, true, null, null)
private val claude = TerminalItem("t1", "Claude", "p1", "claude", AgentState.NEEDS_INPUT, 5)
private val shell = TerminalItem("t2", "Terminal", null, null, null, 6)

private fun run(text: String, fg: UInt? = null, cursor: Boolean = false) =
    RunView(text, fg, null, false, false, false, false, cursor)

private val frame = FrameView(
    40u,
    4u,
    CursorView(2u, 2u),
    listOf(
        LineView(listOf(run("~/website"))),
        LineView(listOf(run("build ", 0x7FD962u), run("passed in 4s"))),
        LineView(listOf(run("$ "), run(" ", cursor = true))),
        LineView(emptyList()),
    ),
)

private fun terminal(scrolled: Boolean = false, ended: Boolean = false, reason: String? = null) =
    TerminalView("t1", "Claude", frame, scrolled, ended, reason)

private fun view(
    terminals: List<TerminalItem> = listOf(claude, shell),
    terminal: TerminalView? = null,
    processes: List<TerminalProcessView> = emptyList(),
    selected: String? = null,
) = AppView(
    AuthState.SIGNED_IN,
    true,
    emptyList(),
    false,
    connected,
    listOf(project),
    false,
    selected,
    terminals,
    false,
    terminal,
    processes,
    GitScreen(null, false, null, false, emptyList(), emptyList()),
    false,
    null,
    null,
    null,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class DeviceTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, tab: String = "clis", intents: AppIntents = AppIntents(), onTab: (String) -> Unit = {}) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, tab, onTab, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theListShowsEachCliAndWhatItIsDoing() {
        show(view())

        compose.onNodeWithText("Claude").assertExists()
        compose.onNodeWithText("Needs input").assertExists()
        compose.onNodeWithText("Terminal").assertExists()
        snapshot("clis")
    }

    @Test
    fun theListRefreshesOnlyWhileItIsOnShow() {
        val sections = mutableListOf<Section?>()
        show(view(), intents = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.CLIS), sections)
    }

    @Test
    fun aTerminalPausesTheListBehindIt() {
        val sections = mutableListOf<Section?>()
        show(view(terminal = terminal()), intents = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(null), sections)
    }

    @Test
    fun tappingACliOpensIt() {
        var opened = ""
        show(view(), intents = AppIntents(openTerminal = { opened = it }))

        compose.onNodeWithText("Claude").performClick()

        assertEquals("t1", opened)
    }

    @Test
    fun anEmptyListSaysSo() {
        show(view(terminals = emptyList()))

        compose.onNodeWithText("No CLIs running").assertExists()
    }

    @Test
    fun choosingAProjectShowsItsClis() {
        var selected: String? = null
        var tab = ""
        show(
            view(),
            tab = "projects",
            intents = AppIntents(selectProject = { selected = it }),
            onTab = { tab = it },
        )

        compose.onNodeWithText("Website").performClick()

        assertEquals("p1", selected)
        assertEquals("clis", tab)
    }

    @Test
    fun aChosenProjectFiltersTheListAndCanBeCleared() {
        var selected: String? = "p1"
        show(view(selected = "p1"), intents = AppIntents(selectProject = { selected = it }))

        compose.onNodeWithText("Claude").assertExists()
        compose.onNodeWithText("Terminal").assertDoesNotExist()
        compose.onNodeWithText("Website").performClick()

        assertEquals(null, selected)
    }

    @Test
    fun aTerminalDrawsItsScreen() {
        show(view(terminal = terminal()))

        compose.onNodeWithText("~/website").assertExists()
        compose.onNodeWithText("build passed in 4s").assertExists()
        snapshot("terminal")
    }

    @Test
    fun aKeyIsSentAsItsBytes() {
        var sent = ""
        show(view(terminal = terminal()), intents = AppIntents(terminalInput = { sent = it }))

        compose.onNodeWithText("Ctrl C").performClick()

        assertEquals("\u0003", sent)
    }

    @Test
    fun aTypedCommandIsSentWithEnter() {
        var sent = ""
        show(view(terminal = terminal()), intents = AppIntents(terminalInput = { sent = it }))

        compose.onNode(hasSetTextAction()).performTextInput("ls")
        compose.onNodeWithText("Send").performClick()

        assertEquals("ls\r", sent)
    }

    @Test
    fun backLeavesTheTerminal() {
        var closed = false
        show(view(terminal = terminal()), intents = AppIntents(closeTerminal = { closed = true }))

        compose.onNodeWithText("Claude").assertExists()
        compose.onNode(androidx.compose.ui.test.hasContentDescription("Back")).performClick()

        assertTrue(closed)
    }

    @Test
    fun readingHistoryOffersAWayBack() {
        var scrolled = 0
        show(view(terminal = terminal(scrolled = true)), intents = AppIntents(terminalScroll = { scrolled = it }))

        compose.onNodeWithText("Back to live").performClick()

        assertTrue(scrolled < 0)
        snapshot("terminal-history")
    }

    @Test
    fun anEndedTerminalSaysWhyAndTakesNoInput() {
        show(view(terminal = terminal(ended = true, reason = "That terminal has closed.")))

        compose.onNodeWithText("That terminal has closed.").assertExists()
        compose.onNodeWithText("Send").assertDoesNotExist()
        snapshot("terminal-ended")
    }

    @Test
    fun processesOpenFromTheTerminal() {
        var asked = ""
        val process = TerminalProcessView("node", 12.5, 2048uL, "12.5%", "2 KB")
        show(
            view(terminal = terminal(), processes = listOf(process)),
            intents = AppIntents(loadProcesses = { asked = it }),
        )

        compose.onNodeWithText("Processes").performClick()

        assertEquals("t1", asked)
        compose.onNodeWithText("node").assertExists()
        compose.onNodeWithText("12.5% CPU, 2 KB").assertExists()
        snapshot("terminal-processes")
    }
}
