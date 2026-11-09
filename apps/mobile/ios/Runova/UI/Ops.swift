import SwiftUI

struct MonitoringIntents {
    var open: (String) -> Void = { _ in }
    var close: () -> Void = {}
    var check: (String) -> Void = { _ in }
    var setPaused: (String, MonitorSource, Bool) -> Void = { _, _, _ in }
    var openErrors: () -> Void = {}
    var closeErrors: () -> Void = {}
    var openIssue: (String, String) -> Void = { _, _ in }
    var closeIssue: () -> Void = {}
    var resolveIssue: () -> Void = {}
    var reopenIssue: () -> Void = {}
}

struct PipelineIntents {
    var openRun: (Int64) -> Void = { _ in }
    var closeRun: () -> Void = {}
    var openJob: (Int64) -> Void = { _ in }
    var closeJob: () -> Void = {}
    var dispatch: (Int64) -> Void = { _ in }
    var submitDispatch: ([String: String]) -> Void = { _ in }
    var closeDispatch: () -> Void = {}
    var cancel: (Int64) -> Void = { _ in }
    var fixWithAi: (Int64, String?, String?, String?) -> Void = { _, _, _, _ in }
    var autoFixStart: (Int64, String?, String?, String?) -> Void = { _, _, _, _ in }
    var autoFixStop: (String) -> Void = { _ in }
    var autoFixRetry: (String) -> Void = { _ in }
    var autoFixCommit: (String) -> Void = { _ in }
    var autoFixDismiss: (String) -> Void = { _ in }
    var watchAgent: (String) -> Void = { _ in }
}

private func monitorBadge(_ state: MonitorState) -> RunovaBadge {
    switch state {
    case .up: return RunovaBadge(text: "Up", tone: .success, dot: true)
    case .degraded: return RunovaBadge(text: "Degraded", tone: .warning, dot: true)
    case .down: return RunovaBadge(text: "Down", tone: .danger, dot: true)
    case .paused: return RunovaBadge(text: "Paused", dot: true)
    case .unknown: return RunovaBadge(text: "Unknown", dot: true)
    }
}

private func monitorTone(_ state: MonitorState) -> BadgeTone {
    switch state {
    case .up: return .success
    case .degraded: return .warning
    case .down: return .danger
    case .paused, .unknown: return .neutral
    }
}

private func runTone(_ state: PipelineRunState) -> BadgeTone {
    switch state {
    case .success: return .success
    case .failed: return .danger
    case .running: return .primary
    case .queued, .other: return .neutral
    }
}

private func levelBadge(_ label: String, _ level: ErrorLevel) -> RunovaBadge {
    switch level {
    case .fatal, .error: return RunovaBadge(text: label, tone: .danger, dot: true)
    case .warning: return RunovaBadge(text: label, tone: .warning, dot: true)
    case .info: return RunovaBadge(text: label, tone: .primary, dot: true)
    case .debug: return RunovaBadge(text: label, dot: true)
    }
}

private func levelTone(_ level: ErrorLevel) -> BadgeTone {
    switch level {
    case .fatal, .error: return .danger
    case .warning: return .warning
    case .info: return .primary
    case .debug: return .neutral
    }
}

private func runBadge(_ label: String, _ state: PipelineRunState) -> RunovaBadge {
    switch state {
    case .success: return RunovaBadge(text: label, tone: .success, dot: true)
    case .failed: return RunovaBadge(text: label, tone: .danger, dot: true)
    case .running: return RunovaBadge(text: label, tone: .primary, dot: true)
    case .queued, .other: return RunovaBadge(text: label, dot: true)
    }
}

private struct GroupTitle: View {
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaSectionTitle(text: text)
            .padding(.top, 14)
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
                    // Errors come through the computer, so the row is there only while one is open.
                    if view.connection != nil {
                        Button(action: intents.openErrors) {
                            RunovaListRow(
                                title: "Errors", detail: "Issues Sentry reports to this computer",
                                icon: RunovaIcons.warning, iconTone: .danger
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
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
                    title: monitor.name, detail: monitor.detail ?? monitor.latencyLabel,
                    icon: monitor.source == .cloud ? RunovaIcons.cloud : RunovaIcons.monitoring,
                    iconTone: monitorTone(monitor.state), flat: true)
                monitorBadge(monitor.state)
            }
            .padding(.trailing, 12)
            .rowCard()
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
        RunovaScreen(title: monitor.name, onBack: intents.close) {
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
                        RunovaButton(text: "Check now", icon: RunovaIcons.refresh) { intents.check(monitor.id) }
                            .frame(maxWidth: .infinity)
                    }
                    if monitor.canPause {
                        RunovaButton(
                            text: monitor.paused ? "Resume" : "Pause", kind: .soft,
                            icon: monitor.paused ? RunovaIcons.play : RunovaIcons.stop
                        ) {
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

private struct ProblemLine: View {
    let message: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaText(message, style: RunovaType.small, color: palette.destructive).padding(16)
    }
}

struct IssueListPage: View {
    let screen: ErrorsScreen
    let error: String?
    let intents: MonitoringIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: "Errors", onBack: intents.closeErrors) {
            Group {
                if screen.issues.isEmpty && screen.loading {
                    LoadingRows()
                } else if screen.issues.isEmpty && screen.problems.isEmpty {
                    RunovaEmptyState(icon: RunovaIcons.warning, title: screen.note ?? "", detail: "")
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(screen.problems, id: \.self) { problem in
                                RunovaText(problem, style: RunovaType.small, color: palette.warning)
                                    .padding(.bottom, 6)
                            }
                            ForEach(Array(screen.issues.enumerated()), id: \.offset) { _, issue in
                                IssueRow(issue: issue, intents: intents)
                            }
                            if let note = screen.cutNote {
                                RunovaText(note, style: RunovaType.small, color: palette.mutedForeground)
                                    .padding(.top, 8)
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            if let error { ProblemLine(message: error) }
        }
    }
}

private struct IssueRow: View {
    let issue: ErrorIssueView
    let intents: MonitoringIntents

    var body: some View {
        Button {
            intents.openIssue(issue.connectionId, issue.id)
        } label: {
            HStack(spacing: 8) {
                RunovaListRow(
                    title: issue.title, detail: issue.detailLabel, icon: RunovaIcons.warning,
                    iconTone: levelTone(issue.level), flat: true)
                levelBadge(issue.levelLabel, issue.level)
            }
            .padding(.trailing, 12)
            .rowCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct IssueDetailPage: View {
    let detail: ErrorDetailView
    let error: String?
    let intents: MonitoringIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: detail.issue?.shortId ?? "Error", onBack: intents.closeIssue) {
            Group {
                if let issue = detail.issue {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            summary(issue)
                            if detail.loading { LoadingRows() }
                            if let message = detail.message {
                                RunovaText(message, style: RunovaType.mono)
                            }
                            ForEach(Array(detail.exceptions.enumerated()), id: \.offset) { _, exception in
                                ExceptionCard(exception: exception)
                            }
                            if let request = detail.request { LabelledText(label: "Request", text: request) }
                            if !detail.tags.isEmpty {
                                LabelledText(label: "Tags", text: detail.tags.joined(separator: "\n"))
                            }
                            actions
                        }
                        .padding(16)
                    }
                } else {
                    LoadingRows()
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            if let error { ProblemLine(message: error) }
        }
    }

    private func summary(_ issue: ErrorIssueView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                levelBadge(issue.levelLabel, issue.level)
                RunovaBadge(text: issue.statusLabel)
                if let label = issue.newLabel { RunovaBadge(text: label, tone: .primary) }
            }
            RunovaText(issue.title, style: RunovaType.title)
            if let culprit = issue.culprit {
                RunovaText(culprit, style: RunovaType.small, color: palette.mutedForeground)
            }
            if let meta = detail.metaLabel {
                RunovaText(meta, style: RunovaType.small, color: palette.mutedForeground)
            }
            RunovaText(issue.activityLabel, style: RunovaType.small, color: palette.mutedForeground)
        }
    }

    @ViewBuilder private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if detail.canResolve {
                RunovaButton(text: "Resolve", icon: RunovaIcons.check, action: intents.resolveIssue)
                    .frame(maxWidth: .infinity)
            }
            if detail.canReopen {
                RunovaButton(text: "Reopen", kind: .soft, icon: RunovaIcons.refresh, action: intents.reopenIssue)
                    .frame(maxWidth: .infinity)
            }
            if let note = detail.writeNote {
                RunovaText(note, style: RunovaType.small, color: palette.mutedForeground)
            }
        }
    }
}

private struct ExceptionCard: View {
    let exception: ErrorExceptionView

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 6) {
                RunovaText(exception.title, style: RunovaType.label)
                if exception.unhandled { RunovaBadge(text: "Unhandled", tone: .danger) }
                ForEach(Array(exception.frames.enumerated()), id: \.offset) { _, frame in
                    RunovaText(frame, style: RunovaType.mono, color: palette.mutedForeground)
                }
            }
        }
    }
}

private struct LabelledText: View {
    let label: String
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            RunovaSectionTitle(text: label)
            RunovaText(text, style: RunovaType.small)
        }
    }
}

struct PipelinesTab: View {
    let view: AppView
    let intents: PipelineIntents

    @State private var sheet: FixSheet?

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
                ZStack {
                    ScrollView {
                        VStack(spacing: 12) {
                            ForEach(status.workflows, id: \.id) {
                                WorkflowCard(workflow: $0, sessions: view.autoFix, intents: intents) { sheet = $0 }
                            }
                        }
                        .padding(16)
                    }
                    if let open = sheet {
                        FixAgentSheet(
                            sheet: open,
                            branch: status.workflows.first { $0.id == open.workflowId }?.run?.branch,
                            options: view.prompts.options, intents: intents
                        ) { sheet = nil }
                    }
                }
            }
        } else {
            LoadingRows()
        }
    }
}

private struct WorkflowCard: View {
    let workflow: WorkflowView
    let sessions: [AutoFixSessionView]
    let intents: PipelineIntents
    let onSheet: (FixSheet) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    RunovaIconTile(icon: RunovaIcons.pipelines, tone: workflow.run.map { runTone($0.state) } ?? .neutral)
                    RunovaText(workflow.name, style: RunovaType.title)
                    Spacer(minLength: 0)
                    if workflow.canDispatch {
                        RunovaChip(text: "Run", icon: RunovaIcons.play, tone: .primary) { intents.dispatch(workflow.id) }
                    }
                }
                if let run = workflow.run {
                    HStack(spacing: 6) {
                        Button {
                            intents.openRun(run.id)
                        } label: {
                            RunovaListRow(
                                title: run.title, detail: "#\(run.number) on \(run.branch)", flat: true
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        runBadge(run.stateLabel, run.state)
                        if run.canCancel {
                            RunovaChip(text: "Cancel", icon: RunovaIcons.ban, tone: .danger) { intents.cancel(run.id) }
                        }
                    }
                } else {
                    RunovaText("Never run", style: RunovaType.small, color: palette.mutedForeground)
                }
                WorkflowFixes(workflow: workflow, sessions: sessions, intents: intents, onSheet: onSheet)
            }
        }
    }
}

struct DispatchForm: View {
    let form: DispatchFormView
    let intents: PipelineIntents

    @State private var values: [String: String] = [:]
    @Environment(\.palette) private var palette

    private func binding(_ name: String) -> Binding<String> {
        Binding(get: { values[name] ?? "" }, set: { values[name] = $0 })
    }

    var body: some View {
        RunovaScreen(title: form.name, onBack: intents.closeDispatch) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(form.inputs, id: \.name) { input in
                        VStack(alignment: .leading, spacing: 6) {
                            RunovaText(input.required ? "\(input.name) (required)" : input.name, style: RunovaType.label)
                            if !input.description.isEmpty {
                                RunovaText(input.description, style: RunovaType.small, color: palette.mutedForeground)
                            }
                            switch input.kind {
                            case .text: RunovaTextField(value: binding(input.name), placeholder: input.name)
                            case .toggle:
                                RunovaToggle(isOn: values[input.name] == "true", label: input.name) {
                                    values[input.name] = $0 ? "true" : "false"
                                }
                            case .choice:
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 6) {
                                        ForEach(input.options, id: \.self) { option in
                                            if values[input.name] == option {
                                                RunovaBadge(text: option, tone: .primary)
                                            } else {
                                                RunovaChip(text: option) { values[input.name] = option }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(16)
            }
            if let error = form.error {
                RunovaText(error, style: RunovaType.small, color: palette.destructive).padding(.horizontal, 16)
            }
            RunovaButton(text: "Run workflow", icon: RunovaIcons.play) { intents.submitDispatch(values) }
                .frame(maxWidth: .infinity)
                .padding(16)
        }
        .onAppear {
            for input in form.inputs where values[input.name] == nil {
                values[input.name] = input.defaultValue
            }
        }
    }
}

struct RunScreen: View {
    let run: PipelineRunDetailView
    let intents: PipelineIntents

    var body: some View {
        RunovaScreen(title: "Run", onBack: intents.closeRun) {
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
                                    RunovaListRow(title: job.name, detail: nil, icon: RunovaIcons.logs, iconTone: runTone(job.state), flat: true)
                                    runBadge(job.stateLabel, job.state)
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
        RunovaScreen(title: log.name, onBack: intents.closeJob) {
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
