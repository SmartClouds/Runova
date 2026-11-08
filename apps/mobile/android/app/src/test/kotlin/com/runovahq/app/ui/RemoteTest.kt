package com.runovahq.app.ui

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.junit4.createComposeRule
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
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.RemoteKey
import uniffi.runova_ffi.RemotePhase
import uniffi.runova_ffi.RemotePointer
import uniffi.runova_ffi.RemoteView
import uniffi.runova_ffi.SystemView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private fun remote(
    phase: RemotePhase,
    error: String? = null,
    canUsePassword: Boolean = false,
    agent: Boolean = false,
    clipboard: String? = null,
    note: String? = null,
) = RemoteView(
    1,
    "Sam's desk",
    phase,
    error,
    canUsePassword,
    agent,
    1280u,
    720u,
    false,
    "483921",
    clipboard,
    note,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class RemoteTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, remoteIntents: RemoteIntents = RemoteIntents()) {
        compose.setContent {
            RunovaTheme(dark = true) { AppRoot(view, "remote", {}, AppIntents(remote = remoteIntents)) }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    private fun countOf(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().size

    @Test
    fun waitingForTheComputer() {
        show(appView(remote = remote(RemotePhase.REQUESTING)))
        compose.onNodeWithText("Reaching Sam's desk").assertExists()
        snapshot("remote-connecting")
    }

    @Test
    fun aRequestWaitingAtTheComputerCanSwitchToThePassword() {
        var asked = false
        show(
            appView(remote = remote(RemotePhase.WAITING_FOR_APPROVAL, canUsePassword = true)),
            RemoteIntents(usePassword = { asked = true }),
        )
        compose.onNodeWithText("Waiting at Sam's desk").assertExists()
        snapshot("remote-waiting")
        compose.onNodeWithText("Use password instead").performClick()
        assertTrue(asked)
    }

    @Test
    fun aComputerWithoutAPasswordJustWaits() {
        show(appView(remote = remote(RemotePhase.WAITING_FOR_APPROVAL)))
        compose.onNodeWithText("Waiting at Sam's desk").assertExists()
        assertEquals(0, countOf("Use password instead"))
    }

    @Test
    fun thePasswordScreenSubmitsWhatWasTypedAndShowsAWrongPassword() {
        var submitted: String? = null
        show(
            appView(remote = remote(RemotePhase.NEEDS_PASSWORD, error = "That password is not the one for this computer.")),
            RemoteIntents(submitPassword = { submitted = it }),
        )
        compose.onNodeWithText("That password is not the one for this computer.").assertExists()
        snapshot("remote-password")
        compose.onNode(hasSetTextAction()).performTextInput("correct horse")
        compose.onNodeWithText("Connect").performClick()
        assertEquals("correct horse", submitted)
    }

    @Test
    fun aFailureSaysWhyAndGoesBack() {
        var closed = false
        show(
            appView(remote = remote(RemotePhase.FAILED, error = "The connection to this computer ended.")),
            RemoteIntents(close = { closed = true }),
        )
        compose.onNodeWithText("The connection to this computer ended.").assertExists()
        snapshot("remote-failed")
        compose.onNodeWithText("Back").performClick()
        assertTrue(closed)
    }

    @Test
    fun theLiveScreenShowsItsToolbarAndWaitsForAPicture() {
        val keys = mutableListOf<RemoteKey>()
        val typed = mutableListOf<String>()
        var clipboard = false
        show(
            appView(remote = remote(RemotePhase.LIVE)),
            RemoteIntents(
                frames = RemoteFrames(),
                key = { keys.add(it) },
                text = { typed.add(it) },
                sendClipboard = { clipboard = true },
            ),
        )
        compose.onNodeWithText("Waiting for the screen").assertExists()
        snapshot("remote-live")

        compose.onNodeWithContentDescription("Keyboard").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Esc").performClick()
        assertEquals(listOf(RemoteKey.ESCAPE), keys)
        compose.onNodeWithText("Ctrl C").performScrollTo().performClick()
        assertEquals(RemoteKey.CTRL_C, keys.last())
        compose.onNodeWithContentDescription("Send clipboard").performClick()
        assertTrue(clipboard)
        compose.onNode(hasSetTextAction()).performTextInput("hello")
        compose.onNodeWithText("Send").performClick()
        assertEquals(listOf("hello"), typed)
        assertEquals(RemoteKey.ENTER, keys.last())
    }

    @Test
    fun aPictureFromTheCoreReplacesTheWaitingText() {
        val frames = RemoteFrames()
        frames.showForPreview(Bitmap.createBitmap(320, 180, Bitmap.Config.ARGB_8888))
        show(appView(remote = remote(RemotePhase.LIVE)), RemoteIntents(frames = frames))
        compose.onNodeWithContentDescription("Remote screen").assertIsDisplayed()
        assertEquals(0, countOf("Waiting for the screen"))
    }

    @Test
    fun clipboardTextFromTheComputerIsOfferedAndCopied() {
        val copied = mutableListOf<String>()
        var ignored = false
        show(
            appView(remote = remote(RemotePhase.LIVE, clipboard = "from the computer")),
            RemoteIntents(copyClipboard = { copied.add(it) }, clipboardTaken = { ignored = true }),
        )
        compose.onNodeWithText("The computer shared its clipboard.").assertExists()
        compose.onNodeWithText("Copy").performClick()
        assertEquals(listOf("from the computer"), copied)
        compose.onNodeWithText("Ignore").performClick()
        assertTrue(ignored)
    }

    @Test
    fun anAgentIsLabelledSo() {
        show(appView(remote = remote(RemotePhase.LIVE, agent = true)))
        compose.onNodeWithText("Agent").assertExists()
    }

    @Test
    fun aDeviceSectionOffersTheScreen() {
        val opened = mutableListOf<Long>()
        val connection = ConnectionView(7, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)
        show(appView(connection = connection), RemoteIntents(open = { opened.add(it) }))
        compose.onNodeWithText("Open screen").performClick()
        assertEquals(listOf(7L), opened)
    }

    @Test
    fun aComputerOnlyTheAgentAnswersForOpensTheScreenDirectly() {
        val opened = mutableListOf<Long>()
        val system = SystemView(5, "111222333", "Lab PC", "windows", true, true, false)
        compose.setContent {
            RunovaTheme(dark = true) {
                AppRoot(appView(systems = listOf(system)), "systems", {}, AppIntents(remote = RemoteIntents(open = { opened.add(it) })))
            }
        }
        compose.onNodeWithText("Lab PC").performClick()
        assertEquals(listOf(5L), opened)
    }
}

/** A real JPEG decoded by the same path the core drives, into a reused bitmap. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class RemoteFramesTest {
    private fun jpeg(width: Int, height: Int, color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out)
        return out.toByteArray()
    }

    @Test
    fun aTileIsPaintedAtItsPlace() {
        val frames = RemoteFrames()
        frames.onScreenSize(256u, 256u)
        org.robolectric.shadows.ShadowLooper.idleMainLooper()
        val bitmap = frames.bitmap
        assertNotNull(bitmap)

        frames.onTile(128u, 0u, 128u, 128u, jpeg(128, 128, Color.RED))
        org.robolectric.shadows.ShadowLooper.idleMainLooper()

        val inside = bitmap!!.getPixel(200, 60)
        assertTrue("expected red, got ${inside.toString(16)}", Color.red(inside) > 200 && Color.green(inside) < 80)
        assertEquals(Color.TRANSPARENT, bitmap.getPixel(10, 200))
    }

    @Test
    fun laterTilesReuseTheDecodeBitmap() {
        val frames = RemoteFrames()
        frames.onScreenSize(512u, 512u)
        org.robolectric.shadows.ShadowLooper.idleMainLooper()

        frames.onTile(0u, 0u, 128u, 128u, jpeg(128, 128, Color.RED))
        frames.onTile(128u, 0u, 128u, 128u, jpeg(128, 128, Color.BLUE))
        // A smaller edge tile still fits in the reused bitmap.
        frames.onTile(256u, 0u, 64u, 64u, jpeg(64, 64, Color.GREEN))
        org.robolectric.shadows.ShadowLooper.idleMainLooper()

        val bitmap = frames.bitmap!!
        assertTrue(Color.red(bitmap.getPixel(60, 60)) > 200)
        assertTrue(Color.blue(bitmap.getPixel(190, 60)) > 200)
        assertTrue(Color.green(bitmap.getPixel(280, 30)) > 180)
    }

    @Test
    fun stoppingReleasesEverything() {
        val frames = RemoteFrames()
        frames.onScreenSize(256u, 256u)
        org.robolectric.shadows.ShadowLooper.idleMainLooper()
        frames.onTile(0u, 0u, 64u, 64u, jpeg(64, 64, Color.GRAY))

        frames.onStopped()
        org.robolectric.shadows.ShadowLooper.idleMainLooper()

        assertNull(frames.bitmap)
    }
}

class RemoteMappingTest {
    @Test
    fun aWideScreenFitsThePhoneCentred() {
        val placed = fitContent(400f, 800f, 1600f, 900f, 1f, 0f, 0f)
        assertEquals(ContentRect(0f, 287.5f, 400f, 225f), placed)
    }

    @Test
    fun aPointInTheViewerBecomesAPositionOnTheScreen() {
        val placed = fitContent(400f, 800f, 1600f, 900f, 1f, 0f, 0f)
        val (x, y) = placed.normalized(200f, 400f)
        assertEquals(0.5, x, 0.0001)
        assertEquals(0.5, y, 0.0001)
    }

    @Test
    fun pointsPastTheEdgesAreKeptOnTheScreen() {
        val placed = fitContent(400f, 800f, 1600f, 900f, 1f, 0f, 0f)
        val (x, y) = placed.normalized(-50f, 900f)
        assertEquals(0.0, x, 0.0)
        assertEquals(1.0, y, 0.0)
    }

    @Test
    fun zoomingAndPanningStayWithinTheEdges() {
        val zoomed = fitContent(400f, 800f, 1600f, 900f, 2f, 1000f, 0f)
        assertEquals(800f, zoomed.width, 0.01f)
        assertEquals(0f, zoomed.left, 0.01f)
    }
}
