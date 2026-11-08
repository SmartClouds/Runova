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
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.BackupView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.ContainerLogsView
import uniffi.runova_ffi.ContainerView
import uniffi.runova_ffi.DeployScreen
import uniffi.runova_ffi.DeployServerView
import uniffi.runova_ffi.LogLineView
import uniffi.runova_ffi.ProblemSeverity
import uniffi.runova_ffi.ProblemView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.ServerDetailView
import uniffi.runova_ffi.StackView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)
private val servers = listOf(
    DeployServerView("srv1", "Prod", "10.0.0.1", "Online", true, null),
    DeployServerView("srv2", "Lab", "10.0.0.2", "Needs sign-in", false, null),
)
private val running = ContainerView("c1", "web", "nginx", "Up 2 hours", true, true)
private val stopped = ContainerView("c2", "db", "postgres", "Exited (1)", false, false)

private fun server(unreachable: String? = null) = ServerDetailView(
    "srv1",
    "Prod",
    false,
    unreachable,
    if (unreachable == null) listOf(running, stopped) else emptyList(),
    if (unreachable == null) listOf(StackView("s1", "shop", "running", "2 of 3 running", true)) else emptyList(),
    if (unreachable == null) listOf(ProblemView("p1", ProblemSeverity.CRITICAL, "db keeps restarting", "3 restarts")) else emptyList(),
    if (unreachable == null) BackupView("Nightly: failed", "Disk full", true) else null,
)

private fun view(screen: DeployScreen) = appView(connection = connected, deploy = screen)

private fun list() = DeployScreen(servers, false, null, null)
private fun detail(unreachable: String? = null) = DeployScreen(servers, false, server(unreachable), null)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class DeployTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, deploy: DeployIntents = DeployIntents(), intents: AppIntents = AppIntents(deploy = deploy)) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "deploy", {}, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun serversAreListedWithTheirState() {
        show(view(list()))

        compose.onNodeWithText("Online").assertExists()
        compose.onNodeWithText("Needs sign-in").assertExists()
        snapshot("deploy")
    }

    @Test
    fun itRefreshesOnlyWhileOnShow() {
        val sections = mutableListOf<Section?>()
        show(view(list()), intents = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.DEPLOY), sections)
    }

    @Test
    fun noServersSaysSo() {
        show(view(DeployScreen(emptyList(), false, null, null)))

        compose.onNodeWithText("No servers yet").assertExists()
    }

    @Test
    fun aServerOpens() {
        var opened = ""
        show(view(list()), DeployIntents(openServer = { opened = it }))

        compose.onNodeWithText("Prod").performClick()

        assertEquals("srv1", opened)
    }

    @Test
    fun anOverviewShowsProblemsContainersAppsAndBackups() {
        show(view(detail()))

        compose.onNodeWithText("db keeps restarting").assertExists()
        compose.onNodeWithText("web").assertExists()
        compose.onNodeWithText("shop").assertExists()
        compose.onNodeWithText("Nightly: failed").assertExists()
        snapshot("deploy-server")
    }

    @Test
    fun anUnreachableServerSaysSo() {
        show(view(detail("This computer can't reach that server right now.")))

        compose.onNodeWithText("This computer can't reach that server right now.").assertExists()
    }

    @Test
    fun aRunningContainerCanBeRestarted() {
        var acted: Pair<String, String>? = null
        show(view(detail()), DeployIntents(containerAction = { id, action -> acted = id to action }))

        compose.onNode(hasContentDescription("Restart web")).performClick()

        assertEquals("c1" to "restart", acted)
    }

    @Test
    fun aStoppedContainerCanBeStarted() {
        var acted: Pair<String, String>? = null
        show(view(detail()), DeployIntents(containerAction = { id, action -> acted = id to action }))

        compose.onNode(hasContentDescription("Start db")).performClick()

        assertEquals("c2" to "start", acted)
    }

    @Test
    fun aContainerOpensItsLogs() {
        var opened = ""
        show(view(detail()), DeployIntents(openLogs = { opened = it }))

        compose.onNodeWithText("web").performClick()

        assertEquals("c1", opened)
    }

    @Test
    fun anAppCanBeRedeployed() {
        var redeployed = ""
        show(view(detail()), DeployIntents(redeploy = { redeployed = it }))

        compose.onNodeWithText("Redeploy").performClick()

        assertEquals("s1", redeployed)
    }

    @Test
    fun logsAreShownAndClose() {
        var closed = false
        val logs = ContainerLogsView("c1", "web", false, listOf(LogLineView("started", false), LogLineView("oops", true)))
        show(view(DeployScreen(servers, false, server(), logs)), DeployIntents(closeLogs = { closed = true }))

        compose.onNodeWithText("oops").assertExists()
        snapshot("deploy-logs")
        compose.onNode(hasContentDescription("Back")).performClick()

        assertTrue(closed)
    }
}
