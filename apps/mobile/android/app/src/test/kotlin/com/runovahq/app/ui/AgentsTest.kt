package com.runovahq.app.ui

import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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
import uniffi.runova_ffi.AutoFixSessionView
import uniffi.runova_ffi.AutoFixTone
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.PipelineRunState
import uniffi.runova_ffi.PipelineRunView
import uniffi.runova_ffi.PipelinesScreen
import uniffi.runova_ffi.PipelinesStatusView
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.PromptHistoryView
import uniffi.runova_ffi.PromptModelView
import uniffi.runova_ffi.PromptOptionsView
import uniffi.runova_ffi.PromptScheduledView
import uniffi.runova_ffi.PromptTemplateView
import uniffi.runova_ffi.PromptTargetView
import uniffi.runova_ffi.PromptsScreen
import uniffi.runova_ffi.WorkflowView

private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val computer = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)
private val project = ProjectView("p1", "Website", emptyList(), true, true, null, null)

private fun run(state: PipelineRunState) =
    PipelineRunView(41, "Fix login", "main", 41u, state, "Failed", false)

private fun pipelines(state: PipelineRunState) = PipelinesScreen(
    PipelinesStatusView(null, listOf(WorkflowView(7, "CI", true, run(state), emptyList()))),
    false, null, null, null,
)

private fun session(
    label: String = "Fixing 1 of 3",
    tone: AutoFixTone = AutoFixTone.WORKING,
    agent: String? = "tab-1",
    canRetry: Boolean = false,
    canDismiss: Boolean = false,
) = AutoFixSessionView(
    "s1", 7, "CI on main", label, tone, null, listOf("Run #41 failed", "The agent is working on it"),
    agent, !canDismiss, canRetry, agent != null, canDismiss,
)

private val models = listOf(PromptModelView("opus", "Opus", "Deep", listOf("low", "high")))

private val options = PromptOptionsView(
    listOf("Bug Fix", "Testing", "Refactoring"),
    listOf(PromptTargetView("claude-code", "Claude Code", models), PromptTargetView("codex", "Codex", emptyList())),
    "Claude Code",
)

private fun promptsScreen(
    generating: Boolean = false,
    result: String? = null,
    error: String? = null,
    templates: List<PromptTemplateView> = emptyList(),
    history: List<PromptHistoryView> = emptyList(),
    scheduled: List<PromptScheduledView> = emptyList(),
) = PromptsScreen(options, generating, result, error, templates, history, scheduled)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class AgentsTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, tab: String, intents: AppIntents = AppIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, tab, {}, intents) } }
    }

    private fun onPipelines(state: PipelineRunState, sessions: List<AutoFixSessionView> = emptyList()) = appView(
        connection = computer,
        projects = listOf(project),
        selected = "p1",
        pipelines = pipelines(state),
        autoFix = sessions,
    )

    private fun onPrompts(screen: PromptsScreen = promptsScreen(), selected: String? = "p1") =
        appView(connection = computer, projects = listOf(project), selected = selected, prompts = screen)

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun aFailedRunOffersBothFixes() {
        var fixed = 0L
        var auto = 0L
        show(
            onPipelines(PipelineRunState.FAILED),
            "pipelines",
            AppIntents(
                pipelines = PipelineIntents(
                    fixWithAi = { id, _, _, _ -> fixed = id },
                    autoFixStart = { id, _, _, _ -> auto = id },
                ),
            ),
        )
        snapshot("pipelines-failed")

        compose.onNodeWithText("Fix with AI").performClick()
        compose.onNodeWithText("Start the agent").performClick()
        compose.onNodeWithText("Auto-fix").performClick()
        compose.onNodeWithText("Turn on auto-fix").performClick()

        assertEquals(7L, fixed)
        assertEquals(7L, auto)
    }

    @Test
    fun theSheetTakesTheAgentModelAndEffort() {
        var picked: List<String?> = emptyList()
        val view = onPipelines(PipelineRunState.FAILED).copy(prompts = promptsScreen())
        show(view, "pipelines", AppIntents(pipelines = PipelineIntents(fixWithAi = { _, cli, model, effort -> picked = listOf(cli, model, effort) })))

        compose.onNodeWithText("Fix with AI").performClick()
        compose.onNodeWithText("Claude Code").performClick()
        compose.onNodeWithText("Opus").performClick()
        compose.onNodeWithText("high").performClick()
        snapshot("pipelines-agent-sheet")
        compose.onNodeWithText("Start the agent").performClick()

        assertEquals(listOf("claude-code", "opus", "high"), picked)
    }

    @Test
    fun aLiveRunCanOnlyBeWatchedForFailure() {
        show(onPipelines(PipelineRunState.RUNNING), "pipelines")

        compose.onNodeWithText("Auto-fix").assertExists()
        compose.onNodeWithText("Fix with AI").assertDoesNotExist()
    }

    @Test
    fun aPassedRunOffersNothing() {
        show(onPipelines(PipelineRunState.SUCCESS), "pipelines")

        compose.onNodeWithText("Auto-fix").assertDoesNotExist()
    }

    @Test
    fun aFixInProgressCanBeWatchedAndStopped() {
        var watched = ""
        var stopped = ""
        show(
            onPipelines(PipelineRunState.FAILED, listOf(session())),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(watchAgent = { watched = it }, autoFixStop = { stopped = it })),
        )
        snapshot("pipelines-autofix")

        compose.onNodeWithText("Fixing 1 of 3").assertExists()
        compose.onNodeWithText("Watch the agent").performClick()
        compose.onNodeWithText("Stop").performClick()

        assertEquals("tab-1", watched)
        assertEquals("s1", stopped)
    }

    @Test
    fun aSessionThatNeedsYouCanBeRetried() {
        var retried = ""
        val blocked = session("Needs you", AutoFixTone.ATTENTION, agent = null, canRetry = true)
        show(
            onPipelines(PipelineRunState.FAILED, listOf(blocked)),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(autoFixRetry = { retried = it })),
        )

        compose.onNodeWithText("Try again").performClick()

        assertEquals("s1", retried)
    }

    @Test
    fun aFinishedSessionCanBeCleared() {
        var cleared = ""
        val done = session("Fixed", AutoFixTone.DONE, agent = null, canDismiss = true)
        show(
            onPipelines(PipelineRunState.SUCCESS, listOf(done)),
            "pipelines",
            AppIntents(pipelines = PipelineIntents(autoFixDismiss = { cleared = it })),
        )

        compose.onNodeWithText("Clear").performClick()

        assertEquals("s1", cleared)
    }

    @Test
    fun theBuilderSendsWhatWasChosen() {
        var sent: Triple<String, String, String>? = null
        show(onPrompts(), "prompts", AppIntents(prompts = PromptIntents(generate = { a, b, c -> sent = Triple(a, b, c) })))
        snapshot("prompts")

        compose.onNodeWithContentDescription("Describe the job in your own words").performTextInput("Fix login")
        compose.onNodeWithText("Testing").performClick()
        compose.onNodeWithText("Codex").performClick()
        compose.onNodeWithText("Generate prompt").performClick()

        assertEquals(Triple("Fix login", "Testing", "Codex"), sent)
    }

    @Test
    fun nothingIsGeneratedFromAnEmptyRequest() {
        var sent = false
        show(onPrompts(), "prompts", AppIntents(prompts = PromptIntents(generate = { _, _, _ -> sent = true })))

        compose.onNodeWithText("Generate prompt").performClick()

        assertEquals(false, sent)
    }

    @Test
    fun whileWritingItCanBeStopped() {
        var stopped = 0
        show(onPrompts(promptsScreen(generating = true)), "prompts", AppIntents(prompts = PromptIntents(cancel = { stopped++ })))

        compose.onNodeWithText("The AI on this computer is writing it.").assertExists()
        compose.onNodeWithText("Stop").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun theResultGoesToAnAgent() {
        var sent: Pair<String, String?>? = null
        var taken = 0
        show(
            onPrompts(promptsScreen(result = "A sharp prompt")),
            "prompts",
            AppIntents(prompts = PromptIntents(taken = { taken++ }, send = { p, cli, _, _ -> sent = p to cli })),
        )
        snapshot("prompts-result")

        compose.onNodeWithText("A sharp prompt").assertExists()
        compose.onNodeWithText("Send to agent").performClick()

        assertEquals(1, taken)
        assertEquals("A sharp prompt" to "claude-code", sent)
    }

    @Test
    fun withNoProjectItSaysToChooseOne() {
        var sent = false
        show(
            onPrompts(promptsScreen(result = "A sharp prompt"), selected = null),
            "prompts",
            AppIntents(prompts = PromptIntents(send = { _, _, _, _ -> sent = true })),
        )

        compose.onNodeWithText("Choose a project to send it to an agent.").assertExists()
        compose.onNodeWithText("Send to agent").performClick()

        assertEquals(false, sent)
    }

    @Test
    fun aTemplateFillsThePrompt() {
        val template = PromptTemplateView("t1", "Bug report", "Testing", "Codex", "Write the tests")
        show(onPrompts(promptsScreen(templates = listOf(template))), "prompts")
        compose.onNodeWithText("Templates").performClick()
        snapshot("prompts-templates")

        compose.onNodeWithText("Bug report").performClick()

        compose.onNodeWithText("Write the tests").assertExists()
    }

    @Test
    fun aTemplateCanBeDeleted() {
        var deleted = ""
        val template = PromptTemplateView("t1", "Bug report", "Testing", "Codex", "C")
        show(onPrompts(promptsScreen(templates = listOf(template))), "prompts", AppIntents(prompts = PromptIntents(deleteTemplate = { deleted = it })))

        compose.onNodeWithText("Templates").performClick()
        compose.onNodeWithText("Delete").performClick()

        assertEquals("t1", deleted)
    }

    @Test
    fun historyBringsBackTheRequestToo() {
        val entry = PromptHistoryView("h1", "Fix login", "Bug Fix, for Codex, 2h ago", "Bug Fix", "Codex", "Old prompt")
        show(onPrompts(promptsScreen(history = listOf(entry))), "prompts")

        compose.onNodeWithText("History").performClick()
        compose.onNodeWithText("Fix login").performClick()

        compose.onNodeWithText("Old prompt").assertExists()
    }

    @Test
    fun aPromptIsSavedAndScheduled() {
        var saved = ""
        var delay = 0L
        show(
            onPrompts(promptsScreen(result = "A sharp prompt")),
            "prompts",
            AppIntents(prompts = PromptIntents(saveTemplate = { name, _, _, _ -> saved = name }, schedule = { delay = it.inMs })),
        )

        compose.onNodeWithText("Save as template").performScrollTo().performClick()
        compose.onAllNodes(hasSetTextAction())[2].performTextInput("Mine")
        compose.onNodeWithText("Save").performScrollTo().performClick()
        compose.onNodeWithText("Schedule").performScrollTo().performClick()
        compose.onNodeWithText("In 1 hour").performScrollTo().performClick()

        assertEquals("Mine", saved)
        assertEquals(3_600_000L, delay)
    }

    @Test
    fun aWaitingTaskCanBeCancelled() {
        var cancelled = ""
        val task = PromptScheduledView("a", "Do it", "In 1 hour")
        show(onPrompts(promptsScreen(scheduled = listOf(task))), "prompts", AppIntents(prompts = PromptIntents(cancelScheduled = { cancelled = it })))

        compose.onNodeWithText("Scheduled").performClick()
        compose.onNodeWithText("Cancel").performClick()

        assertEquals("a", cancelled)
    }

    @Test
    fun aFailureIsShown() {
        show(onPrompts(promptsScreen(error = "No CLI is set up.")), "prompts")

        compose.onNodeWithText("No CLI is set up.").assertExists()
    }
}
