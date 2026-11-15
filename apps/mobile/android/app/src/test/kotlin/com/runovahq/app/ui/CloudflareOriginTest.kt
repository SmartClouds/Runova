package com.runovahq.app.ui

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
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.CloudflareCheckedRowView
import uniffi.runova_ffi.CloudflareChoiceView
import uniffi.runova_ffi.CloudflareFactView
import uniffi.runova_ffi.CloudflareOriginDialogKind
import uniffi.runova_ffi.CloudflareOriginDialogView
import uniffi.runova_ffi.CloudflareOriginLockView
import uniffi.runova_ffi.CloudflareOriginMode
import uniffi.runova_ffi.CloudflareOriginView
import uniffi.runova_ffi.CloudflarePendingChangeView
import uniffi.runova_ffi.CloudflareScreen
import uniffi.runova_ffi.CloudflareSshModeView
import uniffi.runova_ffi.CloudflareStepState
import uniffi.runova_ffi.CloudflareStepView
import uniffi.runova_ffi.CloudflareTone
import uniffi.runova_ffi.CloudflareTunnelView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)

private val tunnel = CloudflareTunnelView(
    "On: no open web ports, everything comes through the tunnel", CloudflareTone.GOOD, true, false, null,
    listOf(
        CloudflareFactView("Tunnel", "runova-prod"),
        CloudflareFactView("Connections to Cloudflare", "4"),
        CloudflareFactView("SSH", "Open as the firewall has it"),
    ),
    emptyList(), null, emptyList(), false, 30u,
    "Off: if the tunnel fails with SSH closed, only your provider's console gets you in.",
    null, false, true, true,
    "The sites are safe behind the tunnel. SSH is the one port left open; you can limit it with Change SSH access.",
)

private val lock = CloudflareOriginLockView(
    "Off: every address reaches ports 80 and 443", CloudflareTone.WARNING, false, "Lock to Cloudflare",
    listOf("15 IPv4 and 7 IPv6 ranges from Cloudflare."), emptyList(), emptyList(),
)

private val pending = CloudflarePendingChangeView(
    "cs1", "Close 80 and 443 to everyone", listOf("ufw deny 80/tcp", "ufw deny 443/tcp"), "Rolls back in 4 min unless you keep it.",
)

private fun origin(mode: CloudflareOriginMode, pending: CloudflarePendingChangeView? = null) = CloudflareOriginView(
    "srv-1", "prod", false, null, true, true, mode, false, null, lock, null, tunnel, null, pending,
)

private fun dialog(kind: CloudflareOriginDialogKind) = CloudflareOriginDialogView(
    kind, "", "", false, emptyList(), null, null, null, emptyList(), emptyList(), null, null, false, false, "Apply", false,
    false, emptyList(), "", false, "", null, false, false, emptyList(), emptyList(), "", null, false, false, null, null,
    false, null, true, true,
)

private fun view(origin: CloudflareOriginView, dialog: CloudflareOriginDialogView? = null) = appView(
    connection = connected,
    cloudflare = CloudflareScreen(
        false, true, null, emptyList(), null, null, null, null, null, null, null, null, null, null,
        listOf(CloudflareChoiceView("srv-1", "prod")), origin, dialog, null, null,
    ),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class CloudflareOriginTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, cloudflare: CloudflareIntents = CloudflareIntents()) {
        compose.setContent {
            RunovaTheme(dark = true) { AppRoot(view, "cloudflare", {}, AppIntents(cloudflare = cloudflare)) }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun aWaitingChangeIsKeptOrRevertedFromThePhone() {
        var kept = false
        var reverted = false
        show(
            view(origin(CloudflareOriginMode.TUNNEL, pending)),
            CloudflareIntents(firewallKeep = { kept = true }, firewallRevert = { reverted = true }),
        )

        compose.onNodeWithText("Rolls back in 4 min unless you keep it.").assertExists()
        snapshot("cloudflare-origin")
        compose.onNodeWithText("Keep it").performClick()
        compose.onNodeWithText("Revert").performClick()
        assertEquals(true, kept)
        assertEquals(true, reverted)
    }

    @Test
    fun theTunnelOffersWhatFitsItsState() {
        var ssh = false
        var off = false
        val breakGlass = mutableListOf<Pair<Boolean, UInt>>()
        show(
            view(origin(CloudflareOriginMode.TUNNEL)),
            CloudflareIntents(tunnelSshOpen = { ssh = true }, tunnelOffOpen = { off = true }, tunnelBreakGlass = { on, m -> breakGlass += on to m }),
        )

        compose.onNodeWithContentDescription("Reopen SSH if the tunnel stays down").performScrollTo().performClick()
        compose.onNodeWithText("Change SSH access").performScrollTo().performClick()
        compose.onNodeWithText("Turn off").performScrollTo().performClick()
        assertEquals(true, ssh)
        assertEquals(true, off)
        assertEquals(listOf(true to 30u), breakGlass)
    }

    @Test
    fun theIpLockIsTheOtherWay() {
        val modes = mutableListOf<CloudflareOriginMode>()
        var locked = false
        show(
            view(origin(CloudflareOriginMode.IPS)),
            CloudflareIntents(originMode = { modes += it }, lockOpen = { locked = it }),
        )

        snapshot("cloudflare-origin-lock")
        compose.onNodeWithText("Lock to Cloudflare").performClick()
        compose.onNodeWithText("Cloudflare Tunnel").performClick()
        assertEquals(true, locked)
        assertEquals(listOf(CloudflareOriginMode.TUNNEL), modes)
    }

    @Test
    fun theSetupShowsItsStepsAndWhatEachNameDoes() {
        val setup = dialog(CloudflareOriginDialogKind.SETUP).copy(
            title = "Put prod behind a Cloudflare Tunnel",
            description = "cloudflared on the server dials out to Cloudflare.",
            rows = listOf(
                CloudflareCheckedRowView("example.com", "Will go through the tunnel", true, null),
                CloudflareCheckedRowView("old.org", "Not in a connected Cloudflare account: stops answering", false, "Core domain"),
            ),
            rowsTitle = "Names on this server",
            rowsWarning = "I understand this name stops answering once the ports close. Add it to this Cloudflare account to keep it.",
            needsAck = true,
            routeSsh = true,
            sshName = "ssh-prod.example.com",
            firewallTitle = "Then, 2 firewall commands",
            commands = listOf("ufw deny 80/tcp", "ufw deny 443/tcp"),
            steps = listOf(
                CloudflareStepView("Make the tunnel at Cloudflare and install cloudflared", CloudflareStepState.DONE, null),
                CloudflareStepView("Wait for its first connection to Cloudflare", CloudflareStepState.RUNNING, null),
                CloudflareStepView("Point the server's names at the tunnel", CloudflareStepState.WAITING, null),
                CloudflareStepView("Close ports 80 and 443 to everyone", CloudflareStepState.WAITING, null),
            ),
            applyLabel = "Set up tunnel",
            saving = true,
        )
        show(view(origin(CloudflareOriginMode.TUNNEL), setup))

        compose.onNodeWithText("Not in a connected Cloudflare account: stops answering").assertExists()
        snapshot("cloudflare-tunnel-setup")
    }

    @Test
    fun closingSshAsksForThePhraseAndPassword() {
        val sent = mutableListOf<Pair<String, String>>()
        val ssh = dialog(CloudflareOriginDialogKind.SSH).copy(
            title = "Who may open SSH",
            description = "This decides what happens to SSH.",
            sshMode = "closed",
            sshModes = listOf(
                CloudflareSshModeView("open", "Open as the firewall has it", "SSH works the way it does today.", "The one port bots can still find.", true, true),
                CloudflareSshModeView("closed", "Closed to everyone", "No SSH at all.", "Only your provider's console gets you in.", true, false),
            ),
            phrase = "close ssh on prod",
            firewallTitle = "1 firewall command",
            commands = listOf("ufw deny 22/tcp"),
            canApply = true,
            danger = true,
        )
        show(view(origin(CloudflareOriginMode.TUNNEL), ssh), CloudflareIntents(tunnelSshApply = { p, w -> sent += p to w }))

        compose.onNodeWithContentDescription("Confirmation phrase").performScrollTo().performTextInput("close ssh on prod")
        compose.onNodeWithContentDescription("Password on the server core").performScrollTo().performTextInput("hunter2")
        snapshot("cloudflare-tunnel-ssh")
        compose.onNodeWithText("Apply").performScrollTo().performClick()
        assertEquals(listOf("close ssh on prod" to "hunter2"), sent)
    }
}
