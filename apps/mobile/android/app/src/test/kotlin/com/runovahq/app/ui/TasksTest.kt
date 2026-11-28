package com.runovahq.app.ui

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
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.TaskCheckView
import uniffi.runova_ffi.TaskDetailView
import uniffi.runova_ffi.TaskHandoffView
import uniffi.runova_ffi.TaskJournalView
import uniffi.runova_ffi.TaskMilestoneView
import uniffi.runova_ffi.TaskMoveView
import uniffi.runova_ffi.TaskRecordView
import uniffi.runova_ffi.TaskRefView
import uniffi.runova_ffi.TaskRowView
import uniffi.runova_ffi.TaskRunView
import uniffi.runova_ffi.TaskSectionView
import uniffi.runova_ffi.TaskSplitView
import uniffi.runova_ffi.TasksOverviewView
import uniffi.runova_ffi.TasksScreen

private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val computer = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)
private val project = ProjectView("p1", "Northwind shop", emptyList(), true, true, null, null)

private fun row(id: String, title: String, status: String, label: String) =
    TaskRowView(id, title, status, label, "P1 · M001 · 1 of 3 criteria")

private val blocked = row("T005", "Split a payment", "blocked", "Blocked")

private val overview = TasksOverviewView(
    true,
    "Gift cards at checkout",
    "Plan mode, no context budget",
    "Shoppers pay with a gift card.",
    "3 of 7 tasks done",
    43u,
    "2 to do, 1 in progress, 1 blocked",
    listOf(TaskMilestoneView("M001", "Pay with a card", "active", "2026-12-12", "3 of 4 done", 75u)),
    listOf(blocked),
    listOf(TaskRefView("Q001", "Can a gift card pay for shipping?")),
    "1 open workaround, 2 open risks",
    TaskRunView("Running T004", true, false),
    false,
)

private val detail = TaskDetailView(
    row("T004", "Show the new total", "testing", "Testing"),
    "p1", "m", "M001", null, "Attempt 2",
    listOf(TaskSectionView("Goal", "The summary shows what the card paid.")),
    listOf(TaskCheckView(0u, "Shows the new total", true), TaskCheckView(1u, "Removing the card puts it back", false)),
    TaskHandoffView("Carries on, tests passed, session 1", listOf(TaskSectionView("Next step", "Put the old total back."))),
    listOf(TaskJournalView("2026-11-28 09:30 session 1", listOf("Result: continue", "Tests: passed"))),
    "## Goal\n\nThe summary shows what the card paid.\n",
    listOf(TaskMoveView("todo", "To do"), TaskMoveView("done", "Done")),
)

private val noSplit = TaskSplitView(false, false, null, emptyList(), null, null)

private fun screen(
    detailView: TaskDetailView? = null,
    kind: String? = null,
    records: List<TaskRecordView> = emptyList(),
    split: TaskSplitView = noSplit,
) = TasksScreen(
    overview,
    listOf(row("T001", "Gift card field", "done", "Done"), blocked),
    false,
    detailView?.row?.id,
    detailView,
    kind,
    records,
    split,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class TasksTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: TaskIntents = TaskIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "tasks", {}, AppIntents(tasks = intents)) } }
    }

    private fun onTasks(tasks: TasksScreen) =
        appView(connection = computer, projects = listOf(project), selected = "p1", tasks = tasks)

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theOverviewShowsThePlanAndPausesTheRelay() {
        var paused = false
        var opened = ""
        show(onTasks(screen()), TaskIntents(pause = { paused = true }, open = { opened = it }))
        snapshot("tasks-overview")

        compose.onNodeWithText("Gift cards at checkout").assertExists()
        compose.onNodeWithText("Running T004").assertExists()
        compose.onNodeWithText("Pause").performClick()
        compose.onNodeWithText("T005 Split a payment").performClick()

        assertEquals(true, paused)
        assertEquals("T005", opened)
    }

    @Test
    fun theTaskListAddsATask() {
        var added = ""
        show(onTasks(screen()), TaskIntents(create = { title, _ -> added = title }))
        compose.onNodeWithText("Tasks").performClick()
        compose.onNodeWithText("A new task").performTextInput("Export to CSV")
        snapshot("tasks-list")
        compose.onNodeWithText("Add").performClick()

        assertEquals("Export to CSV", added)
    }

    @Test
    fun aTaskTicksCriteriaMovesAndRedoes() {
        var ticked: Triple<String, UInt, Boolean>? = null
        var moved = ""
        var redone: Boolean? = null
        show(
            onTasks(screen(detail)),
            TaskIntents(
                toggle = { id, index, checked -> ticked = Triple(id, index, checked) },
                setStatus = { _, status -> moved = status },
                redo = { _, _, keep -> redone = keep },
            ),
        )
        snapshot("tasks-detail")

        compose.onNodeWithContentDescription("Removing the card puts it back").performClick()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("From the spec alone").performScrollTo().performClick()
        compose.onNodeWithText("Redo").performScrollTo().performClick()

        assertEquals(Triple("T004", 1u, true), ticked)
        assertEquals("done", moved)
        assertEquals(false, redone)
    }

    @Test
    fun aQuestionIsAnsweredFromRecords() {
        var answered: Pair<String, String>? = null
        val question = TaskRecordView(
            "Q001", "Can a gift card pay for shipping?", "open", listOf("open", "answered"),
            listOf(TaskSectionView("From task", "T005")),
            listOf(TaskSectionView("Question", "The provider allows it. Should we?")),
        )
        show(onTasks(screen(kind = "question", records = listOf(question))), TaskIntents(answer = { id, text -> answered = id to text }))
        compose.onNodeWithText("Records").performClick()
        compose.onNodeWithText("Your answer").performTextInput("Not for now.")
        snapshot("tasks-records")
        compose.onNodeWithText("Answer").performClick()

        assertEquals("Q001" to "Not for now.", answered)
    }

    @Test
    fun aSplitIsPlannedAndAdded() {
        var asked: Pair<String, Boolean>? = null
        var added = false
        val planned = TaskSplitView(false, true, "Two parts.", listOf("T008 Balance lookup", "T009 Balance page"), "Also writes 1 milestone.", null)
        show(onTasks(screen(split = planned)), TaskIntents(split = { request, planOnly -> asked = request to planOnly }, addSplit = { added = true }))
        compose.onNodeWithText("Split").performClick()
        compose.onNodeWithText("What should the tasks deliver?").performTextInput("Gift card balance")
        compose.onNodeWithText("Plan only").performClick()
        snapshot("tasks-split")
        compose.onNodeWithText("Plan tasks").performClick()
        compose.onNodeWithText("Add to the board").performClick()

        assertEquals("Gift card balance" to true, asked)
        assertEquals(true, added)
    }
}
