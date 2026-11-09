package com.runovahq.app.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
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
import uniffi.runova_ffi.StudioChangeField
import uniffi.runova_ffi.StudioChangeView
import uniffi.runova_ffi.StudioComposerView
import uniffi.runova_ffi.StudioLanguageView
import uniffi.runova_ffi.StudioProposalView
import uniffi.runova_ffi.StudioRenderSheetView
import uniffi.runova_ffi.StudioRenderState
import uniffi.runova_ffi.StudioRenderView
import uniffi.runova_ffi.StudioRunView
import uniffi.runova_ffi.StudioSceneView
import uniffi.runova_ffi.StudioScreen
import uniffi.runova_ffi.StudioStepState
import uniffi.runova_ffi.StudioStepView
import uniffi.runova_ffi.StudioStyleView
import uniffi.runova_ffi.StudioVideoItemView
import uniffi.runova_ffi.StudioVideoView

private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val computer = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)

private val library = listOf(
    StudioVideoItemView("v1", "Launch film", "Opened 2h ago", true, false, null, null),
    StudioVideoItemView("v2", "Product teaser", "Opened 5m ago", false, false, "Encoding 50%", StudioRenderState.RUNNING),
    StudioVideoItemView("v3", "Onboarding tour", "Opened 3d ago", false, false, "Saved on this computer", StudioRenderState.DONE),
)

private val steps = listOf(
    StudioStepView("Scenes", "3 scenes", StudioStepState.DONE),
    StudioStepView("Animate", "1 of 3 scenes", StudioStepState.ACTIVE),
    StudioStepView("Render", "Not yet", StudioStepState.TODO),
)

private val scenes = listOf(
    StudioSceneView("a", 1u, "The problem", "Every team loses hours to the same small jobs.", "6s", true, true, "h", false, false),
    StudioSceneView("b", 2u, "Meet Runova", "One place for your agents, your code and your releases.", "8s", false, true, null, false, false),
    StudioSceneView("c", 3u, "Ship it", "Start free today.", "4s", false, true, null, false, false),
)

private fun video(
    run: StudioRunView? = null,
    proposal: StudioProposalView? = null,
    renders: List<StudioRenderView> = emptyList(),
    sheet: StudioRenderSheetView? = null,
    canRender: Boolean = false,
    problem: String? = null,
) = StudioVideoView(
    false, "v1", "Launch film", "16:9", "standard", true, "Edit scene", steps,
    if (run != null) scenes.map { it.copy(canAnimate = false) } else scenes,
    problem, run, proposal, renders, false,
    if (run == null) "Animate 2 scenes" else null, run == null, canRender, sheet,
)

private val liveRun = StudioRunView(
    "g1", "Animating a scene", "Claude Code, 1m 12s",
    listOf("Reading the scene", "Writing the animation", "Checking the frames"),
)

private val proposalCard = StudioProposalView(
    "g2", "Shorter opening, stronger last line",
    listOf(
        StudioChangeView(
            "The problem",
            listOf(StudioChangeField("Narration", "Every team loses hours to the same small jobs.", "Teams lose hours to small jobs.")),
        ),
    ),
)

private fun studio(
    videos: List<StudioVideoItemView> = library,
    composer: StudioComposerView? = null,
    open: StudioVideoView? = null,
    note: String? = null,
) = StudioScreen(false, note, videos, composer, open)

private val composerOptions = StudioComposerView(
    listOf(
        StudioLanguageView("en", "English", "English"),
        StudioLanguageView("fa", "Persian", "فارسی"),
        StudioLanguageView("de", "German", "Deutsch"),
    ),
    listOf(
        StudioStyleView("neon", "Neon grid", "Dark and glowing", listOf("#0B0B12", "#00E673", "#7C3AED", "#F59E0B")),
        StudioStyleView("paper", "Paper cut", "Warm and soft", listOf("#F5EFE0", "#D97757", "#3D5A80", "#293241")),
    ),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class StudioTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: StudioIntents = StudioIntents()) {
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = true) { AppRoot(view, "studio", {}, AppIntents(studio = intents)) }
            }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    private fun view(screen: StudioScreen, error: String? = null, busy: Boolean = false) =
        appView(connection = computer, studio = screen, error = error, busy = busy)

    @Test
    fun theLibraryLooksRight() {
        show(view(studio()))
        snapshot("studio")
    }

    @Test
    fun anEmptyLibraryStillOffersANewVideo() {
        var opened = 0
        show(view(studio(emptyList())), StudioIntents(openComposer = { opened++ }))

        compose.onNodeWithText("Your videos will show up here.").assertExists()
        compose.onNodeWithText("New video").performClick()

        assertEquals(1, opened)
    }

    @Test
    fun aComputerThatHasNotAllowedItSaysHow() {
        show(view(studio(emptyList(), note = "Turn on Studio for this phone.")))

        compose.onNodeWithText("Turn on Studio for this phone.").assertExists()
        compose.onNodeWithText("New video").assertDoesNotExist()
    }

    @Test
    fun aVideoOpensFromTheLibrary() {
        var opened = ""
        show(view(studio()), StudioIntents(openVideo = { opened = it }))

        compose.onNodeWithText("Product teaser").performClick()

        assertEquals("v2", opened)
    }

    @Test
    fun theComposerLooksRight() {
        show(view(studio(composer = composerOptions)))
        snapshot("studio-new")
    }

    @Test
    fun aNewVideoNeedsAPromptAndSendsTheChoices() {
        var sent: List<Any?> = emptyList()
        show(
            view(studio(composer = composerOptions)),
            StudioIntents(create = { brief, aspect, language, seconds, style -> sent = listOf(brief, aspect, language, seconds, style) }),
        )

        compose.onNodeWithText("Write the scenes").performClick()
        assertEquals(emptyList<Any?>(), sent)

        compose.onNodeWithContentDescription("What the video is about").performTextInput("A launch film")
        compose.onNodeWithText("Tall").performClick()
        compose.onNodeWithText("1 min").performClick()
        compose.onNodeWithText("Neon grid").performClick()
        compose.onNodeWithText("Deutsch").performClick()
        compose.onNodeWithText("Write the scenes").performClick()

        assertEquals(listOf("A launch film", "9:16", "de", 60u, "neon"), sent)
    }

    @Test
    fun aFailedCreateShowsWhyOnTheForm() {
        show(view(studio(composer = composerOptions), error = "Set up an AI CLI first."))

        compose.onNodeWithText("Set up an AI CLI first.").assertExists()
    }

    @Test
    fun theVideoLooksRight() {
        show(view(studio(open = video())))
        snapshot("studio-video")
    }

    @Test
    fun aRunShowsItsLinesAndCanBeStopped() {
        var stopped = 0
        show(view(studio(open = video(run = liveRun))), StudioIntents(cancelRun = { stopped++ }))
        snapshot("studio-run")

        compose.onNodeWithText("Writing the animation").assertExists()
        compose.onNodeWithText("Stop").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun whileARunIsGoingNothingElseCanStart() {
        show(view(studio(open = video(run = liveRun))))

        compose.onNodeWithText("Animate 2 scenes").assertDoesNotExist()
        // Only the step's own label is left.
        compose.onAllNodesWithText("Animate").assertCountEquals(1)
    }

    @Test
    fun aProposalShowsBeforeAndAfterAndCanBeApplied() {
        var applied = 0
        var discarded = 0
        show(
            view(studio(open = video(proposal = proposalCard))),
            StudioIntents(applyProposal = { applied++ }, discardProposal = { discarded++ }),
        )
        snapshot("studio-proposal")

        compose.onNodeWithText("Teams lose hours to small jobs.").assertExists()
        compose.onNodeWithText("Apply").performClick()
        compose.onNodeWithText("Discard").performClick()

        assertEquals(1, applied)
        assertEquals(1, discarded)
    }

    @Test
    fun oneSceneOrAllOfThemCanBeAnimated() {
        var scene = ""
        var all = 0
        show(view(studio(open = video())), StudioIntents(animate = { scene = it }, animateAll = { all++ }))

        // The first one is the step's label.
        compose.onAllNodesWithText("Animate")[1].performClick()
        compose.onNodeWithText("Animate 2 scenes").performClick()

        assertEquals("b", scene)
        assertEquals(1, all)
    }

    @Test
    fun askingTheAiSendsTheWords() {
        var asked = ""
        show(view(studio(open = video())), StudioIntents(ask = { asked = it }))

        compose.onNodeWithContentDescription("Ask AI to change something").performTextInput("Make it shorter")
        compose.onNodeWithContentDescription("Send").performClick()

        assertEquals("Make it shorter", asked)
    }

    @Test
    fun aRenderShowsProgressAndCanBeStopped() {
        var stopped = ""
        val render = StudioRenderView("r1", "Launch film 16-9 1080p.mp4", StudioRenderState.RUNNING, "Drawing frames: 40 of 100", 40.0, true)
        show(view(studio(open = video(renders = listOf(render)))), StudioIntents(cancelRender = { stopped = it }))
        snapshot("studio-rendering")

        compose.onNodeWithText("Stop").performClick()

        assertEquals("r1", stopped)
    }

    @Test
    fun theRenderSheetPicksAQuality() {
        var quality = ""
        val sheet = StudioRenderSheetView(false, "standard", "1920 x 1080, about 36 MB, about 2 minutes", emptyList(), emptyList())
        show(view(studio(open = video(sheet = sheet, canRender = true))), StudioIntents(render = { quality = it }))
        snapshot("studio-render-sheet")

        compose.onNodeWithText("Draft").performClick()
        compose.onNodeWithText("Render on this computer").performClick()

        assertEquals("draft", quality)
    }

    @Test
    fun aRenderThatCannotStartSaysWhy() {
        var quality = ""
        val sheet = StudioRenderSheetView(false, "standard", null, emptyList(), listOf("Animate every scene first."))
        show(view(studio(open = video(sheet = sheet))), StudioIntents(render = { quality = it }))

        compose.onNodeWithText("Animate every scene first.").assertExists()
        compose.onNodeWithText("Render on this computer").performClick()

        assertEquals("", quality)
    }

    @Test
    fun aProblemIsShownOnTheVideo() {
        show(view(studio(open = video(problem = "Animating stopped because a scene did not work."))))

        compose.onNodeWithText("Animating stopped because a scene did not work.").assertExists()
    }

    @Test
    fun studioIsReachedFromMore() {
        var tab = ""
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = true) { AppRoot(view(studio()), "more", { tab = it }, AppIntents()) }
            }
        }

        compose.onNodeWithText("Studio").performClick()

        assertEquals("studio", tab)
    }

    @Test
    fun theInputIsAField() {
        show(view(studio(composer = composerOptions)))
        compose.onNode(hasSetTextAction()).assertExists()
    }
}
