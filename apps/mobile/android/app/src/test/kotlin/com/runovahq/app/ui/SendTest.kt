package com.runovahq.app.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
import uniffi.runova_ffi.SendBatchView
import uniffi.runova_ffi.SendFileState
import uniffi.runova_ffi.SendFileView
import uniffi.runova_ffi.SendPhase
import uniffi.runova_ffi.SendScreen
import uniffi.runova_ffi.SendTargetView
import uniffi.runova_ffi.SystemView

/** Sending files from the phone (E113): picking, choosing a computer, and each send as it goes. */

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val desk = SendTargetView(5, "Sam's desk", "windows", true, true, true, null)
private val laptop = SendTargetView(6, "Travel laptop", "macos", true, false, false, "Offline")
private val kims = SendTargetView(7, "Kim's PC", "windows", false, true, true, null)

private fun file(id: String, name: String, state: SendFileState, percent: Int, folder: String? = null, error: String? = null) =
    SendFileView(id, name, folder, "2.4 MB", state, percent.toUByte(), error)

private val sending = SendBatchView(
    "b1", 5, "To Sam's desk", "Sending 2 of 3, 18 MB/s, about 1 min left", SendPhase.SENDING,
    3u, 1u, 0u, 7_000_000uL, 3_100_000uL, 44u, "3 files, 6.7 MB", "For the trip",
    listOf(
        file("t1", "IMG_2041.jpg", SendFileState.DONE, 100, folder = "Holiday"),
        file("t2", "IMG_2042.jpg", SendFileState.SENDING, 30, folder = "Holiday"),
        file("t3", "notes.txt", SendFileState.QUEUED, 0),
    ),
    0u, true, false, false,
)

private val declined = SendBatchView(
    "b2", 7, "To Kim's PC", "Declined on Kim's PC", SendPhase.DECLINED,
    1u, 0u, 0u, 2_400_000uL, 0uL, 0u, "1 file, 2.4 MB", null,
    listOf(file("t4", "report.pdf", SendFileState.QUEUED, 0)),
    0u, false, true, true,
)

private val desktop = SystemView(5, "111222333", "Sam's desk", "windows", true, true, true)

private fun screen(
    targets: List<SendTargetView> = listOf(desk, laptop, kims),
    batches: List<SendBatchView> = emptyList(),
    error: String? = null,
    active: Int = 0,
    label: String? = null,
) = SendScreen(targets, batches, error, active.toUInt(), label, 44u)

private fun staged(vararg paths: String) = paths.mapIndexed { i, path ->
    StagedFile("h$i", path, 1_200_000L * (i + 1))
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class SendTest {
    @get:Rule val compose = createComposeRule()

    private fun show(send: SendScreen, intents: SendIntents = SendIntents(), dark: Boolean = true, open: Boolean = true) {
        if (open) intents.picks.open = true
        compose.setContent {
            CompositionLocalProvider(LocalMotion provides false) {
                RunovaTheme(dark = dark) {
                    AppRoot(appView(systems = listOf(desktop), send = send), "systems", {}, AppIntents(send = intents))
                }
            }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theSystemsTabOpensSendingFiles() {
        val intents = SendIntents()
        show(screen(), intents, open = false)

        compose.onNodeWithContentDescription("Send files").performClick()

        assertTrue(intents.picks.open)
        compose.onNodeWithText("Pick what to send").assertExists()
    }

    @Test
    fun nothingPickedSaysWhatCanGoAndOffersEachPicker() {
        val asked = mutableListOf<String>()
        show(
            screen(),
            SendIntents(
                pickFiles = { asked += "files" },
                pickPhotos = { asked += "photos" },
                pickFolder = { asked += "folder" },
            ),
        )

        compose.onNodeWithText("Files, photos or a whole folder", substring = true).assertExists()
        snapshot("send-empty")
        compose.onNodeWithText("Files").performClick()
        compose.onNodeWithText("Photos").performClick()
        compose.onNodeWithText("Folder").performClick()
        assertEquals(listOf("files", "photos", "folder"), asked)
    }

    @Test
    fun aPickedFolderIsOneRowAndCanBeTakenOutWhole() {
        val intents = SendIntents()
        intents.picks.add(staged("report.pdf", "Holiday/beach.jpg", "Holiday/notes.txt", "Holiday/Day 2/pier.jpg"))
        show(screen(), intents)

        compose.onNodeWithText("report.pdf").assertExists()
        compose.onNodeWithText("Holiday").assertExists()
        compose.onNodeWithText("3 files, ", substring = true).assertExists()
        compose.onNodeWithText("4 files, ", substring = true).assertExists()

        compose.onNodeWithContentDescription("Take out Holiday").performClick()

        assertEquals(listOf("report.pdf"), intents.picks.files.map { it.path })
    }

    @Test
    fun aComputerThatCanNotTakeFilesSaysWhyAndCanNotBeChosen() {
        val intents = SendIntents()
        intents.picks.add(staged("report.pdf"))
        show(screen(), intents)

        compose.onNodeWithText("Offline").performScrollTo().assertExists()
        compose.onNodeWithText("Travel laptop").performClick()

        assertEquals(null, intents.picks.target)
        compose.onNodeWithText("Kim's PC").performScrollTo().assertExists()
        compose.onNodeWithText("Teammates' computers").assertExists()
    }

    @Test
    fun theButtonSaysWhatGoesWhereAndSendsIt() {
        var sent: Triple<Long, List<String>, String?>? = null
        val intents = SendIntents(send = { system, files, note -> sent = Triple(system, files.map { it.path }, note) })
        intents.picks.add(staged("a.jpg", "b.jpg", "c.jpg"))
        show(screen(), intents)

        compose.onNodeWithText("Sam's desk").performScrollTo().performClick()
        compose.onNodeWithContentDescription("A note for the other side").performScrollTo().performTextInput("For the trip")
        snapshot("send-ready")
        compose.onNodeWithText("Send 3 files to Sam's desk").performScrollTo().performClick()

        assertEquals(Triple(5L, listOf("a.jpg", "b.jpg", "c.jpg"), "For the trip"), sent)
        assertTrue(intents.picks.files.isEmpty())
        assertEquals("", intents.picks.note)
    }

    @Test
    fun theButtonSaysWhatIsMissing() {
        val intents = SendIntents()
        show(screen(), intents)

        compose.onNodeWithText("Send").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Pick files to send first.").assertExists()

        intents.picks.add(staged("a.jpg"))
        compose.onNodeWithText("Choose a computer to send to.").performScrollTo().assertExists()
    }

    @Test
    fun aSendGoingShowsHowFarItIsAndCanBeCancelled() {
        var cancelled: String? = null
        show(screen(batches = listOf(sending, declined), active = 1), SendIntents(cancel = { cancelled = it }))

        compose.onNodeWithText("Sending 2 of 3, 18 MB/s, about 1 min left").performScrollTo().assertExists()
        compose.onNodeWithText("“For the trip”").assertExists()
        snapshot("send-progress")
        compose.onNodeWithText("Cancel").performScrollTo().performClick()

        assertEquals("b1", cancelled)
    }

    @Test
    fun aSendGoingLooksRightInTheLightTheme() {
        show(screen(batches = listOf(sending, declined), active = 1), dark = false)

        compose.onNodeWithText("To Sam's desk").performScrollTo()
        snapshot("send-progress-light")
    }

    @Test
    fun eachFileOfASendCanBeSeen() {
        show(screen(batches = listOf(sending)))

        compose.onNodeWithText("Show files").performScrollTo().performClick()

        compose.onNodeWithText("IMG_2042.jpg").performScrollTo().assertExists()
        compose.onAllNodesWithText("Holiday · 2.4 MB").assertCountEquals(2)
        compose.onNodeWithText("2.4 MB").assertExists()
    }

    @Test
    fun aFinishedSendCanGoAgainOrBePutAway() {
        val did = mutableListOf<String>()
        show(
            screen(batches = listOf(declined)),
            SendIntents(
                retry = { did += "retry $it" },
                dismiss = { did += "dismiss $it" },
                clearFinished = { did += "clear" },
            ),
        )

        compose.onNodeWithText("Declined on Kim's PC").performScrollTo().assertExists()
        compose.onNodeWithText("Send again").performScrollTo().performClick()
        compose.onNodeWithText("Dismiss").performScrollTo().performClick()
        compose.onNodeWithText("Clear finished").performScrollTo().performClick()

        assertEquals(listOf("retry b2", "dismiss b2", "clear"), did)
    }

    @Test
    fun whatTheCoreTurnedDownIsShownAndCanBeDismissed() {
        var dismissed = false
        show(screen(error = "You can send up to 10,000 files at a time."), SendIntents(dismissError = { dismissed = true }))

        compose.onNodeWithText("You can send up to 10,000 files at a time.").performScrollTo().assertExists()
        compose.onNodeWithContentDescription("Dismiss the error").performClick()

        assertTrue(dismissed)
    }

    @Test
    fun aSendGoingShowsOnTheSystemsTab() {
        val intents = SendIntents()
        show(screen(batches = listOf(sending), active = 1, label = "Sending to Sam's desk, 44%"), intents, open = false)

        compose.onNodeWithText("Sending to Sam's desk, 44%").performClick()

        assertTrue(intents.picks.open)
    }
}
