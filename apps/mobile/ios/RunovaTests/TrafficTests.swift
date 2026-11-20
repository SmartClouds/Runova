import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `TrafficTest.kt`, for the comparison with Android (E111).
@MainActor
final class TrafficTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: nil, direct: true, error: nil)

    private func row(_ label: String, _ value: String, _ share: Float, flag: String? = nil) -> TrafficRowView {
        TrafficRowView(label: label, value: value, share: share, shareLabel: "\(Int((share * 100).rounded()))%", flag: flag)
    }

    private func traffic(
        tab: TrafficTab = .overview, settings: TrafficSettingsView? = nil, dimension: TrafficDimensionView? = nil
    ) -> TrafficScreen {
        let ranges: [(TrafficRange, String)] = [
            (.today, "Today"), (.week, "7 days"), (.month, "30 days"), (.quarter, "90 days"), (.year, "12 months"),
        ]
        let kpis = [
            TrafficKpiView(
                label: "Unique visitors", value: "12.9K", prefix: "about",
                change: TrafficChangeView(text: "+16%", trend: .up, tone: .good)),
            TrafficKpiView(
                label: "Visits", value: "15K", prefix: nil,
                change: TrafficChangeView(text: "No change", trend: .flat, tone: .neutral)),
            TrafficKpiView(
                label: "Page views", value: "41K", prefix: nil,
                change: TrafficChangeView(text: "+8%", trend: .up, tone: .good)),
            TrafficKpiView(
                label: "Bounce rate", value: "42%", prefix: nil,
                change: TrafficChangeView(text: "+9%", trend: .up, tone: .bad)),
            TrafficKpiView(label: "Pages per visit", value: "2.7", prefix: nil, change: nil),
            TrafficKpiView(label: "Visit length", value: "1m 35s", prefix: nil, change: nil),
            TrafficKpiView(
                label: "Bandwidth", value: "1.5 GB", prefix: nil,
                change: TrafficChangeView(text: "-3%", trend: .down, tone: .neutral)),
            TrafficKpiView(
                label: "Bot share", value: "10%", prefix: nil,
                change: TrafficChangeView(text: "-1.5%", trend: .down, tone: .good)),
        ]
        let chart = TrafficChartView(
            points: (0..<7).map { (i: Int) -> TrafficPointView in
                // Whole numbers worked out one step at a time: as one expression inside Double(),
                // the literals took the type checker past its time limit.
                let day: Int = 12 + i
                let visitors: Int = 1000 + i * 100 + (i % 2) * 300
                let pageViews: Int = 4000 + i * 500
                let previousVisitors: Int = 900 + (i % 3) * 120
                let previousPageViews: Int = 3500 + (i % 2) * 400
                return TrafficPointView(
                    axis: "\(day) Nov", visitors: Double(visitors),
                    pageViews: Double(pageViews), previousVisitors: Double(previousVisitors),
                    previousPageViews: Double(previousPageViews), readout: "Day \(day): visitors and page views",
                    previousReadout: "Period before: 900 visitors, 3,500 page views")
            },
            max: 10_000, yLabels: ["10K", "5,000", "0"])
        let attacks = TrafficAttacksView(
            loading: false, problem: nil, summary: "2 addresses in the last 7 days, 1 blocked",
            items: [
                TrafficAttackView(
                    id: 41, siteId: "blog", site: "blog.example.com", kindLabel: "Scans", address: "198.51.100.23",
                    country: "Netherlands", flag: "\u{1F1F3}\u{1F1F1}", countLabel: "412 requests", whenLabel: "2m ago",
                    paths: ["/.env", "/.git/config"], blocked: false, canBlock: true),
                TrafficAttackView(
                    id: 38, siteId: "shop", site: "shop.example.com", kindLabel: "Floods", address: "2001:db8::1",
                    country: nil, flag: nil, countLabel: "9,120 requests", whenLabel: "19h ago", paths: ["/"],
                    blocked: true, canBlock: false),
            ])
        let blocked = TrafficBlockedView(
            loading: false, problem: nil,
            items: [
                TrafficBlockedItemView(
                    id: 7, network: "203.0.113.45", reason: "Password guessing",
                    detail: "Automatic, 2h ago, on shop.example.com. Lifted in 3h.", canUnblock: true),
                TrafficBlockedItemView(
                    id: 8, network: "10.9.0.0/16", reason: "Blocked from the phone",
                    detail: "By sam, 3d ago, every site. For good.", canUnblock: true),
            ])
        return TrafficScreen(
            serverId: "srv1", serverName: "Prod", loading: false, refreshing: false, problem: nil, tab: tab,
            siteId: nil, siteLabel: "All websites",
            sites: [
                TrafficSiteView(id: nil, label: "All websites", selected: true),
                TrafficSiteView(id: "blog", label: "blog.example.com", selected: false),
                TrafficSiteView(id: "shop", label: "shop.example.com", selected: false),
            ],
            range: .week,
            ranges: ranges.map { TrafficRangeView(range: $0.0, label: $0.1, selected: $0.0 == .week) },
            granularities: [
                TrafficGranularityView(value: "hour", label: "Hour", enabled: true, selected: false, reason: nil),
                TrafficGranularityView(value: "day", label: "Day", enabled: true, selected: true, reason: nil),
            ],
            canAdmin: true, off: nil, empty: nil, kpis: kpis, chart: chart,
            breakdowns: [
                TrafficBreakdownView(
                    dimension: "page", title: "Pages", unit: "page views",
                    rows: [row("/", "20.5K", 0.5), row("/blog", "10.3K", 0.25), row("/about", "4,100", 0.1)])
            ],
            devices: TrafficBreakdownView(
                dimension: "device", title: "Devices", unit: "page views",
                rows: [row("Desktop", "30.8K", 0.75), row("Mobile", "8,200", 0.2), row("Tablet", "2,050", 0.05)]),
            countries: TrafficBreakdownView(
                dimension: "country", title: "Countries", unit: "page views",
                rows: [
                    row("United States", "20.5K", 0.5, flag: "\u{1F1FA}\u{1F1F8}"),
                    row("Germany", "6,150", 0.15, flag: "\u{1F1E9}\u{1F1EA}"), row("Unknown", "100", 0.01),
                ]),
            countrySources: "82% from Cloudflare, 18% from DB-IP", attacks: attacks, blocked: blocked,
            settings: settings, dimension: dimension)
    }

    private func view(_ screen: TrafficScreen) -> AppView {
        let server = ServerDetailView(
            id: "srv1", name: "Prod", loading: false, unreachable: nil, containers: [], stacks: [], problems: [],
            backup: nil)
        return fixtureView(
            connection: connected,
            deploy: DeployScreen(
                servers: [
                    DeployServerView(
                        id: "srv1", name: "Prod", host: "10.0.0.1", stateLabel: "Online", online: true, problem: nil)
                ], loading: false, server: server, logs: nil, traffic: screen))
    }

    func testTraffic() throws {
        try renderSnapshot(view(traffic()), "traffic", tab: "deploy")
    }

    func testTrafficLight() throws {
        try renderSnapshot(view(traffic()), "traffic-light", tab: "deploy", dark: false)
    }

    func testTrafficAttacks() throws {
        try renderSnapshot(view(traffic(tab: .attacks)), "traffic-attacks", tab: "deploy")
    }

    func testTrafficBlocked() throws {
        try renderSnapshot(view(traffic(tab: .blocked)), "traffic-blocked", tab: "deploy")
    }

    func testTrafficSettings() throws {
        let settings = TrafficSettingsView(
            loading: false, saving: false, problem: nil, statistics: true, countries: true, hourlyDays: 90,
            hourlyChoices: [7, 30, 90, 180, 365], dailyDays: 730, dailyChoices: [30, 365, 730, 1825], detection: true,
            autoBlock: "Auto-block is on for scans and password guessing, for 1h. Change it on the computer.",
            storage: "12 MB of statistics on the server", dirty: true)
        try renderSnapshot(view(traffic(settings: settings)), "traffic-settings", tab: "deploy")
    }

    func testADeployNotificationOpensDeployOnceConnected() {
        XCTAssertEqual(tabFor(.deploy, connected: true), "deploy")
        XCTAssertEqual(tabFor(.deploy, connected: false), "inbox")
    }
}
