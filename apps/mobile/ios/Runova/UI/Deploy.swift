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
                                    title: server.name, detail: server.problem ?? server.host, icon: RunovaIcons.server)
                                RunovaBadge(text: server.stateLabel, tone: server.online ? .success : .warning)
                                    .padding(.trailing, 16)
                            }
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
        RunovaText(text, style: RunovaType.caption, color: palette.mutedForeground)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }
}

struct ServerScreen: View {
    let server: ServerDetailView
    let error: String?
    let intents: DeployIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: server.name, onBack: intents.closeServer)
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
            RunovaListRow(title: problem.title, detail: problem.detail, icon: RunovaIcons.warning)
            problem.severity == .critical
                ? RunovaBadge(text: "Critical", tone: .warning) : RunovaBadge(text: "Warning")
        }
    }
}

private struct ContainerRow: View {
    let container: ContainerView
    let intents: DeployIntents

    private func chip(_ label: String, _ action: String) -> some View {
        RunovaChip(text: label) { intents.containerAction(container.id, action) }
            .accessibilityLabel("\(label) \(container.name)")
    }

    var body: some View {
        HStack(spacing: 6) {
            Button {
                intents.openLogs(container.id)
            } label: {
                RunovaListRow(title: container.name, detail: container.status, icon: RunovaIcons.server)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if container.running {
                chip("Restart", "restart")
                chip("Stop", "stop")
            } else {
                chip("Start", "start")
            }
        }
    }
}

private struct StackRow: View {
    let stack: StackView
    let intents: DeployIntents

    var body: some View {
        HStack(spacing: 6) {
            RunovaListRow(title: stack.name, detail: stack.detail, icon: RunovaIcons.deploy)
            if stack.canRedeploy {
                RunovaChip(text: "Redeploy") { intents.redeploy(stack.id) }
            }
            RunovaChip(text: "Restart") { intents.stackAction(stack.id, "restart") }
                .accessibilityLabel("Restart \(stack.name)")
        }
    }
}

struct LogsScreen: View {
    let logs: ContainerLogsView
    let intents: DeployIntents

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: logs.name, onBack: intents.closeLogs)
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
