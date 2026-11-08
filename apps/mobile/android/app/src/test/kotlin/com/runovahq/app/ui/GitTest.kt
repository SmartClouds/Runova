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
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ConfirmView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.DiffLineKind
import uniffi.runova_ffi.DiffLineView
import uniffi.runova_ffi.GitBranchView
import uniffi.runova_ffi.GitDiffView
import uniffi.runova_ffi.GitFileView
import uniffi.runova_ffi.GitGroup
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.GitStashView
import uniffi.runova_ffi.GitStateView
import uniffi.runova_ffi.Section

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)

private fun file(path: String, group: GitGroup, conflict: String? = null) =
    GitFileView(path, null, group, "M", conflict, 3u, 1u, false)

private val files = listOf(
    file("conflict.ts", GitGroup.CONFLICT, "UU"),
    file("staged.ts", GitGroup.STAGED),
    file("changed.ts", GitGroup.UNSTAGED),
    file("new.ts", GitGroup.UNTRACKED),
)

private fun state(list: List<GitFileView> = files, operation: String? = null, isRepo: Boolean = true) =
    GitStateView(isRepo, "master", false, "origin/master", 1u, 2u, true, operation, list, false)

private fun view(
    git: GitScreen = GitScreen(state(), false, null, false, emptyList(), emptyList()),
    selected: String? = "p1",
    confirm: ConfirmView? = null,
    notice: String? = null,
    error: String? = null,
) = appView(connection = connected, selected = selected, git = git, notice = notice, confirm = confirm, error = error)

private fun screen(
    diff: GitDiffView? = null,
    branchesOpen: Boolean = false,
    branches: List<GitBranchView> = emptyList(),
    stashes: List<GitStashView> = emptyList(),
) = GitScreen(state(), false, diff, branchesOpen, branches, stashes)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class GitTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, git: GitIntents = GitIntents(), intents: AppIntents = AppIntents(git = git)) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "git", {}, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theScreenListsEveryKindOfChange() {
        show(view())

        compose.onNodeWithText("Conflicts").assertExists()
        compose.onNodeWithText("Staged").assertExists()
        compose.onNodeWithText("Changes").assertExists()
        compose.onNodeWithText("Untracked").assertExists()
        compose.onNodeWithText("master").assertExists()
        compose.onNodeWithText("1 ahead, 2 behind").assertExists()
        snapshot("git")
    }

    @Test
    fun theScreenRefreshesWhileOnShow() {
        val sections = mutableListOf<Section?>()
        show(view(), intents = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.GIT), sections)
    }

    @Test
    fun withNoProjectItAsksForOne() {
        show(view(selected = null, git = GitScreen(null, false, null, false, emptyList(), emptyList())))

        compose.onNodeWithText("Choose a project").assertExists()
    }

    @Test
    fun aFolderThatIsNotARepoSaysSo() {
        show(view(git = GitScreen(state(emptyList(), isRepo = false), false, null, false, emptyList(), emptyList())))

        compose.onNodeWithText("Not a git repository").assertExists()
    }

    @Test
    fun aChangeStages() {
        var staged = emptyList<String>()
        show(view(), GitIntents(stage = { staged = it }))

        compose.onNodeWithText("Stage").performClick()

        assertEquals(listOf("changed.ts"), staged)
    }

    @Test
    fun aStagedFileUnstages() {
        var unstaged = emptyList<String>()
        show(view(), GitIntents(unstage = { unstaged = it }))

        compose.onNodeWithText("Unstage").performClick()

        assertEquals(listOf("staged.ts"), unstaged)
    }

    @Test
    fun tappingAFileOpensItsDiff() {
        var opened: Pair<String, GitGroup>? = null
        show(view(), GitIntents(openDiff = { path, group -> opened = path to group }))

        compose.onNodeWithText("changed.ts").performClick()

        assertEquals("changed.ts" to GitGroup.UNSTAGED, opened)
    }

    @Test
    fun aConflictKeepsOneSide() {
        var resolved: Pair<String, String>? = null
        show(view(), GitIntents(resolve = { path, pick -> resolved = path to pick }))

        compose.onNodeWithText("Theirs").performClick()

        assertEquals("conflict.ts" to "theirs", resolved)
    }

    @Test
    fun aCommitSendsTheMessage() {
        var committed: Pair<String, Boolean>? = null
        show(view(), GitIntents(commit = { message, push -> committed = message to push }))

        compose.onNode(hasSetTextAction()).performTextInput("Fix it")
        compose.onNodeWithText("Commit and push").performClick()

        assertEquals("Fix it" to true, committed)
    }

    @Test
    fun syncButtonsRun() {
        var pushed = false
        var fetched = false
        show(view(), GitIntents(push = { pushed = true }, fetch = { fetched = true }))

        compose.onNodeWithText("Push").performClick()
        compose.onNodeWithText("Fetch").performClick()

        assertTrue(pushed && fetched)
    }

    @Test
    fun anOperationInProgressOffersAWayOut() {
        var stopped = false
        val git = GitScreen(state(operation = "merge"), false, null, false, emptyList(), emptyList())
        show(view(git = git), GitIntents(abort = { stopped = true }))

        compose.onNodeWithText("A merge is in progress").assertExists()
        compose.onNodeWithText("Stop").performClick()

        assertTrue(stopped)
    }

    @Test
    fun aDiffShowsItsLines() {
        val lines = listOf(
            DiffLineView(DiffLineKind.HUNK, "@@ -1,2 +1,2 @@"),
            DiffLineView(DiffLineKind.CONTEXT, "same"),
            DiffLineView(DiffLineKind.REMOVED, "old line"),
            DiffLineView(DiffLineKind.ADDED, "new line"),
        )
        show(view(git = screen(diff = GitDiffView("changed.ts", GitGroup.UNSTAGED, false, false, false, lines))))

        compose.onNodeWithText("new line").assertExists()
        compose.onNodeWithText("old line").assertExists()
        snapshot("git-diff")
    }

    @Test
    fun aDiffOffersWhatItsGroupAllows() {
        var discarded: Pair<String, GitGroup>? = null
        show(
            view(git = screen(diff = GitDiffView("changed.ts", GitGroup.UNSTAGED, false, false, false, emptyList()))),
            GitIntents(discard = { path, group -> discarded = path to group }),
        )

        compose.onNodeWithText("Discard").performClick()

        assertEquals("changed.ts" to GitGroup.UNSTAGED, discarded)
    }

    @Test
    fun aTooLargeFileSaysSo() {
        show(view(git = screen(diff = GitDiffView("big.bin", GitGroup.STAGED, false, false, true, emptyList()))))

        compose.onNodeWithText("Too large to show on a phone").assertExists()
    }

    @Test
    fun branchesAndStashesAreListed() {
        var checkedOut = ""
        var popped = ""
        show(
            view(
                git = screen(
                    branchesOpen = true,
                    branches = listOf(GitBranchView("master", true, true), GitBranchView("dev", false, true)),
                    stashes = listOf(GitStashView("stash@{0}", "WIP on master")),
                ),
            ),
            GitIntents(checkout = { checkedOut = it }, stashPop = { popped = it }),
        )

        compose.onNodeWithText("dev").performClick()
        compose.onNodeWithText("Pop").performClick()

        assertEquals("dev", checkedOut)
        assertEquals("stash@{0}", popped)
        snapshot("git-branches")
    }

    @Test
    fun aQuestionIsAnsweredBeforeAnythingHappens() {
        var confirmed = false
        var dismissed = false
        show(
            view(confirm = ConfirmView("Discard these changes?", "a.ts goes back.", "Discard", true)),
            intents = AppIntents(confirm = { confirmed = true }, dismissConfirm = { dismissed = true }),
        )

        compose.onNodeWithText("Discard these changes?").assertExists()
        snapshot("confirm")
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(dismissed)
        compose.onNodeWithText("Discard").performClick()
        assertTrue(confirmed)
    }

    @Test
    fun aNoticeAppearsAndCanBeDismissed() {
        var dismissed = false
        show(view(notice = "Pushed master."), intents = AppIntents(dismissNotice = { dismissed = true }))

        compose.onNodeWithText("Pushed master.").performClick()

        assertTrue(dismissed)
    }

    @Test
    fun gitsReasonIsShownWhenSomethingFails() {
        show(view(error = "rejected: non-fast-forward"))

        compose.onNodeWithText("rejected: non-fast-forward").assertExists()
    }
}
