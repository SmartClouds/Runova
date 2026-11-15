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
import uniffi.runova_ffi.CloudflareAccountView
import uniffi.runova_ffi.CloudflareChoiceView
import uniffi.runova_ffi.CloudflareDnsView
import uniffi.runova_ffi.CloudflarePlannedChangeView
import uniffi.runova_ffi.CloudflarePointDomainView
import uniffi.runova_ffi.CloudflarePointPlanView
import uniffi.runova_ffi.CloudflareRecordFormView
import uniffi.runova_ffi.CloudflareRecordView
import uniffi.runova_ffi.CloudflareRulesView
import uniffi.runova_ffi.CloudflareScreen
import uniffi.runova_ffi.CloudflareTab
import uniffi.runova_ffi.CloudflareTogglesView
import uniffi.runova_ffi.CloudflareTokenFormView
import uniffi.runova_ffi.CloudflareTone
import uniffi.runova_ffi.CloudflareZoneRow
import uniffi.runova_ffi.CloudflareZoneView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.RecordDraft

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)

private val work = CloudflareAccountView(
    "acct-1", "Work", "Needs 1 permission", CloudflareTone.WARNING,
    "Add them to the token on Cloudflare, then check it again.",
    listOf("Zone > Zone WAF > Edit"), emptyList(), false,
    listOf(
        CloudflareZoneRow("z1", "example.com", "Active", true, "Free Website"),
        CloudflareZoneRow("z2", "shop.example.org", "Waiting for name servers", false, "Free Website"),
    ),
    false, null,
)
private val home = CloudflareAccountView(
    "acct-2", "Home", "Locked", CloudflareTone.WARNING,
    "Unlock Servers on this computer to use this account.",
    emptyList(), emptyList(), true, emptyList(), false, null,
)

private fun record(id: String, type: String, name: String, content: String, proxied: Boolean, ttl: String = "Auto") =
    CloudflareRecordView(id, type, name, if (name == "@") "example.com" else "$name.example.com", content, proxied, type != "MX", ttl, true, if (type == "MX") 10u else null, "")

private val records = listOf(
    record("r1", "A", "@", "203.0.113.10", true),
    record("r2", "CNAME", "www", "example.com", true),
    record("r3", "MX", "@", "mx.example.net", false, "1 hr"),
)

private val toggles = CloudflareTogglesView(true, "On, 2 h 59 min left", true, false, true, true, "On, everywhere", true, false)

private fun zone(pending: Boolean = false) = CloudflareZoneView(
    "z1", "example.com", "acct-1", if (pending) "Waiting for name servers" else "Active", !pending, pending,
    "Free Website", listOf("bob.ns.cloudflare.com", "lola.ns.cloudflare.com"), CloudflareTab.DNS,
    toggles, CloudflareDnsView(false, null, records), emptyList(), CloudflareRulesView(false, null, emptyList(), emptyList(), null),
    CloudflareAccessView(false, null, true, false, null, emptyList(), emptyList(), null),
    CloudflareTurnstileView(false, null, emptyList()), CloudflareServersView(false, null, emptyList()),
)

private fun screen(
    zone: CloudflareZoneView? = null,
    accounts: List<CloudflareAccountView> = listOf(work, home),
    token: CloudflareTokenFormView? = null,
    form: CloudflareRecordFormView? = null,
    point: CloudflarePointDomainView? = null,
) = CloudflareScreen(false, accounts.isNotEmpty(), null, accounts, zone, token, null, form, point, null, null, null, null, null, emptyList(), null, null, null, null)

private fun draft(type: String = "A", name: String = "", content: String = "") = RecordDraft(
    type, name, content, 1u, true, 10u, "", 0u.toUByte(), "issue", "", 0u, 0u, 0u, "",
)

private fun view(cloudflare: CloudflareScreen) = appView(connection = connected, cloudflare = cloudflare)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class CloudflareTest {
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
    fun accountsListTheirDomainsAndWhatTheyNeed() {
        val opened = mutableListOf<String>()
        show(view(screen()), CloudflareIntents(openZone = { opened += it }))

        compose.onNodeWithText("Needs 1 permission").assertExists()
        compose.onNodeWithText("Zone > Zone WAF > Edit").assertExists()
        compose.onNodeWithText("Locked").assertExists()
        snapshot("cloudflare")
        compose.onNodeWithText("example.com").performClick()
        assertEquals(listOf("z1"), opened)
    }

    @Test
    fun withNoAccountItOffersToConnectOne() {
        var opened: String? = "never"
        show(view(screen(accounts = emptyList())), CloudflareIntents(openTokenForm = { opened = it }))

        compose.onNodeWithText("Connect Cloudflare").assertExists()
        compose.onNodeWithText("Connect an account").performClick()
        assertEquals(null, opened)
        snapshot("cloudflare-empty")
    }

    @Test
    fun aDomainShowsItsSwitchesAndRecords() {
        val dev = mutableListOf<Boolean>()
        val proxy = mutableListOf<Pair<String, Boolean>>()
        show(
            view(screen(zone = zone())),
            CloudflareIntents(setDevMode = { dev += it }, setProxied = { id, on -> proxy += id to on }),
        )

        compose.onNodeWithText("On, 2 h 59 min left").assertExists()
        compose.onNodeWithText("203.0.113.10").assertExists()
        snapshot("cloudflare-zone")
        compose.onNodeWithContentDescription("Development mode").performClick()
        compose.onNodeWithContentDescription("Proxy for @ A").performClick()
        assertEquals(listOf(false), dev)
        assertEquals(listOf("r1" to false), proxy)
    }

    @Test
    fun aPendingDomainListsTheNameServersToSet() {
        var checked = false
        show(view(screen(zone = zone(pending = true))), CloudflareIntents(checkActivation = { checked = true }))

        compose.onNodeWithText("lola.ns.cloudflare.com").assertExists()
        compose.onNodeWithText("Check again").performClick()
        assertEquals(true, checked)
        snapshot("cloudflare-pending")
    }

    @Test
    fun theRecordFormSendsWhatWasTyped() {
        val saved = mutableListOf<RecordDraft>()
        val form = CloudflareRecordFormView(null, "Add a record", "example.com", draft(), null, false)
        show(view(screen(zone = zone(), form = form)), CloudflareIntents(saveRecord = { saved += it }))

        compose.onNodeWithContentDescription("Name").performTextInput("app")
        compose.onNodeWithContentDescription("IPv4 address").performTextInput("203.0.113.20")
        snapshot("cloudflare-record")
        compose.onNodeWithText("Save record").performScrollTo().performClick()

        assertEquals("app", saved.single().name)
        assertEquals("203.0.113.20", saved.single().content)
        assertEquals("A", saved.single().recordType)
    }

    @Test
    fun aTokenIsPastedIntoAHiddenField() {
        val sent = mutableListOf<Pair<String, String>>()
        val form = CloudflareTokenFormView(null, null, null, false)
        show(view(screen(token = form)), CloudflareIntents(saveToken = { token, label -> sent += token to label }))

        compose.onNodeWithContentDescription("Account name").performTextInput("Phone")
        compose.onNodeWithContentDescription("API token").performTextInput("secret-token-value-1234")
        snapshot("cloudflare-token")
        compose.onNodeWithText("Connect").performScrollTo().performClick()

        assertEquals(listOf("secret-token-value-1234" to "Phone"), sent)
    }

    @Test
    fun pointingADomainShowsThePlanBeforeApplying() {
        var applied = false
        val plan = CloudflarePointPlanView(
            "2 changes to point example.com and www.example.com at prod.",
            listOf(
                CloudflarePlannedChangeView("Change", CloudflareTone.WARNING, "A", "@", "198.51.100.5", "203.0.113.10", null),
                CloudflarePlannedChangeView("Add", CloudflareTone.GOOD, "A", "www", "198.51.100.5", null, null),
            ),
            false,
        )
        val point = CloudflarePointDomainView(
            "example.com", listOf(CloudflareChoiceView("srv-1", "prod")), false, plan, null, false,
        )
        show(view(screen(zone = zone(), point = point)), CloudflareIntents(applyPointDomain = { applied = true }))

        compose.onNodeWithText("2 changes to point example.com and www.example.com at prod.").assertExists()
        snapshot("cloudflare-point")
        compose.onNodeWithText("Apply").performScrollTo().performClick()
        assertEquals(true, applied)
    }
}
