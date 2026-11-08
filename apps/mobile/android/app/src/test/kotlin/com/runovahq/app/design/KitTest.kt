package com.runovahq.app.design

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Text anti-aliasing differs a little between the computers that run this. */
@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class KitTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun buttonRunsItsAction() {
        var taps = 0
        compose.setContent { RunovaTheme(dark = true) { RunovaButton("Connect", onClick = { taps++ }) } }

        compose.onNodeWithText("Connect").performClick()

        assertEquals(1, taps)
    }

    @Test
    fun disabledButtonDoesNothing() {
        var taps = 0
        compose.setContent {
            RunovaTheme(dark = true) { RunovaButton("Connect", onClick = { taps++ }, enabled = false) }
        }

        compose.onNodeWithText("Connect").assertIsNotEnabled()
        assertEquals(0, taps)
    }

    @Test
    fun textFieldReportsWhatIsTyped() {
        var text by mutableStateOf("")
        compose.setContent {
            RunovaTheme(dark = true) {
                RunovaTextField(value = text, onValueChange = { text = it }, placeholder = "Search")
            }
        }

        compose.onNodeWithText("Search").performTextInput("web")

        assertEquals("web", text)
    }

    @Test
    fun bottomBarSelectsATab() {
        var chosen = ""
        compose.setContent {
            RunovaTheme(dark = true) { RunovaBottomBar(GalleryTabs, "systems") { chosen = it } }
        }

        compose.onNodeWithText("Alerts").performClick()

        assertEquals("alerts", chosen)
    }

    @Test
    fun backButtonIsNamedForScreenReaders() {
        var back = false
        compose.setContent { RunovaTheme(dark = true) { RunovaTopBar("Git", onBack = { back = true }) } }

        compose.onNodeWithContentDescription("Back").performClick()

        assertTrue(back)
    }

    @Test
    fun iconLabelIsReadOut() {
        compose.setContent {
            RunovaTheme(dark = true) {
                RunovaIcon(RunovaIcons.Warning, Modifier.size(20.dp), label = "Needs attention")
            }
        }

        compose.onNodeWithContentDescription("Needs attention").assertExists()
    }

    @Test
    fun darkAndLightPalettesAreTheDesktops() {
        assertEquals(0xFF00E673.toInt(), RunovaTokens.Dark.primary.value.shr(32).toInt())
        assertEquals(0xFF00753B.toInt(), RunovaTokens.Light.primary.value.shr(32).toInt())
    }

    @Test
    fun galleryDark() {
        compose.setContent { RunovaTheme(dark = true) { KitGallery() } }
        compose.onRoot().captureRoboImage("src/test/snapshots/kit-dark.png", SCREENSHOTS)
    }

    @Test
    fun galleryLight() {
        compose.setContent { RunovaTheme(dark = false) { KitGallery() } }
        compose.onRoot().captureRoboImage("src/test/snapshots/kit-light.png", SCREENSHOTS)
    }
}
