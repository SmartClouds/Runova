package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
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
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.DeployScreen
import uniffi.runova_ffi.DeployServerView
import uniffi.runova_ffi.NotificationDestination
import uniffi.runova_ffi.ServerDetailView
import uniffi.runova_ffi.TrafficAttackView
import uniffi.runova_ffi.TrafficAttacksView
import uniffi.runova_ffi.TrafficBlockedItemView
import uniffi.runova_ffi.TrafficBlockedView
import uniffi.runova_ffi.TrafficBreakdownView
import uniffi.runova_ffi.TrafficChangeView
import uniffi.runova_ffi.TrafficChartView
import uniffi.runova_ffi.TrafficDimensionView
import uniffi.runova_ffi.TrafficGranularityView
import uniffi.runova_ffi.TrafficKpiView
import uniffi.runova_ffi.TrafficPointView
import uniffi.runova_ffi.TrafficRange
import uniffi.runova_ffi.TrafficRangeView
import uniffi.runova_ffi.TrafficRowView
import uniffi.runova_ffi.TrafficScreen
import uniffi.runova_ffi.TrafficSettingsView
import uniffi.runova_ffi.TrafficSiteView
import uniffi.runova_ffi.TrafficTab
import uniffi.runova_ffi.TrafficTone
import uniffi.runova_ffi.TrafficTrend

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)
private val servers = listOf(DeployServerView("srv1", "Prod", "10.0.0.1", "Online", true, null))
private val server = ServerDetailView("srv1", "Prod", false, null, emptyList(), emptyList(), emptyList(), null)

private val ranges = listOf(
    TrafficRange.TODAY to "Today",
    TrafficRange.WEEK to "7 days",
    TrafficRange.MONTH to "30 days",
    TrafficRange.QUARTER to "90 days",
    TrafficRange.YEAR to "12 months",
).map { (range, label) -> TrafficRangeView(range, label, range == TrafficRange.WEEK) }

private fun change(text: String, trend: TrafficTrend, tone: TrafficTone) = TrafficChangeView(text, trend, tone)

private val kpis = listOf(
    TrafficKpiView("Unique visitors", "12.9K", "about", change("+16%", TrafficTrend.UP, TrafficTone.GOOD)),
    TrafficKpiView("Visits", "15K", null, change("No change", TrafficTrend.FLAT, TrafficTone.NEUTRAL)),
    TrafficKpiView("Page views", "41K", null, change("+8%", TrafficTrend.UP, TrafficTone.GOOD)),
    TrafficKpiView("Bounce rate", "42%", null, change("+9%", TrafficTrend.UP, TrafficTone.BAD)),
    TrafficKpiView("Pages per visit", "2.7", null, null),
    TrafficKpiView("Visit length", "1m 35s", null, null),
    TrafficKpiView("Bandwidth", "1.5 GB", null, change("-3%", TrafficTrend.DOWN, TrafficTone.NEUTRAL)),
    TrafficKpiView("Bot share", "10%", null, change("-1.5%", TrafficTrend.DOWN, TrafficTone.GOOD)),
)

private val chart = TrafficChartView(
    (0 until 7).map { i ->
        TrafficPointView(
            "${12 + i} Nov",
            1000.0 + i * 100 + (i % 2) * 300,
            4000.0 + i * 500,
            900.0 + (i % 3) * 120,
            3500.0 + (i % 2) * 400,
            "Day ${12 + i}: visitors and page views",
            "Period before: 900 visitors, 3,500 page views",
        )
    },
    10_000.0,
    listOf("10K", "5,000", "0"),
)

private fun row(label: String, value: String, share: Float, flag: String? = null) =
    TrafficRowView(label, value, share, "${Math.round(share * 100)}%", flag)

private val pages = TrafficBreakdownView(
    "page",
    "Pages",
    "page views",
    listOf(row("/", "20.5K", 0.5f), row("/blog", "10.3K", 0.25f), row("/about", "4,100", 0.1f)),
)
private val devices = TrafficBreakdownView(
    "device",
    "Devices",
    "page views",
    listOf(row("Desktop", "30.8K", 0.75f), row("Mobile", "8,200", 0.2f), row("Tablet", "2,050", 0.05f)),
)
private val countries = TrafficBreakdownView(
    "country",
    "Countries",
    "page views",
    listOf(
        row("United States", "20.5K", 0.5f, "🇺🇸"),
        row("Germany", "6,150", 0.15f, "🇩🇪"),
        row("Unknown", "100", 0.01f),
    ),
)

private val attacks = TrafficAttacksView(
    false,
    null,
    "2 addresses in the last 7 days, 1 blocked",
    listOf(
        TrafficAttackView(
            41, "blog", "blog.example.com", "Scans", "198.51.100.23", "Netherlands", "🇳🇱",
            "412 requests", "2m ago", listOf("/.env", "/.git/config"), false, true,
        ),
        TrafficAttackView(
            38, "shop", "shop.example.com", "Floods", "2001:db8::1", null, null,
            "9,120 requests", "19h ago", listOf("/"), true, false,
        ),
    ),
)

private val blocked = TrafficBlockedView(
    false,
    null,
    listOf(
        TrafficBlockedItemView(7, "203.0.113.45", "Password guessing", "Automatic, 2h ago, on shop.example.com. Lifted in 3h.", true),
        TrafficBlockedItemView(8, "10.9.0.0/16", "Blocked from the phone", "By sam, 3d ago, every site. For good.", true),
    ),
)

private fun traffic(
    tab: TrafficTab = TrafficTab.OVERVIEW,
    canAdmin: Boolean = true,
    off: String? = null,
    settings: TrafficSettingsView? = null,
    dimension: TrafficDimensionView? = null,
) = TrafficScreen(
    "srv1", "Prod", false, false, null, tab, null, "All websites",
    listOf(
        TrafficSiteView(null, "All websites", true),
        TrafficSiteView("blog", "blog.example.com", false),
        TrafficSiteView("shop", "shop.example.com", false),
    ),
    TrafficRange.WEEK, ranges,
    listOf(
        TrafficGranularityView("hour", "Hour", true, false, null),
        TrafficGranularityView("day", "Day", true, true, null),
        TrafficGranularityView("week", "Week", false, false, "Pick four weeks or more to see weeks."),
    ),
    canAdmin, off, null, kpis, chart, listOf(pages), devices, countries,
    "82% from Cloudflare, 18% from DB-IP", attacks, blocked, settings, dimension,
)

private val settings = TrafficSettingsView(
    false, false, null, true, true, 90u, listOf(7u, 30u, 90u, 180u, 365u), 730u, listOf(30u, 365u, 730u, 1825u), true,
    "Auto-block is on for scans and password guessing, for 1h. Change it on the computer.",
    "12 MB of statistics on the server", true,
)

private fun view(screen: TrafficScreen?) = appView(
    connection = connected,
    deploy = DeployScreen(servers, false, server, null, screen),
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class TrafficTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, traffic: TrafficIntents = TrafficIntents(), dark: Boolean = true) {
        compose.setContent {
            RunovaTheme(dark = dark) { AppRoot(view, "deploy", {}, AppIntents(deploy = DeployIntents(traffic = traffic))) }
        }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun aServerOpensItsTraffic() {
        var opened = false
        show(view(null), TrafficIntents(open = { opened = true }))

        compose.onNodeWithText("Traffic and attacks").performClick()

        assertEquals(true, opened)
    }

    @Test
    fun theReportShowsTilesChartAndBreakdowns() {
        show(view(traffic()))

        compose.onNodeWithText("12.9K").assertExists()
        compose.onNodeWithText("about").assertExists()
        compose.onNodeWithText("↑ +16%").assertExists()
        compose.onNodeWithText("Visitors and page views").assertExists()
        snapshot("traffic")
    }

    @Test
    fun itReadsTheSameInTheLightTheme() {
        show(view(traffic()), dark = false)

        snapshot("traffic-light")
    }

    @Test
    fun rangesSitesAndBucketsAreChosenByTheCore() {
        val ranges = mutableListOf<TrafficRange>()
        val sites = mutableListOf<String?>()
        val buckets = mutableListOf<String>()
        show(
            view(traffic()),
            TrafficIntents(setRange = { ranges += it }, setSite = { sites += it }, setGranularity = { buckets += it }),
        )

        compose.onNodeWithText("30 days").performClick()
        compose.onNodeWithText("blog.example.com").performClick()
        compose.onNodeWithText("Hour").performClick()

        assertEquals(listOf(TrafficRange.MONTH), ranges)
        assertEquals(listOf<String?>("blog"), sites)
        assertEquals(listOf("hour"), buckets)
    }

    @Test
    fun countriesHaveFlagsAndSeeAllOpensTheList() {
        val opened = mutableListOf<String>()
        show(view(traffic()), TrafficIntents(openDimension = { opened += it }))

        val list = compose.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasContentDescription("United States, 20.5K, 50%"))
        list.performScrollToNode(hasText("82% from Cloudflare, 18% from DB-IP"))
        snapshot("traffic-countries")
        compose.onNodeWithContentDescription("See all countries").performClick()

        assertEquals(listOf("country"), opened)
    }

    @Test
    fun attacksCanBeBlockedByAnAdmin() {
        val blocked = mutableListOf<Long>()
        show(view(traffic(TrafficTab.ATTACKS)), TrafficIntents(block = { blocked += it }))

        compose.onNodeWithText("2 addresses in the last 7 days, 1 blocked").assertExists()
        snapshot("traffic-attacks")
        compose.onNodeWithContentDescription("Block 198.51.100.23").performClick()

        assertEquals(listOf(41L), blocked)
    }

    @Test
    fun aViewerSeesAttacksWithoutBlockOrSettings() {
        show(view(traffic(TrafficTab.ATTACKS, canAdmin = false).let { t ->
            t.copy(attacks = t.attacks.copy(items = t.attacks.items.map { it.copy(canBlock = false) }))
        }))

        compose.onNodeWithText("198.51.100.23").assertExists()
        compose.onNodeWithContentDescription("Block 198.51.100.23").assertDoesNotExist()
        compose.onNodeWithText("Settings").assertDoesNotExist()
    }

    @Test
    fun theBlockedListLetsAnAddressBackIn() {
        val unblocked = mutableListOf<Long>()
        show(view(traffic(TrafficTab.BLOCKED)), TrafficIntents(unblock = { unblocked += it }))

        compose.onNodeWithText("By sam, 3d ago, every site. For good.").assertExists()
        snapshot("traffic-blocked")
        compose.onNodeWithContentDescription("Unblock 10.9.0.0/16").performClick()

        assertEquals(listOf(8L), unblocked)
    }

    @Test
    fun statisticsThatAreOffPointToTheSettings() {
        var opened = 0
        show(view(traffic(off = "Turn them on in the settings.")), TrafficIntents(openSettings = { opened++ }))

        compose.onNodeWithText("Traffic statistics are off").assertExists()
        compose.onAllNodesWithText("Settings")[1].performClick()

        assertEquals(1, opened)
    }

    @Test
    fun theSettingsSheetChangesWhatThePhoneMay() {
        val hourly = mutableListOf<UInt>()
        val detection = mutableListOf<Boolean>()
        var saved = false
        show(
            view(traffic(settings = settings)),
            TrafficIntents(setHourly = { hourly += it }, setDetection = { detection += it }, saveSettings = { saved = true }),
        )

        snapshot("traffic-settings")
        compose.onAllNodesWithText("30 days")[0].performClick()
        compose.onNodeWithContentDescription("Attack detection").performScrollTo().performClick()
        compose.onNodeWithText("Save").performScrollTo().performClick()

        assertEquals(listOf(30u), hourly)
        assertEquals(listOf(false), detection)
        assertEquals(true, saved)
    }

    @Test
    fun seeAllPagesThroughABreakdown() {
        var more = false
        val dimension = TrafficDimensionView(
            "page", "Pages", false, null, (0 until 5).map { row("/p$it", "${100 - it}", 0.1f) }, "120 in all", true,
        )
        show(view(traffic(dimension = dimension)), TrafficIntents(moreDimension = { more = true }))

        compose.onNodeWithText("120 in all").assertExists()
        compose.onNodeWithText("Show more").performClick()

        assertEquals(true, more)
    }

    @Test
    fun aDeployNotificationOpensDeployOnceConnected() {
        assertEquals("deploy", tabFor(NotificationDestination.DEPLOY, connected = true))
        assertEquals("inbox", tabFor(NotificationDestination.DEPLOY, connected = false))
    }
}
