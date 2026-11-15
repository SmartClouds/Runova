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
import uniffi.runova_ffi.CloudflareAccessView
import uniffi.runova_ffi.CloudflareDnsServerView
import uniffi.runova_ffi.CloudflareDnsView
import uniffi.runova_ffi.CloudflareOptionView
import uniffi.runova_ffi.CloudflareRevealedSecretView
import uniffi.runova_ffi.CloudflareRulesView
import uniffi.runova_ffi.CloudflareScreen
import uniffi.runova_ffi.CloudflareServersView
import uniffi.runova_ffi.CloudflareTab
import uniffi.runova_ffi.CloudflareTurnstileView
import uniffi.runova_ffi.CloudflareWidgetFormView
import uniffi.runova_ffi.CloudflareWidgetView
import uniffi.runova_ffi.CloudflareZoneView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.WidgetDraft

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)
private const val SITEKEY = "0x4AAAAAAABkMYinukE8nzY"

private val widget = CloudflareWidgetView(
    SITEKEY, "Contact form", listOf("example.com", "shop.example.com"), "Managed", "Off",
    "<script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" async defer></script>\n\n<form action=\"/submit\" method=\"post\">\n  <div class=\"cf-turnstile\" data-sitekey=\"$SITEKEY\"></div>\n  <button type=\"submit\">Send</button>\n</form>",
)

private val servers = listOf(
    CloudflareDnsServerView("srv-1", "prod", true, true, "Holds a token Runova made for example.com, for wildcard certificates.", false, false, null),
    CloudflareDnsServerView("srv-2", "lab", false, false, "No DNS token for example.com, so no wildcard certificates.", false, false, null),
)

private fun zone(tab: CloudflareTab) = CloudflareZoneView(
    "z1", "example.com", "acct-1", "Active", true, false, "Free Website", emptyList(), tab, null,
    CloudflareDnsView(false, null, emptyList()), emptyList(), CloudflareRulesView(false, null, emptyList(), emptyList(), null),
    CloudflareAccessView(false, null, true, false, null, emptyList(), emptyList(), null),
    CloudflareTurnstileView(false, null, listOf(widget)), CloudflareServersView(false, null, servers),
)

private fun view(
    tab: CloudflareTab,
    form: CloudflareWidgetFormView? = null,
    revealed: CloudflareRevealedSecretView? = null,
) = appView(
    connection = connected,
    cloudflare = CloudflareScreen(false, true, null, emptyList(), zone(tab), null, null, null, null, null, null, null, null, form, emptyList(), null, null, revealed, null),
)

private fun options(vararg pairs: Pair<String, String>) = pairs.map { CloudflareOptionView(it.first, it.second) }

private val widgetForm = CloudflareWidgetFormView(
    null, "Add a widget",
    WidgetDraft("", listOf("example.com"), "managed", "no_clearance", "world", false, false),
    options("managed" to "Managed", "non-interactive" to "Non-interactive", "invisible" to "Invisible"),
    options("no_clearance" to "Off", "jschallenge" to "Non-interactive", "managed" to "Managed", "interactive" to "Interactive"),
    options("world" to "Worldwide", "china" to "China"),
    null, false,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class CloudflareTurnstileTest {
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
    fun widgetsShowTheirSiteKeyAndAskBeforeTheSecret() {
        val revealed = mutableListOf<String>()
        val rotated = mutableListOf<Pair<String, Boolean>>()
        show(view(CloudflareTab.TURNSTILE), CloudflareIntents(revealSecret = { revealed += it }, rotateSecret = { k, now -> rotated += k to now }))

        compose.onNodeWithText(SITEKEY).assertExists()
        snapshot("cloudflare-turnstile")
        compose.onNodeWithText("Show secret").performClick()
        compose.onNodeWithText("Rotate secret").performClick()
        assertEquals(listOf(SITEKEY), revealed)
        assertEquals(listOf(SITEKEY to false), rotated)
    }

    @Test
    fun aShownSecretCanBeHiddenAgain() {
        var hidden = false
        show(
            view(CloudflareTab.TURNSTILE, revealed = CloudflareRevealedSecretView(SITEKEY, "Contact form", "0x4AAAAAAABkMYsecretValue123")),
            CloudflareIntents(hideSecret = { hidden = true }),
        )

        compose.onNodeWithText("0x4AAAAAAABkMYsecretValue123").assertExists()
        compose.onNodeWithText("Show secret").assertDoesNotExist()
        compose.onNodeWithText("Hide secret").performClick()
        assertEquals(true, hidden)
    }

    @Test
    fun theWidgetFormSendsWhatWasChosen() {
        val saved = mutableListOf<WidgetDraft>()
        show(view(CloudflareTab.TURNSTILE, form = widgetForm), CloudflareIntents(saveWidget = { saved += it }))

        compose.onNodeWithContentDescription("Widget name").performTextInput("Sign up")
        compose.onNodeWithContentDescription("Add a domain").performTextInput("shop.example.com")
        compose.onNodeWithText("Add").performClick()
        compose.onNodeWithText("Invisible").performClick()
        snapshot("cloudflare-widget")
        compose.onNodeWithText("Add widget").performScrollTo().performClick()

        val draft = saved.single()
        assertEquals("Sign up", draft.name)
        assertEquals(listOf("example.com", "shop.example.com"), draft.domains)
        assertEquals("invisible", draft.mode)
    }

    @Test
    fun eachServerOffersWhatFitsItsToken() {
        val minted = mutableListOf<String>()
        val pasted = mutableListOf<Pair<String, String>>()
        val removed = mutableListOf<String>()
        show(
            view(CloudflareTab.SERVERS),
            CloudflareIntents(
                dnsTokenMint = { minted += it },
                dnsTokenPaste = { server, token -> pasted += server to token },
                dnsTokenRemove = { removed += it },
            ),
        )

        snapshot("cloudflare-servers")
        compose.onNodeWithText("Remove the token").performClick()
        compose.onNodeWithText("Make a token here").performClick()
        compose.onNodeWithText("Paste a token").performClick()
        compose.onNodeWithContentDescription("DNS token for lab").performTextInput("pasted-token-value-123")
        compose.onNodeWithText("Send to lab").performScrollTo().performClick()
        assertEquals(listOf("srv-1"), removed)
        assertEquals(listOf("srv-2"), minted)
        assertEquals(listOf("srv-2" to "pasted-token-value-123"), pasted)
    }
}
