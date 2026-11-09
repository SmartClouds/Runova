import SwiftUI

struct StatusIntents {
    var openProvider: (String) -> Void = { _ in }
    var closeProvider: () -> Void = {}
}

private func limitBadge(_ state: LimitState) -> RunovaBadge? {
    switch state {
    case .ok: return nil
    case .estimate: return RunovaBadge(text: "Estimate")
    case .stale: return RunovaBadge(text: "Out of date", tone: .warning)
    case .unavailable: return RunovaBadge(text: "Unavailable", tone: .warning)
    }
}

private func providerBadge(_ state: ProviderState) -> RunovaBadge {
    switch state {
    case .ok: return RunovaBadge(text: "Connected", tone: .success, dot: true)
    case .connect: return RunovaBadge(text: "Not connected", dot: true)
    case .error: return RunovaBadge(text: "Problem", tone: .warning, dot: true)
    }
}

private func providerTone(_ state: ProviderState) -> BadgeTone {
    switch state {
    case .ok: return .success
    case .connect: return .neutral
    case .error: return .warning
    }
}

struct StatusTab: View {
    let view: AppView
    let intents: StatusIntents

    @Environment(\.palette) private var palette

    var body: some View {
        if let system = view.status.system {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ComputerCard(system: system)
                    if !view.status.computer.isEmpty { ComputerList(items: view.status.computer) }
                    ForEach(view.status.limits, id: \.providerId) { LimitCard(limit: $0) }
                    RunovaSectionTitle(text: "All providers")
                    ForEach(view.status.providers, id: \.providerId) { provider in
                        Button {
                            intents.openProvider(provider.providerId)
                        } label: {
                            HStack(spacing: 8) {
                                RunovaListRow(
                                    title: provider.name, detail: provider.todayLabel.map { "\($0) today" },
                                    icon: RunovaIcons.agent, iconTone: providerTone(provider.state), flat: true)
                                providerBadge(provider.state)
                            }
                            .padding(.trailing, 12)
                            .rowCard()
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        } else {
            LoadingRows()
        }
    }
}

private struct Meter: View {
    let label: String
    let value: String
    let percent: Double
    let detail: String
    var icon: String?

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let icon { RunovaIcon(glyph: icon, size: 14, color: palette.primary) }
                RunovaText(label, style: RunovaType.label)
                Spacer(minLength: 0)
                RunovaText(value, style: RunovaType.label)
            }
            RunovaProgress(percent: percent)
            RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground)
        }
    }
}

private struct ComputerCard: View {
    let system: SystemStatsView

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 14) {
                Meter(
                    label: "CPU", value: system.cpuLabel, percent: system.cpuPercent, detail: system.cpuDetail,
                    icon: RunovaIcons.cpu)
                Meter(
                    label: "Memory", value: "\(Int(system.memPercent))%", percent: system.memPercent,
                    detail: system.memLabel, icon: RunovaIcons.memory)
                HStack(spacing: 8) {
                    RunovaIcon(glyph: RunovaIcons.network, size: 14, color: palette.primary)
                    RunovaText(
                        "Down \(system.netDownLabel), up \(system.netUpLabel)", style: RunovaType.small,
                        color: palette.mutedForeground)
                }
            }
        }
    }
}

private func computerIcon(_ id: String) -> String {
    if id.hasPrefix("run:") { return RunovaIcons.playCircle }
    if id.hasPrefix("plan:") { return RunovaIcons.sparkles }
    switch id {
    case "agents": return RunovaIcons.agent
    case "window": return RunovaIcons.playCircle
    case "relay": return RunovaIcons.bolt
    case "transfers": return RunovaIcons.file
    case "terminals": return RunovaIcons.terminal
    case "sync": return RunovaIcons.cloud
    case "github": return RunovaIcons.git
    case "docker": return RunovaIcons.deploy
    case "android": return RunovaIcons.mobile
    case "keep-awake": return RunovaIcons.clock
    default: return RunovaIcons.monitoring
    }
}

/// The rest of the desktop's status bar: what this computer can tell with no window open.
private struct ComputerList: View {
    let items: [ComputerItemView]

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                RunovaSectionTitle(text: "On this computer")
                ForEach(items, id: \.id) { item in
                    HStack(spacing: 10) {
                        RunovaIconTile(icon: computerIcon(item.id), tone: item.attention ? .warning : .primary, size: 30)
                        VStack(alignment: .leading, spacing: 0) {
                            RunovaText(item.title, style: RunovaType.label)
                            if let detail = item.detail {
                                RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground)
                            }
                        }
                        Spacer(minLength: 8)
                        RunovaBadge(text: item.value, tone: item.attention ? .warning : .neutral, dot: item.attention)
                    }
                }
            }
        }
    }
}

private struct LimitCard: View {
    let limit: LimitChipView

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    RunovaIcon(glyph: RunovaIcons.agent, size: 15, color: palette.primary)
                    RunovaText(limit.name, style: RunovaType.title)
                    if let plan = limit.plan { RunovaBadge(text: plan) }
                    Spacer(minLength: 0)
                    limitBadge(limit.state)
                }
                ForEach(limit.windows, id: \.label) { window in
                    Meter(
                        label: window.label, value: window.percentLabel, percent: window.percent,
                        detail: window.resetsLabel ?? "")
                }
                if limit.state != .ok, let problem = limit.problem {
                    RunovaText(problem, style: RunovaType.small, color: palette.mutedForeground)
                }
            }
        }
        .opacity(limit.state == .stale ? 0.7 : 1)
    }
}

struct ProviderScreen: View {
    let provider: ProviderUsageView
    let intents: StatusIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: provider.name, onBack: intents.closeProvider) {
            VStack(alignment: .leading, spacing: 12) {
                if let error = provider.error { RunovaText(error, color: palette.destructive) }
                RunovaCard {
                    HStack(alignment: .top) {
                        Figure(label: "Today", value: provider.todayLabel)
                        Figure(label: "7 days", value: provider.weekLabel)
                        Figure(label: "30 days", value: provider.monthLabel)
                    }
                }
                if !provider.series.isEmpty { UsageBars(series: provider.series) }
            }
            .padding(16)
            Spacer(minLength: 0)
        }
    }
}

private struct Figure: View {
    let label: String
    let value: String?

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            RunovaText(label, style: RunovaType.caption, color: palette.mutedForeground)
            RunovaText(value ?? "None", style: RunovaType.title)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct UsageBars: View {
    let series: [Double]

    @Environment(\.palette) private var palette

    var body: some View {
        let highest = max(series.max() ?? 1, 0.000_1)
        GeometryReader { geometry in
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(Array(series.enumerated()), id: \.offset) { _, value in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(palette.primary)
                        .frame(height: geometry.size.height * max(min(value / highest, 1), 0.02))
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .frame(height: 120)
    }
}
