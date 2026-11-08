package com.runovahq.app.ui

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
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.ProjectView
import uniffi.runova_ffi.SystemView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private fun system(id: Long, name: String, online: Boolean = true, canManage: Boolean = true) =
    SystemView(id, "111222333", name, "windows", online, true, canManage)

private val systems = listOf(
    system(1, "Sam's desk"),
    system(2, "Build server", online = false),
    system(3, "Office PC", canManage = false),
)

private fun view(
    auth: AuthState = AuthState.SIGNED_IN,
    list: List<SystemView> = systems,
    connection: ConnectionView? = null,
    projects: List<ProjectView> = emptyList(),
    projectsLoading: Boolean = false,
    error: String? = null,
) = AppView(auth, true, list, false, connection, projects, projectsLoading, null, emptyList(), false, null, emptyList(), error)

private fun connection(
    phase: ConnectionPhase,
    error: String? = null,
) = ConnectionView(1, "Sam's desk", phase, "483921".takeIf { phase == ConnectionPhase.CONNECTED }, true.takeIf { phase == ConnectionPhase.CONNECTED }, error)

private val project = ProjectView("p1", "Website", listOf("web", "astro"), true, true, null, null)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class ScreensTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: AppIntents = AppIntents(), dark: Boolean = true) {
        compose.setContent { RunovaTheme(dark = dark) { AppRoot(view, "systems", {}, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun signInRunsTheIntent() {
        var signedIn = false
        show(view(AuthState.SIGNED_OUT, emptyList()), AppIntents(signIn = { signedIn = true }))

        compose.onNodeWithText("Sign in").performClick()

        assertTrue(signedIn)
        snapshot("sign-in")
    }

    @Test
    fun signInShowsWhyItFailed() {
        show(view(AuthState.SIGNED_OUT, emptyList(), error = "Sign-in was cancelled."))

        compose.onNodeWithText("Sign-in was cancelled.").assertExists()
    }

    @Test
    fun anOnlineComputerOpens() {
        var opened = -1L
        show(view(), AppIntents(connect = { opened = it }))

        compose.onNodeWithText("Sam's desk").performClick()

        assertEquals(1L, opened)
        snapshot("systems-dark")
    }

    @Test
    fun systemsInLightTheme() {
        show(view(), dark = false)

        snapshot("systems-light")
    }

    @Test
    fun anOfflineComputerDoesNotOpen() {
        var opened = false
        show(view(), AppIntents(connect = { opened = true }))

        compose.onNodeWithText("Build server").performClick()

        assertTrue(!opened)
        compose.onNodeWithText("Offline").assertExists()
    }

    @Test
    fun aComputerOnlyTheAgentKeepsOnlineSaysSo() {
        show(view())

        compose.onNodeWithText("Screen only").assertExists()
    }

    @Test
    fun noComputersExplainsWhatToDo() {
        show(view(list = emptyList()))

        compose.onNodeWithText("No computers yet").assertExists()
    }

    @Test
    fun waitingAsksForApprovalOnTheComputer() {
        show(view(connection = connection(ConnectionPhase.WAITING_FOR_APPROVAL)))

        compose.onNodeWithText("Approve on Sam's desk").assertExists()
        snapshot("waiting-for-approval")
    }

    @Test
    fun aFailureSaysWhyAndOffersARetry() {
        var retried = -1L
        show(
            view(connection = connection(ConnectionPhase.FAILED, "This computer is offline.")),
            AppIntents(connect = { retried = it }),
        )

        compose.onNodeWithText("This computer is offline.").assertExists()
        compose.onNodeWithText("Try again").performClick()

        assertEquals(1L, retried)
        snapshot("connection-failed")
    }

    @Test
    fun connectedShowsTheRouteTheSafetyCodeAndProjects() {
        show(view(connection = connection(ConnectionPhase.CONNECTED), projects = listOf(project)))

        compose.onNodeWithText("Direct").assertExists()
        compose.onNodeWithText("Safety code 483921").assertExists()
        compose.onNodeWithText("Website").assertExists()
        compose.onNodeWithText("web, astro").assertExists()
        snapshot("projects")
    }

    @Test
    fun aComputerWithNoProjectsSaysSo() {
        show(view(connection = connection(ConnectionPhase.CONNECTED)))

        compose.onNodeWithText("No projects yet").assertExists()
    }
}
