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
    case .ok: return RunovaBadge(text: "Connected", tone: .success)
    case .connect: return RunovaBadge(text: "Not connected")
    case .error: return RunovaBadge(text: "Problem", tone: .warning)
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
                    ForEach(view.status.limits, id: \.providerId) { LimitCard(limit: $0) }
                    RunovaText("All providers", style: RunovaType.caption, color: palette.mutedForeground)
                    ForEach(view.status.providers, id: \.providerId) { provider in
                        Button {
                            intents.openProvider(provider.providerId)
                        } label: {
                            HStack(spacing: 8) {
                                RunovaListRow(
                                    title: provider.name, detail: provider.todayLabel.map { "\($0) today" },
                                    icon: RunovaIcons.monitoring)
                                providerBadge(provider.state).padding(.trailing, 16)
                            }
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

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
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
                Meter(label: "CPU", value: system.cpuLabel, percent: system.cpuPercent, detail: system.cpuDetail)
                Meter(
                    label: "Memory", value: "\(Int(system.memPercent))%", percent: system.memPercent,
                    detail: system.memLabel)
                RunovaText(
                    "Down \(system.netDownLabel), up \(system.netUpLabel)", style: RunovaType.small,
                    color: palette.mutedForeground)
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
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: provider.name, onBack: intents.closeProvider)
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
