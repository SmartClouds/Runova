import SwiftUI

struct DeployIntents {
    var openServer: (String) -> Void = { _ in }
    var closeServer: () -> Void = {}
    var openLogs: (String) -> Void = { _ in }
    var closeLogs: () -> Void = {}
    var containerAction: (String, String) -> Void = { _, _ in }
    var stackAction: (String, String) -> Void = { _, _ in }
    var redeploy: (String) -> Void = { _ in }
}

struct DeployTab: View {
    let view: AppView
    let intents: DeployIntents

    var body: some View {
        if view.deploy.servers.isEmpty && view.deploy.loading {
            LoadingRows()
        } else if view.deploy.servers.isEmpty {
            RunovaEmptyState(
                icon: RunovaIcons.deploy, title: "No servers yet", detail: "Add one in Deploy on this computer.")
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(view.deploy.servers, id: \.id) { server in
                        Button {
                            intents.openServer(server.id)
                        } label: {
                            HStack(spacing: 8) {
                                RunovaListRow(
                                    title: server.name, detail: server.problem ?? server.host, icon: RunovaIcons.server,
                                    iconTone: server.online ? .primary : .warning, flat: true)
                                RunovaBadge(text: server.stateLabel, tone: server.online ? .success : .warning, dot: true)
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
    }
}

private struct Heading: View {
    let text: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaSectionTitle(text: text)
            .padding(.top, 14)
            .padding(.bottom, 4)
    }
}

struct ServerScreen: View {
    let server: ServerDetailView
    let error: String?
    let intents: DeployIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: server.name, onBack: intents.closeServer) {
            if server.loading {
                LoadingRows()
            } else if let unreachable = server.unreachable {
                RunovaEmptyState(icon: RunovaIcons.warning, title: unreachable, detail: "")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if !server.problems.isEmpty {
                            Heading(text: "Problems")
                            ForEach(server.problems, id: \.id) { ProblemRow(problem: $0) }
                        }
                        Heading(text: "Containers")
                        ForEach(server.containers, id: \.id) { ContainerRow(container: $0, intents: intents) }
                        Heading(text: "Apps")
                        ForEach(server.stacks, id: \.id) { StackRow(stack: $0, intents: intents) }
                        if let backup = server.backup {
                            Heading(text: "Backups")
                            RunovaCard {
                                VStack(alignment: .leading, spacing: 4) {
                                    RunovaText(backup.label, style: RunovaType.label)
                                    if !backup.detail.isEmpty {
                                        RunovaText(
                                            backup.detail, style: RunovaType.small,
                                            color: backup.failed ? palette.destructive : palette.mutedForeground)
                                    }
                                }
                            }
                        }
                    }
                    .padding(16)
                }
            }
            if let error {
                RunovaText(error, style: RunovaType.small, color: palette.destructive).padding(16)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct ProblemRow: View {
    let problem: ProblemView

    var body: some View {
        HStack(spacing: 8) {
            RunovaListRow(
                title: problem.title, detail: problem.detail, icon: RunovaIcons.warning,
                iconTone: problem.severity == .critical ? .danger : .warning, flat: true)
            problem.severity == .critical
                ? RunovaBadge(text: "Critical", tone: .danger, dot: true) : RunovaBadge(text: "Warning")
        }
        .padding(.trailing, 12)
        .rowCard()
    }
}

private struct ContainerRow: View {
    let container: ContainerView
    let intents: DeployIntents

    private var tone: BadgeTone {
        if container.healthy == false { return .danger }
        return container.running ? .success : .neutral
    }

    private func chip(_ label: String, _ action: String, _ icon: String, _ tone: ChipTone = .soft) -> some View {
        RunovaChip(text: label, icon: icon, tone: tone) { intents.containerAction(container.id, action) }
            .accessibilityLabel("\(label) \(container.name)")
    }

    var body: some View {
        HStack(spacing: 6) {
            Button {
                intents.openLogs(container.id)
            } label: {
                RunovaListRow(title: container.name, detail: container.status, icon: RunovaIcons.deploy, iconTone: tone, flat: true)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if container.running {
                chip("Restart", "restart", RunovaIcons.refresh)
                chip("Stop", "stop", RunovaIcons.stop, .danger)
            } else {
                chip("Start", "start", RunovaIcons.play)
            }
        }
        .padding(.trailing, 12)
        .rowCard()
    }
}

private struct StackRow: View {
    let stack: StackView
    let intents: DeployIntents

    var body: some View {
        HStack(spacing: 6) {
            RunovaListRow(title: stack.name, detail: stack.detail, icon: RunovaIcons.deploy, flat: true)
            if stack.canRedeploy {
                RunovaChip(text: "Redeploy", icon: RunovaIcons.bolt, tone: .primary) { intents.redeploy(stack.id) }
            }
            RunovaChip(text: "Restart", icon: RunovaIcons.refresh) { intents.stackAction(stack.id, "restart") }
                .accessibilityLabel("Restart \(stack.name)")
        }
        .padding(.trailing, 12)
        .rowCard()
    }
}

struct LogsScreen: View {
    let logs: ContainerLogsView
    let intents: DeployIntents

    var body: some View {
        RunovaScreen(title: logs.name, onBack: intents.closeLogs) {
            if logs.loading {
                LoadingRows()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(logs.lines.enumerated()), id: \.offset) { _, line in
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
