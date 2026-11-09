package com.runovahq.app.ui

import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
import uniffi.runova_ffi.GitAiKind
import uniffi.runova_ffi.GitAiView
import uniffi.runova_ffi.GitFileView
import uniffi.runova_ffi.GitMoreScreen
import uniffi.runova_ffi.GitPrInfoView
import uniffi.runova_ffi.GitPrSuggestionView
import uniffi.runova_ffi.GitPrView
import uniffi.runova_ffi.GitGroup
import uniffi.runova_ffi.GitScreen
import uniffi.runova_ffi.GitStateView
import uniffi.runova_ffi.GitTagChannelView
import uniffi.runova_ffi.GitTagOptionView
import uniffi.runova_ffi.GitTagSuggestionView
import uniffi.runova_ffi.GitTagsView
import uniffi.runova_ffi.GitToolsScreen
import uniffi.runova_ffi.GitVersionFileView
import uniffi.runova_ffi.GitVersionState
import uniffi.runova_ffi.GitVersionView
import uniffi.runova_ffi.ProjectView

private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val computer = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)
private val project = ProjectView("p1", "Website", emptyList(), true, true, null, null)

private fun file(path: String, group: GitGroup, conflict: String? = null) =
    GitFileView(path, null, group, "M", conflict, 3u, 1u, false)

private fun gitWith(files: List<GitFileView>) = GitScreen(
    GitStateView(true, "main", false, "origin/main", 0u, 0u, true, null, files, false),
    false, null, false, emptyList(), emptyList(),
)

private val options = listOf(
    GitTagOptionView("Patch", "v1.4.3"),
    GitTagOptionView("Minor", "v1.5.0"),
    GitTagOptionView("Major", "v2.0.0"),
)

private fun tags(suggesting: Boolean = false, suggestion: GitTagSuggestionView? = null) = GitTagsView(
    false,
    "v1.4.2",
    "3 commits since this tag",
    true,
    listOf("v1.4.2", "v1.4.1"),
    listOf(
        GitTagChannelView("stable", "Stable", options),
        GitTagChannelView("beta", "Beta", listOf(GitTagOptionView("Patch", "v1.4.3-beta.1"))),
    ),
    suggesting,
    suggestion,
    null,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class GitToolsTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: GitIntents = GitIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "git", {}, AppIntents(git = intents)) } }
    }

    private fun view(
        files: List<GitFileView>,
        tools: GitToolsScreen = GitToolsScreen(null, null, null),
        more: GitMoreScreen = GitMoreScreen(null, null),
    ) = appView(connection = computer, projects = listOf(project), selected = "p1", git = gitWith(files), gitTools = tools, gitMore = more)

    private val noPr = GitPrView(
        false, "fix/login", "main", "2 commits to send", false, true, null, null, false, null, false, null, null, null, null,
    )

    private val openPr = noPr.copy(
        canCreate = false,
        pr = GitPrInfoView(12u, "Fix login", "https://x/12", "Open", "Approved", "+10 -2, 3 checks passed", "1 open review thread", false),
    )

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun tagsOpenFromTheBranchCard() {
        var opened = 0
        show(view(emptyList()), GitIntents(openTags = { opened++ }))

        compose.onNodeWithText("Tags").performClick()

        assertEquals(1, opened)
    }

    @Test
    fun aSizePicksTheNameAndCreatesIt() {
        var created: Triple<String, String, Boolean>? = null
        show(
            view(emptyList(), GitToolsScreen(tags(), null, null)),
            GitIntents(createTag = { tag, message, push -> created = Triple(tag, message, push) }),
        )
        snapshot("git-tags")

        compose.onNodeWithText("v1.5.0").performClick()
        compose.onNodeWithText("Create and push").performClick()

        assertEquals(Triple("v1.5.0", "", true), created)
    }

    @Test
    fun theAiSuggestionFillsTheFormAndSaysWhy() {
        val suggestion = GitTagSuggestionView("v1.5.0", "A new feature landed", "Notes", "Written by Claude Code on this computer")
        var created: Triple<String, String, Boolean>? = null
        show(
            view(emptyList(), GitToolsScreen(tags(suggestion = suggestion), null, null)),
            GitIntents(createTag = { tag, message, push -> created = Triple(tag, message, push) }),
        )
        snapshot("git-tags-suggested")

        compose.onNodeWithText("A new feature landed").assertExists()
        compose.onNodeWithText("Create and push").performClick()

        assertEquals(Triple("v1.5.0", "Notes", true), created)
    }

    @Test
    fun aSuggestionInProgressCanBeStopped() {
        var stopped = 0
        show(view(emptyList(), GitToolsScreen(tags(suggesting = true), null, null)), GitIntents(cancelAi = { stopped++ }))

        compose.onNodeWithText("Stop asking").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun aCommitMessageIsAskedForAndFilledIn() {
        var asked = 0
        var taken = 0
        val answer = GitAiView(GitAiKind.COMMIT, false, "fix: the login redirect", "Written by Codex on this computer", null)
        show(
            view(listOf(file("a.ts", GitGroup.STAGED)), GitToolsScreen(null, answer, null)),
            GitIntents(suggestCommit = { asked++ }, aiTaken = { taken++ }),
        )
        snapshot("git-ai-commit")

        compose.onNodeWithText("fix: the login redirect").assertExists()
        compose.onNodeWithContentDescription("Suggest a commit message").performClick()

        assertEquals(1, asked)
        assertEquals(1, taken)
    }

    @Test
    fun whileAskingTheButtonStops() {
        var stopped = 0
        val asking = GitAiView(GitAiKind.COMMIT, true, null, null, null)
        show(view(listOf(file("a.ts", GitGroup.STAGED)), GitToolsScreen(null, asking, null)), GitIntents(cancelAi = { stopped++ }))

        compose.onNodeWithText("Asking the AI on this computer").assertExists()
        compose.onNodeWithContentDescription("Stop").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun aChannelChangesTheChoices() {
        var created: Triple<String, String, Boolean>? = null
        show(
            view(emptyList(), GitToolsScreen(tags(), null, null)),
            GitIntents(createTag = { tag, message, push -> created = Triple(tag, message, push) }),
        )

        compose.onNodeWithText("Beta").performClick()
        compose.onNodeWithText("v1.4.3-beta.1").performClick()
        compose.onNodeWithText("Create and push").performClick()

        assertEquals(Triple("v1.4.3-beta.1", "", true), created)
    }

    @Test
    fun aRecentTagCanBeDeleted() {
        var deleted = ""
        show(view(emptyList(), GitToolsScreen(tags(), null, null)), GitIntents(deleteTag = { deleted = it }))

        compose.onAllNodesWithText("Delete")[1].performScrollTo().performClick()

        assertEquals("v1.4.1", deleted)
    }

    @Test
    fun aPullRequestOpensFromTheForm() {
        var made: Triple<String, String, Boolean>? = null
        show(view(emptyList(), more = GitMoreScreen(noPr, null)), GitIntents(createPr = { title, body, draft -> made = Triple(title, body, draft) }))
        snapshot("git-pr-new")

        compose.onAllNodes(hasSetTextAction())[0].performTextInput("Fix login")
        compose.onNodeWithContentDescription("Open as a draft").performClick()
        compose.onNodeWithText("Open pull request").performClick()

        assertEquals(Triple("Fix login", "", true), made)
    }

    @Test
    fun theAiFillsInThePullRequest() {
        var taken = 0
        val suggested = noPr.copy(suggestion = GitPrSuggestionView("Fix login", "Why it changed", "Written by Codex"))
        show(view(emptyList(), more = GitMoreScreen(suggested, null)), GitIntents(prSuggestionTaken = { taken++ }))

        compose.onNodeWithText("Why it changed").assertExists()

        assertEquals(1, taken)
    }

    @Test
    fun anOpenPullRequestCanBeReviewedAndPosted() {
        var posted = ""
        val reviewed = openPr.copy(review = "Looks fine", reviewNote = "Written by Codex on this computer")
        show(view(emptyList(), more = GitMoreScreen(reviewed, null)), GitIntents(postReview = { posted = it }))
        snapshot("git-pr")

        compose.onNodeWithText("Approved").assertExists()
        compose.onNodeWithText("Post as a comment").performClick()

        assertEquals("Looks fine", posted)
    }

    @Test
    fun theVersionRunIsFollowedAndAFileCanBeUndone() {
        var undone = ""
        val run = GitVersionView(
            "r1", "v1.5.0", GitVersionState.DONE, listOf("Reading package.json"),
            listOf(GitVersionFileView("package.json", "modified, +1 -1", true)), null, null, false,
        )
        show(view(emptyList(), GitToolsScreen(tags(), null, null), GitMoreScreen(null, run)), GitIntents(versionToggle = { undone = it }))
        snapshot("git-version")

        compose.onNodeWithText("Updated to v1.5.0").assertExists()
        compose.onNodeWithText("Undo").performScrollTo().performClick()

        assertEquals("package.json", undone)
    }

    @Test
    fun aConflictCanGoToTheAi() {
        var path = ""
        show(view(listOf(file("a.ts", GitGroup.CONFLICT, "both modified"))), GitIntents(resolveWithAi = { path = it }))

        compose.onNodeWithText("AI").performClick()

        assertEquals("a.ts", path)
    }

    @Test
    fun aConflictBeingFixedCanBeStopped() {
        var stopped = 0
        show(
            view(listOf(file("a.ts", GitGroup.CONFLICT, "both modified")), GitToolsScreen(null, null, "a.ts")),
            GitIntents(cancelAi = { stopped++ }),
        )

        compose.onNodeWithText("Stop").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun aTagCanBeTypedByHand() {
        var created: Triple<String, String, Boolean>? = null
        show(
            view(emptyList(), GitToolsScreen(tags(), null, null)),
            GitIntents(createTag = { tag, message, push -> created = Triple(tag, message, push) }),
        )

        compose.onNodeWithContentDescription("Release notes (optional)").performTextInput("Notes")
        compose.onNodeWithText("v2.0.0").performClick()
        compose.onNodeWithContentDescription("Push it").performClick()
        compose.onNodeWithText("Create tag").performClick()

        assertEquals(Triple("v2.0.0", "Notes", false), created)
    }
}
