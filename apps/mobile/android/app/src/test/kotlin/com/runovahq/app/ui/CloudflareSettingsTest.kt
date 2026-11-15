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
import uniffi.runova_ffi.CloudflareAccessRuleView
import uniffi.runova_ffi.CloudflareDnsView
import uniffi.runova_ffi.CloudflareFormView
import uniffi.runova_ffi.CloudflareOptionView
import uniffi.runova_ffi.CloudflareRuleView
import uniffi.runova_ffi.CloudflareRulesView
import uniffi.runova_ffi.CloudflareScreen
import uniffi.runova_ffi.CloudflareSettingKind
import uniffi.runova_ffi.CloudflareSettingView
import uniffi.runova_ffi.CloudflareSettingsGroup
import uniffi.runova_ffi.CloudflareTab
import uniffi.runova_ffi.CloudflareTone
import uniffi.runova_ffi.CloudflareZoneView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)

private fun option(value: String, label: String) = CloudflareOptionView(value, label)

private fun switch(key: String, title: String, detail: String, on: Boolean) =
    CloudflareSettingView(key, title, detail, CloudflareSettingKind.SWITCH, if (on) "on" else "off", on, emptyList(), true, null, CloudflareTone.GOOD)

private val ssl = CloudflareSettingsGroup(
    "SSL/TLS",
    "How visitors and Cloudflare reach example.com over HTTPS.",
    listOf(
        CloudflareSettingView(
            "ssl", "SSL/TLS mode", "How Cloudflare connects to your server.", CloudflareSettingKind.CHOICE, "full", false,
            listOf(option("off", "Off (no HTTPS)"), option("flexible", "Flexible"), option("full", "Full"), option("strict", "Full (strict)")),
            true,
            "The connection to your server is encrypted, but its certificate is not checked, so anyone in between could pose as it.",
            CloudflareTone.WARNING,
        ),
        switch("alwaysUseHttps", "Always Use HTTPS", "Sends visitors who ask for http:// to the https:// address.", false),
        switch("tls13", "TLS 1.3", "The newest TLS version: faster to connect and drops older ciphers.", true),
    ),
)

private val caching = CloudflareSettingsGroup(
    "Caching",
    "How example.com is cached at Cloudflare and in browsers.",
    listOf(
        switch("developmentMode", "Development mode", "Skips the cache for three hours, so changes to the site show at once.", false),
        CloudflareSettingView(
            "browserCacheTtl", "Browser cache TTL", "How long a visitor's browser keeps files before it asks again.",
            CloudflareSettingKind.CHOICE, "14400", false,
            listOf(0 to "Respect existing headers", 30 to "30 seconds", 60 to "1 minute", 3600 to "1 hour", 7200 to "2 hours", 14400 to "4 hours", 86400 to "1 day", 31536000 to "1 year")
                .map { option(it.first.toString(), it.second) },
            true, null, CloudflareTone.GOOD,
        ),
    ),
)

private val protection = CloudflareSettingsGroup(
    "Protection",
    "Who gets a check before reaching example.com.",
    listOf(
        CloudflareSettingView(
            "securityLevel", "Security level", "How suspicious a visitor has to look before Cloudflare checks them.",
            CloudflareSettingKind.CHOICE, "medium", false,
            listOf(option("low", "Low"), option("medium", "Medium"), option("high", "High"), option("under_attack", "I'm Under Attack")),
            true, null, CloudflareTone.GOOD,
        ),
    ),
)

private val rules = CloudflareRulesView(
    false, null,
    listOf(CloudflareRuleView("r1", "Block Tor exit nodes", "Block", CloudflareTone.BAD, "(ip.src.country in {\"T1\"})", true)),
    listOf(CloudflareAccessRuleView("a1", "198.51.100.4", "IP address", "Block", CloudflareTone.BAD, "Scraper")),
    null,
)

private fun zone(tab: CloudflareTab, groups: List<CloudflareSettingsGroup>) = CloudflareZoneView(
    "z1", "example.com", "acct-1", "Active", true, false, "Free Website", emptyList(), tab, null,
    CloudflareDnsView(false, null, emptyList()), groups, rules,
    CloudflareAccessView(false, null, true, false, null, emptyList(), emptyList(), null),
    CloudflareTurnstileView(false, null, emptyList()), CloudflareServersView(false, null, emptyList()),
)

private fun view(zone: CloudflareZoneView, builder: CloudflareFormView? = null, access: CloudflareFormView? = null) = appView(
    connection = connected,
    cloudflare = CloudflareScreen(false, true, null, emptyList(), zone, null, null, null, null, builder, access, null, null, null, emptyList(), null, null, null, null),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class CloudflareSettingsTest {
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
    fun theTabsSwitchWhatTheDomainShows() {
        val tabs = mutableListOf<CloudflareTab>()
        show(view(zone(CloudflareTab.SSL, listOf(ssl))), CloudflareIntents(openTab = { tabs += it }))

        compose.onNodeWithText("Caching").performClick()
        compose.onNodeWithText("Security").performClick()
        assertEquals(listOf(CloudflareTab.CACHING, CloudflareTab.SECURITY), tabs)
    }

    @Test
    fun sslShowsTheModeWithWhatItMeans() {
        val changes = mutableListOf<Pair<String, String>>()
        show(view(zone(CloudflareTab.SSL, listOf(ssl))), CloudflareIntents(changeSetting = { k, v -> changes += k to v }))

        compose.onNodeWithText("certificate is not checked", substring = true).assertExists()
        snapshot("cloudflare-ssl")
        compose.onNodeWithText("Full (strict)").performClick()
        compose.onNodeWithContentDescription("Always Use HTTPS").performClick()
        assertEquals(listOf("ssl" to "strict", "alwaysUseHttps" to "on"), changes)
    }

    @Test
    fun aLongChoiceFoldsBehindItsValue() {
        val changes = mutableListOf<Pair<String, String>>()
        show(view(zone(CloudflareTab.CACHING, listOf(caching))), CloudflareIntents(changeSetting = { k, v -> changes += k to v }))

        compose.onNodeWithText("1 year").assertDoesNotExist()
        snapshot("cloudflare-caching")
        compose.onNodeWithContentDescription("Browser cache TTL: 4 hours").performClick()
        compose.onNodeWithText("2 hours").performScrollTo().performClick()
        assertEquals(listOf("browserCacheTtl" to "7200"), changes)
    }

    @Test
    fun theCacheIsPurgedWholeOrByFile() {
        var everything = false
        val files = mutableListOf<String>()
        show(
            view(zone(CloudflareTab.CACHING, listOf(caching))),
            CloudflareIntents(purgeEverything = { everything = true }, purgeUrls = { files += it }),
        )

        compose.onNodeWithText("Purge everything").performScrollTo().performClick()
        assertEquals(true, everything)
        assertEquals(emptyList<String>(), files)
    }

    @Test
    fun securityListsRulesWithTheirSwitches() {
        val switched = mutableListOf<Pair<String, Boolean>>()
        val deleted = mutableListOf<String>()
        show(
            view(zone(CloudflareTab.SECURITY, listOf(protection))),
            CloudflareIntents(
                setRuleEnabled = { id, on -> switched += id to on },
                deleteAccessRule = { deleted += it },
            ),
        )

        snapshot("cloudflare-security")
        compose.onNodeWithContentDescription("Block Tor exit nodes").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Delete the access rule for 198.51.100.4").performScrollTo().performClick()
        assertEquals(listOf("r1" to false), switched)
        assertEquals(listOf("a1"), deleted)
    }

    @Test
    fun theBuilderSendsTheChosenKindOfRule() {
        val added = mutableListOf<List<Any>>()
        show(
            view(zone(CloudflareTab.SECURITY, listOf(protection)), builder = CloudflareFormView(null, false)),
            CloudflareIntents(addRule = { kind, values, path, prefix, description -> added += listOf(kind, values, path, prefix, description) }),
        )

        compose.onNodeWithText("Challenge a path").performClick()
        compose.onNodeWithContentDescription("Path").performTextInput("/admin")
        compose.onNodeWithText("This path and everything under it").performClick()
        snapshot("cloudflare-rule")
        compose.onNodeWithText("Add rule").performScrollTo().performClick()
        assertEquals(listOf(listOf("challenge-path", "", "/admin", true, "")), added)
    }

    @Test
    fun anAccessRuleTakesAValueAndAnAction() {
        val added = mutableListOf<Triple<String, String, String>>()
        show(
            view(zone(CloudflareTab.SECURITY, listOf(protection)), access = CloudflareFormView(null, false)),
            CloudflareIntents(addAccessRule = { value, mode, notes -> added += Triple(value, mode, notes) }),
        )

        compose.onNodeWithContentDescription("Address, range, country or network").performTextInput("203.0.113.0/24")
        compose.onNodeWithText("Managed challenge").performClick()
        snapshot("cloudflare-access-rule")
        compose.onNodeWithText("Add access rule").performScrollTo().performClick()
        assertEquals(listOf(Triple("203.0.113.0/24", "managed_challenge", "")), added)
    }
}
