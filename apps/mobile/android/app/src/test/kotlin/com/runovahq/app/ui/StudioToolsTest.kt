package com.runovahq.app.ui

import androidx.compose.runtime.CompositionLocalProvider
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
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.StudioClipView
import uniffi.runova_ffi.StudioDownloadState
import uniffi.runova_ffi.StudioDownloadView
import uniffi.runova_ffi.StudioMediaView
import uniffi.runova_ffi.StudioNarrationView
import uniffi.runova_ffi.StudioRenderState
import uniffi.runova_ffi.StudioRenderView
import uniffi.runova_ffi.StudioSceneView
import uniffi.runova_ffi.StudioScreen
import uniffi.runova_ffi.StudioStepState
import uniffi.runova_ffi.StudioStepView
import uniffi.runova_ffi.StudioTimelineView
import uniffi.runova_ffi.StudioToolsScreen
import uniffi.runova_ffi.StudioTrackView
import uniffi.runova_ffi.StudioVideoView
import uniffi.runova_ffi.StudioVoiceEngineView
import uniffi.runova_ffi.StudioVoiceOptionView
import uniffi.runova_ffi.StudioVoiceView

private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val computer = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, "483921", true, null)

private val finished = StudioRenderView("r1", "Launch film.mp4", StudioRenderState.DONE, "Saved on this computer", null, false)

private val scenes = listOf(
    StudioSceneView("a", 1u, "The problem", "Every team loses hours.", "6s", true, true, "h", false, true),
    StudioSceneView("b", 2u, "Meet Runova", "One place for everything.", "8s", true, true, "i", false, false),
)

private fun video(renders: List<StudioRenderView> = emptyList()) = StudioVideoView(
    false, "v1", "Launch film", "16:9", "standard", false, null,
    listOf(StudioStepView("Scenes", "2 scenes", StudioStepState.DONE)),
    scenes, null, null, null, renders, false, null, true, true, null,
)

private val voice = StudioVoiceView(
    false,
    listOf(
        StudioVoiceEngineView("openai", "OpenAI", null, false, false),
        StudioVoiceEngineView("elevenlabs", "ElevenLabs", "The vault is locked", true, false),
    ),
    "openai",
    listOf(StudioVoiceOptionView("Alloy", "openai:alloy", false), StudioVoiceOptionView("Nova", "openai:nova", false)),
    "openai:alloy",
    "About $0.12",
    0.12,
    true,
    2u,
    null,
)

private val song = StudioClipView("c1", "Song.mp3", "2s, 5s", 0.2, 0.5, 2.0, 5.0, 1.0, false)

private val timeline = StudioTimelineView(
    false,
    7,
    "10s",
    listOf(
        StudioTrackView("t1", "scene", "Scenes", false, true, listOf(StudioClipView("s1", "The problem", "0s, 6s", 0.0, 0.6, 0.0, 6.0, 1.0, false))),
        StudioTrackView("t2", "music", "Music", false, false, listOf(song)),
    ),
    false,
    listOf(StudioMediaView("abc", "Backing.mp3", "3m 02s")),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class StudioToolsTest {
    @get:Rule val compose = createComposeRule()

    private fun show(tools: StudioToolsScreen, renders: List<StudioRenderView> = emptyList(), intents: StudioIntents = StudioIntents()) {
        val view: AppView = appView(
            connection = computer,
            studio = StudioScreen(false, null, emptyList(), null, video(renders)),
            studioTools = tools,
        )
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = true) { AppRoot(view, "studio", {}, AppIntents(studio = intents)) }
            }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun voiceAndTimelineOpenFromTheVideo() {
        var voiceOpened = 0
        var timelineOpened = 0
        show(StudioToolsScreen(null, null, null, null), intents = StudioIntents(openVoice = { voiceOpened++ }, openTimeline = { timelineOpened++ }))

        compose.onNodeWithText("Voice").performClick()
        compose.onNodeWithText("Timeline").performClick()

        assertEquals(1, voiceOpened)
        assertEquals(1, timelineOpened)
    }

    @Test
    fun theVoiceSheetPicksAndSpeaks() {
        var engine = ""
        var picked = ""
        var spoken = 0
        show(
            StudioToolsScreen(voice, null, null, null),
            intents = StudioIntents(pickEngine = { engine = it }, pickVoice = { picked = it }, speak = { spoken++ }),
        )
        snapshot("studio-voice")

        compose.onNodeWithText("About $0.12").assertExists()
        compose.onNodeWithText("ElevenLabs").performClick()
        compose.onNodeWithText("Nova").performClick()
        compose.onNodeWithText("Speak 2 scenes").performClick()

        assertEquals("elevenlabs", engine)
        assertEquals("openai:nova", picked)
        assertEquals(1, spoken)
    }

    @Test
    fun nothingIsSpokenBeforeThePriceIsKnown() {
        var spoken = 0
        show(StudioToolsScreen(voice.copy(priceLabel = null), null, null, null), intents = StudioIntents(speak = { spoken++ }))

        compose.onNodeWithText("Speak 2 scenes").performClick()

        assertEquals(0, spoken)
    }

    @Test
    fun narrationShowsItsProgressAndStops() {
        var stopped = 0
        show(StudioToolsScreen(null, StudioNarrationView("n1", "Speaking 1 of 4", 25.0, true), null, null), intents = StudioIntents(cancelSpeak = { stopped++ }))

        compose.onNodeWithText("Speaking 1 of 4").assertExists()
        compose.onNodeWithText("Stop").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun aVoicedSceneCanGetCaptions() {
        var captioned = ""
        show(StudioToolsScreen(null, null, null, null), intents = StudioIntents(caption = { captioned = it }))

        compose.onNodeWithText("Captions").performClick()

        assertEquals("a", captioned)
    }

    @Test
    fun theTimelineSelectsAClipAndEditsIt() {
        var moved = 0.0
        var gain = -1.0
        show(
            StudioToolsScreen(null, null, timeline, null),
            intents = StudioIntents(nudge = { _, seconds -> moved = seconds }, gain = { _, value -> gain = value }),
        )
        snapshot("studio-timeline")

        compose.onNodeWithContentDescription("Song.mp3").performClick()
        snapshot("studio-timeline-clip")
        compose.onNodeWithText("Move").assertExists()
        compose.onNodeWithText("50%").performClick()

        assertEquals(0.5, gain, 0.0)
        assertEquals(0.0, moved, 0.0)
    }

    @Test
    fun musicCanBeAddedAndATrackMuted() {
        var added = ""
        var muted: Pair<String, Boolean>? = null
        show(
            StudioToolsScreen(null, null, timeline, null),
            intents = StudioIntents(addMusic = { added = it }, muteTrack = { id, value -> muted = id to value }),
        )

        compose.onNodeWithText("Add").performClick()
        compose.onNodeWithText("Mute").performClick()

        assertEquals("abc", added)
        assertEquals("t2" to true, muted)
    }

    @Test
    fun aFinishedRenderCanComeToThePhone() {
        var job = ""
        show(StudioToolsScreen(null, null, null, null), listOf(finished), StudioIntents(download = { job = it }))

        compose.onNodeWithText("Get on this phone").performClick()

        assertEquals("r1", job)
    }

    @Test
    fun aDownloadShowsItsProgressAndStops() {
        var stopped = 0
        val running = StudioDownloadView("r1", "Launch film.mp4", "38 MB", 42.0, StudioDownloadState.RUNNING, null, null, false)
        show(StudioToolsScreen(null, null, null, running), listOf(finished), StudioIntents(downloadStop = { stopped++ }))
        snapshot("studio-download")

        compose.onNodeWithText("42% of 38 MB").assertExists()
        compose.onNodeWithText("Stop").performClick()

        assertEquals(1, stopped)
    }

    @Test
    fun aFinishedDownloadCanBeShared() {
        var shared = ""
        val done = StudioDownloadView("r1", "Launch film.mp4", "38 MB", 100.0, StudioDownloadState.DONE, "/files/Launch film.mp4", null, true)
        show(StudioToolsScreen(null, null, null, done), listOf(finished), StudioIntents(shareVideo = { shared = it }))

        compose.onNodeWithText("It uses a voice licensed for non-commercial use only.").assertExists()
        compose.onNodeWithText("Share or save").performClick()

        assertEquals("/files/Launch film.mp4", shared)
    }
}
