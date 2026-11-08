package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performTextInput
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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.DispatchFormView
import uniffi.runova_ffi.JobLogView
import uniffi.runova_ffi.WorkflowInputKind
import uniffi.runova_ffi.WorkflowInputView
import uniffi.runova_ffi.LogLineView
import uniffi.runova_ffi.MonitorSource
import uniffi.runova_ffi.MonitorState
import uniffi.runova_ffi.MonitorView
import uniffi.runova_ffi.MonitoringScreen
import uniffi.runova_ffi.PipelineJobView
import uniffi.runova_ffi.PipelineRunDetailView
import uniffi.runova_ffi.PipelineRunState
import uniffi.runova_ffi.PipelineRunView
import uniffi.runova_ffi.PipelinesScreen
import uniffi.runova_ffi.PipelinesStatusView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.WorkflowView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)

private val api = MonitorView("h1", "API", MonitorSource.LOCAL, MonitorState.UP, "All good", "42 ms", "99.5%", false, true, true, listOf(40.0, 60.0))
private val shop = MonitorView("m1", "Shop", MonitorSource.CLOUD, MonitorState.DOWN, "Timed out", null, "90.0%", false, false, true, emptyList())

private fun monitoring(
    local: List<MonitorView> = listOf(api),
    note: String? = null,
    open: String? = null,
) = MonitoringScreen(local, listOf(shop), false, note, open)

private val running = PipelineRunView(100, "Fix it", "master", 12u, PipelineRunState.RUNNING, "Running", true)
private val workflows = listOf(
    WorkflowView(7, "CI", true, running, emptyList()),
    WorkflowView(9, "Never", false, null, emptyList()),
)
private val job = PipelineJobView(5, "build", PipelineRunState.FAILED, "Failed")

private fun pipelines(
    problem: String? = null,
    run: PipelineRunDetailView? = null,
    log: JobLogView? = null,
    form: DispatchFormView? = null,
) = PipelinesScreen(PipelinesStatusView(problem, if (problem == null) workflows else emptyList()), false, run, log, form)

private val inputs = listOf(
    WorkflowInputView("version", "Which version", true, WorkflowInputKind.TEXT, "", emptyList()),
    WorkflowInputView("channel", "Where to", false, WorkflowInputKind.CHOICE, "beta", listOf("beta", "stable")),
    WorkflowInputView("dry", "", false, WorkflowInputKind.TOGGLE, "false", emptyList()),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class OpsTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, tab: String, intents: AppIntents = AppIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, tab, {}, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun localAndCloudMonitorsAreBothShownAndLabeled() {
        show(appView(connection = connected, monitoring = monitoring()), "monitoring")

        compose.onNodeWithText("On this computer").assertExists()
        compose.onNodeWithText("Runova Cloud").assertExists()
        compose.onNodeWithText("API").assertExists()
        compose.onNodeWithText("Shop").assertExists()
        snapshot("monitoring")
    }

    @Test
    fun monitorsAreThereWithNoComputerConnected() {
        val sections = mutableListOf<Section?>()
        val note = "Connect to a computer to see the monitors it runs."
        show(appView(monitoring = monitoring(emptyList(), note)), "monitors", AppIntents(openSection = { sections += it }))

        compose.onNodeWithText("Shop").assertExists()
        compose.onNodeWithText(note).assertExists()
        assertEquals(listOf<Section?>(Section.MONITORING), sections)
        snapshot("monitors-offline")
    }

    @Test
    fun aMonitorOpensAndCanBeCheckedAndPaused() {
        var checked = ""
        var paused: Triple<String, MonitorSource, Boolean>? = null
        show(
            appView(connection = connected, monitoring = monitoring(open = "h1")),
            "monitoring",
            AppIntents(
                monitoring = MonitoringIntents(
                    check = { checked = it },
                    setPaused = { id, source, value -> paused = Triple(id, source, value) },
                ),
            ),
        )

        compose.onNodeWithText("Check now").performClick()
        compose.onNodeWithText("Pause").performClick()

        assertEquals("h1", checked)
        assertEquals(Triple("h1", MonitorSource.LOCAL, true), paused)
        snapshot("monitor-detail")
    }

    @Test
    fun aCloudMonitorHasNoCheckNow() {
        show(appView(connection = connected, monitoring = monitoring(open = "m1")), "monitoring")

        compose.onNodeWithText("Check now").assertDoesNotExist()
        compose.onNodeWithText("Timed out").assertExists()
    }

    @Test
    fun tappingAMonitorOpensIt() {
        var opened = ""
        show(
            appView(connection = connected, monitoring = monitoring()),
            "monitoring",
            AppIntents(monitoring = MonitoringIntents(open = { opened = it })),
        )

        compose.onNodeWithText("API").performClick()

        assertEquals("h1", opened)
    }

    @Test
    fun pipelinesNeedAProject() {
        show(appView(connection = connected), "pipelines")

        compose.onNodeWithText("Choose a project").assertExists()
    }

    @Test
    fun workflowsShowTheirLatestRun() {
        val sections = mutableListOf<Section?>()
        show(appView(connection = connected, selected = "p1", pipelines = pipelines()), "pipelines", AppIntents(openSection = { sections += it }))

        compose.onNodeWithText("CI").assertExists()
        compose.onNodeWithText("Running").assertExists()
        compose.onNodeWithText("Never run").assertExists()
        assertEquals(listOf<Section?>(Section.PIPELINES), sections)
        snapshot("pipelines")
    }

    @Test
    fun aComputerWithoutGhSaysSo() {
        val problem = "GitHub CLI isn't signed in on this computer."
        show(appView(connection = connected, selected = "p1", pipelines = pipelines(problem)), "pipelines")

        compose.onNodeWithText(problem).assertExists()
    }

    @Test
    fun aRunOpensAndCanBeCancelled() {
        var opened = 0L
        var cancelled = 0L
        val intents = PipelineIntents(openRun = { opened = it }, cancel = { cancelled = it })
        show(appView(connection = connected, selected = "p1", pipelines = pipelines()), "pipelines", AppIntents(pipelines = intents))

        compose.onNodeWithText("Fix it").performClick()
        compose.onNodeWithText("Cancel").performClick()

        assertEquals(100L, opened)
        assertEquals(100L, cancelled)
    }

    @Test
    fun aWorkflowCanBeRun() {
        var dispatched = 0L
        show(
            appView(connection = connected, selected = "p1", pipelines = pipelines()),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(dispatch = { dispatched = it })),
        )

        compose.onNodeWithText("Run").performClick()

        assertEquals(7L, dispatched)
    }

    @Test
    fun aFormCollectsAWorkflowsInputs() {
        var sent: Map<String, String>? = null
        val form = DispatchFormView(11, "Release", inputs, null)
        show(
            appView(connection = connected, selected = "p1", pipelines = pipelines(form = form)),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(submitDispatch = { sent = it })),
        )

        compose.onNode(hasSetTextAction()).performTextInput("1.2.3")
        compose.onNodeWithText("stable").performClick()
        compose.onNode(hasContentDescription("dry")).performClick()
        snapshot("pipeline-form")
        compose.onNodeWithText("Run workflow").performClick()

        assertEquals(mapOf("version" to "1.2.3", "channel" to "stable", "dry" to "true"), sent)
    }

    @Test
    fun aFormSaysWhatIsMissing() {
        val form = DispatchFormView(11, "Release", inputs, "Fill in version.")
        show(appView(connection = connected, selected = "p1", pipelines = pipelines(form = form)), "pipelines")

        compose.onNodeWithText("Fill in version.").assertExists()
    }

    @Test
    fun aRunListsItsJobs() {
        var opened = 0L
        show(
            appView(connection = connected, selected = "p1", pipelines = pipelines(run = PipelineRunDetailView(100, false, listOf(job)))),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(openJob = { opened = it })),
        )

        compose.onNodeWithText("build").performClick()

        assertEquals(5L, opened)
        snapshot("pipeline-run")
    }

    @Test
    fun aLogShowsItsLinesAndSaysWhenItWasCut() {
        var closed = false
        val log = JobLogView(5, "build", false, true, listOf(LogLineView("boom", true)))
        show(
            appView(connection = connected, selected = "p1", pipelines = pipelines(run = PipelineRunDetailView(100, false, listOf(job)), log = log)),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(closeJob = { closed = true })),
        )

        compose.onNodeWithText("boom").assertExists()
        compose.onNodeWithText("Only the end of this log is shown.").assertExists()
        snapshot("pipeline-log")
        compose.onNode(hasContentDescription("Back")).performClick()

        assertTrue(closed)
    }
}
