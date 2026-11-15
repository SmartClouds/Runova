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
import uniffi.runova_ffi.CloudflareServersView
import uniffi.runova_ffi.CloudflareTurnstileView
import uniffi.runova_ffi.CloudflareAccessView
import uniffi.runova_ffi.CloudflareDnsView
import uniffi.runova_ffi.CloudflareEmailGateFormView
import uniffi.runova_ffi.CloudflareGateHostView
import uniffi.runova_ffi.CloudflareGateState
import uniffi.runova_ffi.CloudflareIpLimitFormView
import uniffi.runova_ffi.CloudflareIpLimitView
import uniffi.runova_ffi.CloudflareOptionView
import uniffi.runova_ffi.CloudflarePersonView
import uniffi.runova_ffi.CloudflareRulesView
import uniffi.runova_ffi.CloudflareScreen
import uniffi.runova_ffi.CloudflareTab
import uniffi.runova_ffi.CloudflareZoneView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)

private val hosts = listOf(
    CloudflareGateHostView("core.example.com", "Core server", true, false, CloudflareGateState.ON, "Email code, 3 people, 24 hours", true, false),
    CloudflareGateHostView("app.example.com", null, true, false, CloudflareGateState.OFF, "Open to everyone", false, false),
    CloudflareGateHostView("shop.example.com", null, false, true, CloudflareGateState.OFF, "Cloudflare's proxy is off for it, so a gate cannot go on it yet", false, false),
    CloudflareGateHostView("ssh.example.com", "SSH", true, false, CloudflareGateState.ELSEWHERE, "SSH for prod, set up in Cloudflare", false, false),
)

private val limits = listOf(
    CloudflareIpLimitView("l1", "app.example.com/admin and below", listOf("203.0.113.10", "198.51.100.0/24"), true),
)

private fun access(ready: Boolean = true, needsTeam: Boolean = false) =
    CloudflareAccessView(false, null, ready, needsTeam, null, hosts, limits, null)

private fun zone(access: CloudflareAccessView) = CloudflareZoneView(
    "z1", "example.com", "acct-1", "Active", true, false, "Free Website", emptyList(), CloudflareTab.ACCESS, null,
    CloudflareDnsView(false, null, emptyList()), emptyList(), CloudflareRulesView(false, null, emptyList(), emptyList(), null), access, CloudflareTurnstileView(false, null, emptyList()), CloudflareServersView(false, null, emptyList()),
)

private fun view(
    access: CloudflareAccessView = access(),
    gate: CloudflareEmailGateFormView? = null,
    limit: CloudflareIpLimitFormView? = null,
) = appView(
    connection = connected,
    cloudflare = CloudflareScreen(false, true, null, emptyList(), zone(access), null, null, null, null, null, null, gate, limit, null, emptyList(), null, null, null, null),
)

private val sessions = listOf("30m" to "30 min", "6h" to "6 hours", "24h" to "24 hours", "168h" to "7 days", "720h" to "30 days")
    .map { CloudflareOptionView(it.first, it.second) }

private val gateForm = CloudflareEmailGateFormView(
    "app.example.com", false,
    listOf(CloudflarePersonView("company.com", true), CloudflarePersonView("ana@example.com", false)),
    listOf("nope: Type an email address, or a domain like @company.com to let in everyone there."),
    "168h", sessions,
    "Anyone at @company.com and ana@example.com can open app.example.com for 7 days after typing a code.",
    null, false, false, null,
)

private val limitForm = CloudflareIpLimitFormView(
    null,
    listOf(CloudflareOptionView("*", "Every name in example.com"), CloudflareOptionView("app.example.com", "app.example.com")),
    "app.example.com", false, "/admin", true, null, listOf("198.51.100.7"), emptyList(), "203.0.113.77", true, true,
    "Only 198.51.100.7 can open app.example.com/admin and below. Everyone else gets Cloudflare's block page.",
    true, false, null,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class CloudflareAccessTest {
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
    fun eachNameHasItsSwitchAndWhatItNeeds() {
        val switched = mutableListOf<Pair<String, Boolean>>()
        val proxied = mutableListOf<String>()
        val through = mutableListOf<String>()
        show(
            view(),
            CloudflareIntents(
                gateSwitch = { host, on -> switched += host to on },
                gateProxy = { proxied += it },
                gateLetThrough = { through += it },
            ),
        )

        compose.onNodeWithText("SSH for prod, set up in Cloudflare").assertExists()
        snapshot("cloudflare-access")
        compose.onNodeWithContentDescription("Email code for app.example.com").performClick()
        compose.onNodeWithContentDescription("Email code for core.example.com").performClick()
        compose.onNodeWithText("Turn on proxy").performClick()
        compose.onNodeWithText("Let this computer through").performClick()
        assertEquals(listOf("app.example.com" to true, "core.example.com" to false), switched)
        assertEquals(listOf("shop.example.com"), proxied)
        assertEquals(listOf("core.example.com"), through)
    }

    @Test
    fun emailCodesAreTurnedOnWithATeamName() {
        val prepared = mutableListOf<String>()
        show(view(access(ready = false, needsTeam = true)), CloudflareIntents(gatePrepare = { prepared += it }))

        compose.onNodeWithContentDescription("Team name").performTextInput("acme")
        compose.onNodeWithText("acme.cloudflareaccess.com").assertExists()
        snapshot("cloudflare-access-setup")
        compose.onNodeWithText("Turn on email codes").performClick()
        assertEquals(listOf("acme"), prepared)
    }

    @Test
    fun theGateFormTakesPeopleAndASession() {
        val added = mutableListOf<String>()
        val sessionsChosen = mutableListOf<String>()
        var saved = false
        show(
            view(gate = gateForm),
            CloudflareIntents(
                gateAddPeople = { added += it },
                gateSetSession = { sessionsChosen += it },
                gateSave = { saved = true },
            ),
        )

        compose.onNodeWithText("@company.com").assertExists()
        snapshot("cloudflare-gate")
        compose.onNodeWithContentDescription("Who can get a code").performTextInput("bo@example.com,")
        compose.onNodeWithText("30 days").performScrollTo().performClick()
        compose.onNodeWithText("Turn on email code").performScrollTo().performClick()
        assertEquals(listOf("bo@example.com,"), added)
        assertEquals(listOf("720h"), sessionsChosen)
        assertEquals(true, saved)
    }

    @Test
    fun anIpLimitWarnsAndAddsThisComputer() {
        var addedHere = false
        var saved = false
        show(view(limit = limitForm), CloudflareIntents(ipLimitAddThisComputer = { addedHere = true }, ipLimitSave = { saved = true }))

        compose.onNodeWithText("is not on the list", substring = true).performScrollTo().assertExists()
        snapshot("cloudflare-ip-limit")
        compose.onNodeWithContentDescription("Add this computer, 203.0.113.77").performScrollTo().performClick()
        compose.onNodeWithText("Add limit").performScrollTo().performClick()
        assertEquals(true, addedHere)
        assertEquals(true, saved)
    }

    @Test
    fun aLimitSwitchesOffOrOpensToChange() {
        val switched = mutableListOf<Pair<String, Boolean>>()
        val opened = mutableListOf<String?>()
        show(view(), CloudflareIntents(ipLimitSetEnabled = { id, on -> switched += id to on }, openIpLimit = { opened += it }))

        compose.onNodeWithContentDescription("IP limit for app.example.com/admin and below").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Edit IP limit for app.example.com/admin and below").performScrollTo().performClick()
        compose.onNodeWithText("Add IP limit").performScrollTo().performClick()
        assertEquals(listOf("l1" to false), switched)
        assertEquals(listOf("l1", null), opened)
    }
}
