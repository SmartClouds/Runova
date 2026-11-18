package com.runovahq.app.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
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
import uniffi.runova_ffi.IncomingOfferView
import uniffi.runova_ffi.OfferFileView
import uniffi.runova_ffi.ReceivePhase
import uniffi.runova_ffi.ReceiveScreen
import uniffi.runova_ffi.ReceivedBatchView
import uniffi.runova_ffi.ReceivedFileView
import uniffi.runova_ffi.SendFileState

/** Files sent to the phone (E114): the question, what came in, and whether the phone takes files. */

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val offer = IncomingOfferView(
    "r1", "Sam's desk", "Sam", "Sam's desk wants to send you 3 files", "3 files, 4.2 MB", "Slides for tomorrow",
    listOf(
        OfferFileView("deck.pdf", null, "3.1 MB"),
        OfferFileView("beach.jpg", "Holiday", "1.0 MB"),
        OfferFileView("notes.txt", "Holiday", "2 KB"),
    ),
    0u,
)

private val received = ReceivedBatchView(
    "r2", "From Sam's desk", "Received 2 files, 1.2 MB, verified", ReceivePhase.DONE,
    2u, 2u, 0u, 1_200_000uL, 1_200_000uL, 100u, "2 files, 1.2 MB", null,
    listOf(
        ReceivedFileView("f0", "report.pdf", null, "1.1 MB", SendFileState.DONE, 100u, "/files/Received/report.pdf", null),
        ReceivedFileView("f1", "notes.txt", "Trip", "2 KB", SendFileState.DONE, 100u, "/files/Received/Trip/notes.txt", null),
    ),
    0u, false, true,
)

private val coming = ReceivedBatchView(
    "r3", "From Office PC", "Receiving 1 of 1, 4 MB/s, less than a minute left", ReceivePhase.RECEIVING,
    1u, 0u, 0u, 9_000_000uL, 3_000_000uL, 33u, "1 file, 8.6 MB", null,
    listOf(ReceivedFileView("f2", "video.mp4", null, "8.6 MB", SendFileState.SENDING, 33u, null, null)),
    0u, true, false,
)

private fun screen(
    offers: List<IncomingOfferView> = emptyList(),
    batches: List<ReceivedBatchView> = emptyList(),
    enabled: Boolean = true,
    autoAccept: Boolean = false,
    label: String? = null,
) = ReceiveScreen(enabled, autoAccept, true, offers, batches, batches.count { it.canCancel }.toUInt(), label, 33u)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class ReceiveTest {
    @get:Rule val compose = createComposeRule()

    private fun show(
        receive: ReceiveScreen,
        intents: ReceiveIntents = ReceiveIntents(),
        dark: Boolean = true,
        sendOpen: Boolean = false,
    ) {
        val send = SendIntents()
        send.picks.open = sendOpen
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = dark) {
                    AppRoot(appView(receive = receive), "systems", {}, AppIntents(send = send, receive = intents))
                }
            }
        }
    }

    /** Brings a row of the Send files screen into view; rows far down are only drawn once there. */
    private fun reach(matcher: SemanticsMatcher) {
        compose.onNode(hasScrollAction()).performScrollToNode(matcher)
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun filesOnTheirWayAskFirstWhateverIsOnShow() {
        val answers = mutableListOf<Pair<String, Boolean>>()
        show(screen(offers = listOf(offer)), ReceiveIntents(answer = { id, yes -> answers += id to yes }))

        compose.onNodeWithText("Sam's desk wants to send you 3 files").assertExists()
        compose.onNodeWithText("“Slides for tomorrow”").assertExists()
        compose.onNodeWithText("beach.jpg").assertExists()
        compose.onNodeWithText("Holiday · 1.0 MB").assertExists()
        snapshot("receive-offer")

        compose.onNodeWithText("Accept").performClick()
        compose.onNodeWithText("Decline").performClick()

        assertEquals(listOf("r1" to true, "r1" to false), answers)
    }

    @Test
    fun theQuestionLooksRightInTheLightTheme() {
        show(screen(offers = listOf(offer)), dark = false)

        compose.onNodeWithText("Accept").assertExists()
        snapshot("receive-offer-light")
    }

    @Test
    fun whatCameInCanBeOpenedOrShared() {
        val did = mutableListOf<String>()
        show(
            screen(batches = listOf(coming, received)),
            ReceiveIntents(open = { did += "open $it" }, share = { did += "share $it" }, cancel = { did += "cancel $it" }),
            sendOpen = true,
        )

        reach(hasText("From Sam's desk"))
        compose.onNodeWithText("From Sam's desk").assertExists()
        reach(hasContentDescription("Open report.pdf"))
        compose.onNodeWithContentDescription("Open report.pdf").performClick()
        reach(hasContentDescription("Share notes.txt"))
        compose.onNodeWithContentDescription("Share notes.txt").performClick()
        reach(hasText("Stop"))
        compose.onNodeWithText("Stop").performClick()
        reach(hasText("Receiving 1 of 1, 4 MB/s, less than a minute left"))
        snapshot("receive-list")

        assertEquals(
            listOf("open /files/Received/report.pdf", "share /files/Received/Trip/notes.txt", "cancel r3"),
            did,
        )
    }

    @Test
    fun finishedFilesCanBePutAway() {
        val did = mutableListOf<String>()
        show(
            screen(batches = listOf(received)),
            ReceiveIntents(dismiss = { did += "dismiss $it" }, clear = { did += "clear" }),
            sendOpen = true,
        )

        reach(hasText("Dismiss"))
        compose.onNodeWithText("Dismiss").performClick()
        reach(hasText("Clear received"))
        compose.onNodeWithText("Clear received").performClick()

        assertEquals(listOf("dismiss r2", "clear"), did)
    }

    @Test
    fun whetherThePhoneTakesFilesIsTheOwnersToSay() {
        val did = mutableListOf<String>()
        show(
            screen(),
            ReceiveIntents(setEnabled = { did += "enabled $it" }, setAutoAccept = { did += "auto $it" }),
            sendOpen = true,
        )

        reach(hasText("RECEIVING ON THIS PHONE"))
        reach(hasContentDescription("Take files from my computers"))
        compose.onNodeWithContentDescription("Take files from my computers").performClick()
        reach(hasContentDescription("Accept from my computers without asking"))
        compose.onNodeWithContentDescription("Accept from my computers without asking").performClick()

        assertEquals(listOf("enabled false", "auto true"), did)
    }

    @Test
    fun filesComingInShowOnTheSystemsTab() {
        val send = SendIntents()
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = true) {
                    AppRoot(
                        appView(receive = screen(batches = listOf(coming), label = "Receiving from Office PC, 33%")),
                        "systems",
                        {},
                        AppIntents(send = send),
                    )
                }
            }
        }

        compose.onNodeWithText("Receiving from Office PC, 33%").performClick()

        assertTrue(send.picks.open)
    }
}
