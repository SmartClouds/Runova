import SwiftUI

struct MonitoringIntents {
    var open: (String) -> Void = { _ in }
    var close: () -> Void = {}
    var check: (String) -> Void = { _ in }
    var setPaused: (String, MonitorSource, Bool) -> Void = { _, _, _ in }
}

struct PipelineIntents {
    var openRun: (Int64) -> Void = { _ in }
    var closeRun: () -> Void = {}
    var openJob: (Int64) -> Void = { _ in }
    var closeJob: () -> Void = {}
    var dispatch: (Int64) -> Void = { _ in }
    var cancel: (Int64) -> Void = { _ in }
}

private func monitorBadge(_ state: MonitorState) -> RunovaBadge {
    switch state {
    case .up: return RunovaBadge(text: "Up", tone: .success)
    case .degraded: return RunovaBadge(text: "Degraded", tone: .warning)
    case .down: return RunovaBadge(text: "Down", tone: .warning)
    case .paused: return RunovaBadge(text: "Paused")
    case .unknown: return RunovaBadge(text: "Unknown")
    }
}

private func runBadge(_ label: String, _ state: PipelineRunState) -> RunovaBadge {
    switch state {
    case .success: return RunovaBadge(text: label, tone: .success)
    case .failed: return RunovaBadge(text: label, tone: .warning)
    case .running: return RunovaBadge(text: label, tone: .primary)
    case .queued, .other: return RunovaBadge(text: label)
    }
}

private struct GroupTitle: View {
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaText(text, style: RunovaType.caption, color: palette.mutedForeground)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }
}

struct MonitoringTab: View {
    let view: AppView
    let intents: MonitoringIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let screen = view.monitoring
        if screen.local.isEmpty && screen.cloud.isEmpty && screen.loading {
            LoadingRows()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    GroupTitle(text: "On this computer")
                    if let note = screen.localNote {
                        RunovaText(note, style: RunovaType.small, color: palette.mutedForeground)
                    }
                    ForEach(screen.local, id: \.id) { MonitorRow(monitor: $0, intents: intents) }
                    GroupTitle(text: "Runova Cloud")
                    ForEach(screen.cloud, id: \.id) { MonitorRow(monitor: $0, intents: intents) }
                }
                .padding(16)
            }
        }
    }
}

private struct MonitorRow: View {
    let monitor: MonitorView
    let intents: MonitoringIntents

    var body: some View {
        Button {
            intents.open(monitor.id)
        } label: {
            HStack(spacing: 8) {
                RunovaListRow(
                    title: monitor.name, detail: monitor.detail ?? monitor.latencyLabel, icon: RunovaIcons.monitoring)
                monitorBadge(monitor.state).padding(.trailing, 16)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct MonitorScreen: View {
    let monitor: MonitorView
    let intents: MonitoringIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: monitor.name, onBack: intents.close)
            VStack(alignment: .leading, spacing: 12) {
                monitorBadge(monitor.state)
                if let detail = monitor.detail { RunovaText(detail, color: palette.mutedForeground) }
                RunovaCard {
                    HStack(alignment: .top) {
                        Stat(label: "Latency", value: monitor.latencyLabel)
                        Stat(label: "Uptime, 24 hours", value: monitor.uptimeLabel)
                    }
                }
                if !monitor.samples.isEmpty { LatencyBars(samples: monitor.samples) }
                HStack(spacing: 8) {
                    if monitor.canCheck {
                        RunovaButton(text: "Check now") { intents.check(monitor.id) }.frame(maxWidth: .infinity)
                    }
                    if monitor.canPause {
                        RunovaButton(text: monitor.paused ? "Resume" : "Pause", kind: .soft) {
                            intents.setPaused(monitor.id, monitor.source, !monitor.paused)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .padding(16)
            Spacer(minLength: 0)
        }
    }
}

private struct Stat: View {
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

private struct LatencyBars: View {
    let samples: [Double]

    @Environment(\.palette) private var palette

    var body: some View {
        let highest = max(samples.max() ?? 1, 0.000_1)
        GeometryReader { geometry in
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(Array(samples.enumerated()), id: \.offset) { _, value in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(palette.primary)
                        .frame(height: geometry.size.height * max(min(value / highest, 1), 0.02))
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        .frame(height: 80)
    }
}

struct PipelinesTab: View {
    let view: AppView
    let intents: PipelineIntents

    var body: some View {
        if view.selectedProject == nil {
            RunovaEmptyState(
                icon: RunovaIcons.pipelines, title: "Choose a project",
                detail: "Pick one in Projects to see its pipelines.")
        } else if let status = view.pipelines.status {
            if let problem = status.problem {
                RunovaEmptyState(icon: RunovaIcons.warning, title: problem, detail: "")
            } else if status.workflows.isEmpty {
                RunovaEmptyState(
                    icon: RunovaIcons.pipelines, title: "No workflows",
                    detail: "This repository has no GitHub Actions workflows.")
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(status.workflows, id: \.id) { WorkflowCard(workflow: $0, intents: intents) }
                    }
                    .padding(16)
                }
            }
        } else {
            LoadingRows()
        }
    }
}

private struct WorkflowCard: View {
    let workflow: WorkflowView
    let intents: PipelineIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    RunovaText(workflow.name, style: RunovaType.title)
                    Spacer(minLength: 0)
                    if workflow.canDispatch {
                        RunovaChip(text: "Run") { intents.dispatch(workflow.id) }
                    }
                }
                if let run = workflow.run {
                    HStack(spacing: 6) {
                        Button {
                            intents.openRun(run.id)
                        } label: {
                            RunovaListRow(
                                title: run.title, detail: "#\(run.number) on \(run.branch)", icon: RunovaIcons.git
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        runBadge(run.stateLabel, run.state)
                        if run.canCancel {
                            RunovaChip(text: "Cancel") { intents.cancel(run.id) }
                        }
                    }
                } else {
                    RunovaText("Never run", style: RunovaType.small, color: palette.mutedForeground)
                }
            }
        }
    }
}

struct RunScreen: View {
    let run: PipelineRunDetailView
    let intents: PipelineIntents

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: "Run", onBack: intents.closeRun)
            if run.loading {
                LoadingRows()
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(run.jobs, id: \.id) { job in
                            Button {
                                intents.openJob(job.id)
                            } label: {
                                HStack(spacing: 8) {
                                    RunovaListRow(title: job.name, detail: nil, icon: RunovaIcons.pipelines)
                                    runBadge(job.stateLabel, job.state).padding(.trailing, 16)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct JobLogScreen: View {
    let log: JobLogView
    let intents: PipelineIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: log.name, onBack: intents.closeJob)
            if log.truncated {
                RunovaText(
                    "Only the end of this log is shown.", style: RunovaType.small, color: palette.mutedForeground
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
            if log.loading {
                LoadingRows()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(log.lines.enumerated()), id: \.offset) { _, line in
                            RunovaText(
                                line.text, style: RunovaType.mono,
                                color: line.error ? RunovaTokens.terminal.red : RunovaTokens.terminal.foreground)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(RunovaTokens.terminal.background)
            }
        }
    }
}
