import Charts
import SwiftUI

/// What the traffic screens ask the core for (E111), as on Android.
struct TrafficIntents {
    var open: () -> Void = {}
    var close: () -> Void = {}
    var setTab: (TrafficTab) -> Void = { _ in }
    var setRange: (TrafficRange) -> Void = { _ in }
    var setSite: (String?) -> Void = { _ in }
    var setGranularity: (String) -> Void = { _ in }
    var block: (Int64) -> Void = { _ in }
    var unblock: (Int64) -> Void = { _ in }
    var openSettings: () -> Void = {}
    var closeSettings: () -> Void = {}
    var setStatistics: (Bool) -> Void = { _ in }
    var setCountries: (Bool) -> Void = { _ in }
    var setHourly: (UInt32) -> Void = { _ in }
    var setDaily: (UInt32) -> Void = { _ in }
    var setDetection: (Bool) -> Void = { _ in }
    var saveSettings: () -> Void = {}
    var openDimension: (String) -> Void = { _ in }
    var moreDimension: () -> Void = {}
    var closeDimension: () -> Void = {}
}

private let tabs: [(TrafficTab, String)] = [(.overview, "Overview"), (.attacks, "Attacks"), (.blocked, "Blocked")]

private extension TrafficTone {
    func color(_ palette: RunovaPalette) -> Color {
        switch self {
        case .good: return palette.success
        case .bad: return palette.destructive
        case .neutral: return palette.mutedForeground
        }
    }
}

private extension TrafficTrend {
    var arrow: String {
        switch self {
        case .up: return "\u{2191} "
        case .down: return "\u{2193} "
        case .flat: return ""
        }
    }
}

private struct Muted: View {
    let text: String

    @Environment(\.palette) private var palette

    init(_ text: String) { self.text = text }

    var body: some View { RunovaText(text, style: RunovaType.small, color: palette.mutedForeground) }
}

/// The traffic screens over the server: "See all", the settings, or the report itself.
struct TrafficOverlay: View {
    let traffic: TrafficScreen
    let error: String?
    let intents: TrafficIntents

    var body: some View {
        if let dimension = traffic.dimension {
            TrafficDimensionScreen(dimension: dimension, intents: intents)
        } else if let settings = traffic.settings {
            TrafficSettingsScreen(settings: settings, server: traffic.serverName, intents: intents)
        } else {
            TrafficMain(traffic: traffic, error: error, intents: intents)
        }
    }
}

/// The way into a server's traffic, on its overview.
struct TrafficEntry: View {
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaSectionTitle(text: "Websites")
                .padding(.top, 14)
                .padding(.bottom, 4)
            RunovaListRow(
                title: "Traffic and attacks", detail: "Visitors, countries and attacks on the sites",
                icon: RunovaIcons.globe, onTap: onOpen)
        }
    }
}

private struct TrafficMain: View {
    let traffic: TrafficScreen
    let error: String?
    let intents: TrafficIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(
            title: "Traffic", subtitle: traffic.serverName, onBack: intents.close,
            trailing: {
                if traffic.canAdmin {
                    RunovaChip(text: "Settings", icon: RunovaIcons.settings, action: intents.openSettings)
                        .padding(.trailing, 8)
                }
            }
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ChoiceChips(options: tabs, selected: traffic.tab) { intents.setTab($0) }
                    if traffic.sites.count > 1 {
                        ChoiceChips(options: traffic.sites.map { ($0.id, $0.label) }, selected: traffic.siteId) {
                            intents.setSite($0)
                        }
                    }
                    switch traffic.tab {
                    case .overview: TrafficOverview(traffic: traffic, intents: intents)
                    case .attacks: TrafficAttacks(attacks: traffic.attacks, intents: intents)
                    case .blocked: TrafficBlocked(blocked: traffic.blocked, intents: intents)
                    }
                }
                .padding(16)
            }
            if let error { ErrorText(message: error).padding(16) }
        }
    }
}

private struct TrafficOverview: View {
    let traffic: TrafficScreen
    let intents: TrafficIntents

    var body: some View {
        ChoiceChips(options: traffic.ranges.map { ($0.range, $0.label) }, selected: traffic.range) {
            intents.setRange($0)
        }
        let buckets = traffic.granularities.filter(\.enabled)
        if buckets.count > 1 {
            ChoiceChips(
                options: buckets.map { ($0.value, $0.label) },
                selected: buckets.first(where: \.selected)?.value ?? ""
            ) { intents.setGranularity($0) }
        }
        if traffic.loading {
            LoadingRows()
        } else if let problem = traffic.problem {
            ErrorText(message: problem)
        } else if let off = traffic.off {
            RunovaCard {
                VStack(alignment: .leading, spacing: 8) {
                    RunovaText("Traffic statistics are off", style: RunovaType.title)
                    Muted(off)
                    if traffic.canAdmin {
                        RunovaButton(text: "Settings", icon: RunovaIcons.settings, action: intents.openSettings)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            Group {
                if let empty = traffic.empty { Muted(empty) }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                    ForEach(traffic.kpis, id: \.label) { KpiTile(kpi: $0) }
                }
                if let chart = traffic.chart { TrafficChartCard(chart: chart) }
            }
            .opacity(traffic.refreshing ? 0.55 : 1)
            if let devices = traffic.devices { DevicesCard(devices: devices) }
            if let countries = traffic.countries {
                BreakdownCard(breakdown: countries, note: traffic.countrySources, intents: intents)
            }
            ForEach(traffic.breakdowns, id: \.dimension) { BreakdownCard(breakdown: $0, note: nil, intents: intents) }
        }
    }
}

private struct KpiTile: View {
    let kpi: TrafficKpiView

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard(padding: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Muted(kpi.label)
                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    if let prefix = kpi.prefix { Muted(prefix) }
                    RunovaText(kpi.value, style: RunovaType.heading)
                }
                if let change = kpi.change {
                    RunovaText(change.trend.arrow + change.text, style: RunovaType.caption, color: change.tone.color(palette))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ChartSeries: Identifiable {
    let id: String
    let color: Color
    let dashed: Bool
    let values: [Double?]
}

/// Visitors and page views with Swift Charts, the period before dashed; a finger reads a point out.
private struct TrafficChartCard: View {
    let chart: TrafficChartView

    @Environment(\.palette) private var palette
    @State private var picked: Int?

    private var series: [ChartSeries] {
        [
            ChartSeries(id: "Visitors before", color: palette.primary.opacity(0.55), dashed: true, values: chart.points.map(\.previousVisitors)),
            ChartSeries(id: "Page views before", color: palette.severityInfo.opacity(0.55), dashed: true, values: chart.points.map(\.previousPageViews)),
            ChartSeries(id: "Visitors", color: palette.primary, dashed: false, values: chart.points.map(\.visitors)),
            ChartSeries(id: "Page views", color: palette.severityInfo, dashed: false, values: chart.points.map(\.pageViews)),
        ]
    }

    private var axisMarks: [Int] {
        let count = chart.points.count
        guard count > 0 else { return [] }
        return Array(Set([0, count / 2, count - 1])).sorted()
    }

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 8) {
                RunovaText("Visitors and page views", style: RunovaType.title)
                VStack(alignment: .leading, spacing: 0) {
                    if let picked, picked < chart.points.count {
                        RunovaText(chart.points[picked].readout, style: RunovaType.small, maxLines: 1)
                        if let before = chart.points[picked].previousReadout { Muted(before) }
                    } else {
                        Muted("Touch the chart to read a point.")
                    }
                }
                .frame(height: 36, alignment: .topLeading)
                Chart {
                    ForEach(series) { line in
                        ForEach(Array(line.values.enumerated()), id: \.offset) { index, value in
                            if let value {
                                LineMark(x: .value("Point", index), y: .value("Count", value), series: .value("Series", line.id))
                                    .foregroundStyle(line.color)
                                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: line.dashed ? [5, 4] : []))
                            }
                        }
                    }
                    if let picked, picked < chart.points.count {
                        RuleMark(x: .value("Point", picked)).foregroundStyle(palette.foreground.opacity(0.35))
                    }
                }
                .chartYScale(domain: 0...max(chart.max, 1))
                .chartYAxis {
                    AxisMarks(position: .leading, values: [0, chart.max / 2, chart.max]) { value in
                        AxisGridLine().foregroundStyle(palette.border)
                        AxisValueLabel {
                            let index = value.index
                            let labels = Array(chart.yLabels.reversed())
                            if index < labels.count { Text(labels[index]).font(.caption2) }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: axisMarks) { value in
                        AxisValueLabel {
                            if let i = value.as(Int.self), i < chart.points.count { Text(chart.points[i].axis).font(.caption2) }
                        }
                    }
                }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle())
                            .gesture(
                                DragGesture(minimumDistance: 0).onChanged { drag in
                                    let origin = geometry[proxy.plotAreaFrame].origin
                                    if let x: Double = proxy.value(atX: drag.location.x - origin.x) {
                                        picked = min(max(Int(x.rounded()), 0), chart.points.count - 1)
                                    }
                                })
                    }
                }
                .frame(height: 160)
                .accessibilityLabel("Chart of visitors and page views. Touch to read a point.")
                HStack(spacing: 14) {
                    Legend(color: palette.primary, label: "Visitors")
                    Legend(color: palette.severityInfo, label: "Page views")
                    Legend(color: palette.mutedForeground, label: "Period before", dashed: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct Legend: View {
    let color: Color
    let label: String
    var dashed = false

    var body: some View {
        HStack(spacing: 6) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 4))
                path.addLine(to: CGPoint(x: 16, y: 4))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, dash: dashed ? [3, 2] : []))
            .frame(width: 16, height: 8)
            Muted(label)
        }
    }
}

private struct ShareRow: View {
    let row: TrafficRowView

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            if let flag = row.flag { RunovaText(flag, style: RunovaType.label) }
            RunovaText(row.label, style: RunovaType.label, maxLines: 1)
            Spacer(minLength: 4)
            RunovaText(row.value, style: RunovaType.label)
            RunovaText(row.shareLabel, style: RunovaType.small, color: palette.mutedForeground)
                .frame(width: 44, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(alignment: .leading) {
            GeometryReader { geometry in
                palette.primary.opacity(0.12)
                    .frame(width: geometry.size.width * CGFloat(min(max(row.share, 0), 1)))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.label), \(row.value), \(row.shareLabel)")
    }
}

private struct BreakdownCard: View {
    let breakdown: TrafficBreakdownView
    let note: String?
    let intents: TrafficIntents

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(breakdown.title, style: RunovaType.title)
                        Muted(breakdown.unit)
                    }
                    Spacer()
                    if !breakdown.rows.isEmpty {
                        RunovaChip(text: "See all") { intents.openDimension(breakdown.dimension) }
                            .accessibilityLabel("See all \(breakdown.title.lowercased())")
                    }
                }
                if breakdown.rows.isEmpty { Muted("Nothing in this range.") }
                ForEach(Array(breakdown.rows.enumerated()), id: \.offset) { _, row in ShareRow(row: row) }
                if let note { Muted(note) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Devices as a ring, drawn by hand since sector marks need iOS 17.
private struct DevicesCard: View {
    let devices: TrafficBreakdownView

    @Environment(\.palette) private var palette

    private var colors: [Color] {
        [palette.primary, palette.severityInfo, palette.warning, palette.success, palette.severityHigh, palette.mutedForeground]
    }

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                RunovaText(devices.title, style: RunovaType.title)
                HStack(spacing: 16) {
                    ZStack {
                        Circle().stroke(palette.muted, lineWidth: 14)
                        ForEach(Array(devices.rows.enumerated()), id: \.offset) { index, row in
                            let start = devices.rows.prefix(index).reduce(Float(0)) { $0 + $1.share }
                            Circle()
                                .trim(from: CGFloat(start), to: CGFloat(min(start + row.share, 1)))
                                .stroke(colors[index % colors.count], lineWidth: 14)
                                .rotationEffect(.degrees(-90))
                        }
                    }
                    .frame(width: 82, height: 82)
                    .padding(7)
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(devices.rows.enumerated()), id: \.offset) { index, row in
                            HStack(spacing: 8) {
                                Circle().fill(colors[index % colors.count]).frame(width: 10, height: 10)
                                RunovaText(row.label, style: RunovaType.label)
                                Spacer()
                                Muted(row.shareLabel)
                            }
                            .accessibilityElement(children: .combine)
                        }
                        if devices.rows.isEmpty { Muted("Nothing in this range.") }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TrafficAttacks: View {
    let attacks: TrafficAttacksView
    let intents: TrafficIntents

    @Environment(\.palette) private var palette

    var body: some View {
        if attacks.loading && attacks.items.isEmpty {
            LoadingRows()
        } else if let problem = attacks.problem {
            ErrorText(message: problem)
        } else {
            Muted(attacks.summary)
            ForEach(attacks.items, id: \.id) { attack in
                RunovaCard {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            if let flag = attack.flag { RunovaText(flag, style: RunovaType.title) }
                            VStack(alignment: .leading, spacing: 0) {
                                RunovaText(attack.address, style: RunovaType.labelStrong, maxLines: 1)
                                Muted([attack.kindLabel, attack.country, attack.site].compactMap { $0 }.joined(separator: " \u{00B7} "))
                            }
                            Spacer()
                            if attack.blocked {
                                RunovaText("Blocked", style: RunovaType.caption, color: palette.success)
                            } else if attack.canBlock {
                                RunovaChip(text: "Block", icon: RunovaIcons.shield, tone: .danger) { intents.block(attack.id) }
                                    .accessibilityLabel("Block \(attack.address)")
                            }
                        }
                        Muted("\(attack.countLabel), last \(attack.whenLabel)")
                        ForEach(attack.paths, id: \.self) { path in
                            RunovaText(path, style: RunovaType.mono, color: palette.mutedForeground, maxLines: 1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

private struct TrafficBlocked: View {
    let blocked: TrafficBlockedView
    let intents: TrafficIntents

    var body: some View {
        if blocked.loading && blocked.items.isEmpty {
            LoadingRows()
        } else if let problem = blocked.problem {
            ErrorText(message: problem)
        } else if blocked.items.isEmpty {
            Muted("No address is blocked.")
        } else {
            ForEach(blocked.items, id: \.id) { item in
                RunovaCard {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            RunovaText(item.network, style: RunovaType.labelStrong)
                            if !item.reason.isEmpty { RunovaText(item.reason, style: RunovaType.small) }
                            Muted(item.detail)
                        }
                        Spacer()
                        if item.canUnblock {
                            RunovaChip(text: "Unblock") { intents.unblock(item.id) }
                                .accessibilityLabel("Unblock \(item.network)")
                        }
                    }
                }
            }
        }
    }
}

private func daysLabel(_ days: UInt32) -> String {
    if days >= 365 && days % 365 == 0 { return days == 365 ? "1 year" : "\(days / 365) years" }
    return "\(days) days"
}

private struct TrafficSettingsScreen: View {
    let settings: TrafficSettingsView
    let server: String
    let intents: TrafficIntents

    var body: some View {
        FormScreen(title: "Traffic settings", subtitle: server, onBack: intents.closeSettings) {
            if settings.loading {
                LoadingRows()
            } else {
                let editable = !settings.saving
                SwitchRow(
                    title: "Statistics", detail: "Read the access logs nginx writes for each website.",
                    icon: RunovaIcons.globe, isOn: settings.statistics, enabled: editable, onChange: intents.setStatistics)
                SwitchRow(
                    title: "Countries", detail: "Place visitors by country, from Cloudflare or the DB-IP database.",
                    icon: RunovaIcons.globe, isOn: settings.countries, enabled: editable, onChange: intents.setCountries)
                Field(label: "Keep hourly figures for") {
                    ChoiceChips(
                        options: settings.hourlyChoices.map { ($0, daysLabel($0)) }, selected: settings.hourlyDays,
                        enabled: editable
                    ) { intents.setHourly($0) }
                }
                Field(label: "Keep daily figures for") {
                    ChoiceChips(
                        options: settings.dailyChoices.map { ($0, daysLabel($0)) }, selected: settings.dailyDays,
                        enabled: editable
                    ) { intents.setDaily($0) }
                }
                SwitchRow(
                    title: "Attack detection",
                    detail: "Watch the same lines for scans, password guessing, floods and injection probes.",
                    icon: RunovaIcons.shield, isOn: settings.detection, enabled: editable, onChange: intents.setDetection)
                Muted(settings.autoBlock)
                Muted(settings.storage)
                if let problem = settings.problem { ErrorText(message: problem) }
                RunovaButton(
                    text: settings.saving ? "Saving" : "Save", enabled: settings.dirty && editable,
                    action: intents.saveSettings)
                RunovaButton(text: "Cancel", kind: .ghost, action: intents.closeSettings)
            }
        }
    }
}

private struct TrafficDimensionScreen: View {
    let dimension: TrafficDimensionView
    let intents: TrafficIntents

    var body: some View {
        RunovaScreen(
            title: dimension.title, subtitle: dimension.totalLabel.isEmpty ? nil : dimension.totalLabel,
            onBack: intents.closeDimension
        ) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(dimension.rows.enumerated()), id: \.offset) { _, row in ShareRow(row: row) }
                    if let problem = dimension.problem { ErrorText(message: problem) }
                    if dimension.loading {
                        LoadingRows()
                    } else if dimension.rows.isEmpty {
                        RunovaEmptyState(icon: RunovaIcons.search, title: "Nothing in this range.", detail: "")
                    } else if dimension.canLoadMore {
                        RunovaButton(text: "Show more", kind: .soft, action: intents.moreDimension)
                    }
                }
                .padding(16)
            }
        }
    }
}
