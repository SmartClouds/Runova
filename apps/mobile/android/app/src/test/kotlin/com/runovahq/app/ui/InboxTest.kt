package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
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
import uniffi.runova_ffi.NotificationDestination
import uniffi.runova_ffi.NotificationItemView
import uniffi.runova_ffi.NotificationPreferenceView
import uniffi.runova_ffi.NotificationsScreen
import uniffi.runova_ffi.Section

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val deploy = NotificationItemView(1, "Deploy failed on prod", "", "deploys", NotificationDestination.INBOX, false)
private val monitor = NotificationItemView(2, "Shop is down", "", "monitors", NotificationDestination.MONITORS, true)
private val preferences = listOf(
    NotificationPreferenceView("deploys", "Deploys", true),
    NotificationPreferenceView("monitors", "Monitors", false),
)

private fun inbox(
    items: List<NotificationItemView> = listOf(deploy, monitor),
    unread: UInt = 1u,
    settings: Boolean = false,
    banner: NotificationItemView? = null,
) = NotificationsScreen(items, unread, false, preferences, settings, banner)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class InboxTest {
    @get:Rule val compose = createComposeRule()

    private fun show(screen: NotificationsScreen, intents: NotificationIntents = NotificationIntents(), app: AppIntents = AppIntents(notifications = intents), tab: String = "inbox", onTab: (String) -> Unit = {}) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(appView(notifications = screen), tab, onTab, app) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theInboxShowsWhatArrived() {
        show(inbox())

        compose.onNodeWithText("Deploy failed on prod").assertExists()
        compose.onNodeWithText("New").assertExists()
        snapshot("inbox")
    }

    @Test
    fun itRefreshesOnlyWhileOnShow() {
        val sections = mutableListOf<Section?>()
        show(inbox(), app = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.NOTIFICATIONS), sections)
    }

    @Test
    fun anEmptyInboxSaysSo() {
        show(inbox(emptyList(), 0u))

        compose.onNodeWithText("Nothing new").assertExists()
    }

    @Test
    fun openingOneMarksItAndGoesWhereItIsAbout() {
        var opened = 0L
        var tab = ""
        show(inbox(), NotificationIntents(open = { opened = it }), onTab = { tab = it })

        compose.onNodeWithText("Shop is down").performClick()

        assertEquals(2L, opened)
        assertEquals("monitors", tab)
    }

    @Test
    fun allCanBeMarkedRead() {
        var marked = false
        show(inbox(), NotificationIntents(markAllRead = { marked = true }))

        compose.onNodeWithText("Mark all read").performClick()

        assertTrue(marked)
    }

    @Test
    fun settingsOpenFromTheInbox() {
        var opened = false
        show(inbox(), NotificationIntents(openSettings = { opened = true }))

        compose.onNodeWithText("Settings").performClick()

        assertTrue(opened)
    }

    @Test
    fun eachCategoryCanBeSwitched() {
        var switched: Pair<String, Boolean>? = null
        show(inbox(settings = true), NotificationIntents(setEnabled = { category, on -> switched = category to on }))

        compose.onNode(hasContentDescription("Monitors")).performClick()

        assertEquals("monitors" to true, switched)
        snapshot("inbox-settings")
    }

    @Test
    fun aBannerAppearsOverAnyScreenAndOpens() {
        var opened = 0L
        var tab = ""
        show(inbox(banner = monitor), NotificationIntents(open = { opened = it }), tab = "systems", onTab = { tab = it })

        compose.onNodeWithText("Shop is down").performClick()

        assertEquals(2L, opened)
        assertEquals("monitors", tab)
        snapshot("inbox-banner")
    }

    @Test
    fun aBannerCanBePutAway() {
        var dismissed = false
        show(inbox(banner = monitor), NotificationIntents(dismissBanner = { dismissed = true }), tab = "systems")

        compose.onNode(hasContentDescription("Dismiss")).performClick()

        assertTrue(dismissed)
    }
}
