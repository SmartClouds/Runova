import SwiftUI

let deviceTabs = [
    TabItem(id: "projects", title: "Projects", icon: RunovaIcons.folder),
    TabItem(id: "clis", title: "CLIs", icon: RunovaIcons.terminal),
    TabItem(id: "git", title: "Git", icon: RunovaIcons.git),
    TabItem(id: "status", title: "Status", icon: RunovaIcons.monitoring),
    TabItem(id: "more", title: "More", icon: RunovaIcons.more),
]

/// Reached from More, so the bar stays at five.
private let moreSections = [
    TabItem(id: "studio", title: "Studio", icon: RunovaIcons.studio),
    TabItem(id: "prompts", title: "Prompt Builder", icon: RunovaIcons.sparkles),
    TabItem(id: "vault", title: "Vault", icon: RunovaIcons.vault),
    TabItem(id: "deploy", title: "Deploy", icon: RunovaIcons.deploy),
    TabItem(id: "monitoring", title: "Monitoring", icon: RunovaIcons.monitoring),
    TabItem(id: "pipelines", title: "Pipelines", icon: RunovaIcons.pipelines),
    TabItem(id: "notifications", title: "Notifications", icon: RunovaIcons.notifications),
    TabItem(id: "remote", title: "Remote", icon: RunovaIcons.remote),
]

/// The width of a JetBrains Mono cell, in ems.
private let cellWidthEm: CGFloat = 0.6
private let lineHeightEm: CGFloat = 1.25
private let smallestCell: CGFloat = 7
private let largestCell: CGFloat = 13

/// Far enough to reach the live screen from anywhere in the history.
private let backToLive: Int32 = -1_000_000

private let terminalKeys: [(label: String, data: String, icon: String?)] = [
    ("Esc", "\u{1b}", nil),
    ("Tab", "\t", nil),
    ("Ctrl C", "\u{03}", nil),
    ("Ctrl D", "\u{04}", nil),
    ("Up", "\u{1b}[A", RunovaIcons.push),
    ("Down", "\u{1b}[B", RunovaIcons.pull),
    ("Left", "\u{1b}[D", RunovaIcons.left),
    ("Right", "\u{1b}[C", RunovaIcons.right),
    ("Enter", "\r", nil),
]

struct DeviceShell: View {
    let view: AppView
    let connection: ConnectionView
    @Binding var tab: String
    let intents: AppIntents

    private var section: String { (deviceTabs + moreSections).first { $0.id == tab }?.id ?? "projects" }
    private var openMonitor: MonitorView? {
        (view.monitoring.local + view.monitoring.cloud).first { $0.id == view.monitoring.open }
    }

    private var onShow: Section? {
        guard view.terminal == nil else { return nil }
        switch section {
        case "clis": return .clis
        case "git": return .git
        case "status": return .status
        case "vault": return .vault
        case "deploy": return .deploy
        case "monitoring": return .monitoring
        case "pipelines": return .pipelines
        case "notifications": return .notifications
        case "studio": return .studio
        case "prompts": return .prompts
        default: return nil
        }
    }

    var body: some View {
        Group {
            if let terminal = view.terminal {
                TerminalScreen(
                    terminal: terminal, processes: view.terminalProcesses, error: view.error, intents: intents)
            } else if section == "studio", let composer = view.studio.composer {
                StudioComposerScreen(composer: composer, busy: view.busy, error: view.error, intents: intents.studio)
            } else if section == "studio", let video = view.studio.video {
                StudioVideoScreen(
                    video: video, busy: view.busy, error: view.error, notice: view.notice, intents: intents.studio)
            } else if let tags = view.gitTools.tags {
                TagsScreen(tags: tags, error: view.error, intents: intents.git)
            } else if let diff = view.git.diff {
                DiffScreen(diff: diff, intents: intents.git)
            } else if view.git.branchesOpen {
                BranchesScreen(git: view.git, intents: intents.git)
            } else if let provider = view.status.providers.first(where: { $0.providerId == view.status.detail }) {
                ProviderScreen(provider: provider, intents: intents.status)
            } else if let entry = view.vault.entries.first(where: { $0.id == view.vault.openEntry }) {
                VaultEntryScreen(entry: entry, revealed: view.vault.revealed, intents: intents.vault)
            } else if let logs = view.deploy.logs {
                LogsScreen(logs: logs, intents: intents.deploy)
            } else if let server = view.deploy.server {
                ServerScreen(server: server, error: view.error, intents: intents.deploy)
            } else if section == "monitoring", let detail = view.errors.detail {
                IssueDetailPage(detail: detail, error: view.error, intents: intents.monitoring)
            } else if section == "monitoring", view.errors.open {
                IssueListPage(screen: view.errors, error: view.error, intents: intents.monitoring)
            } else if section == "monitoring", let monitor = openMonitor {
                MonitorScreen(monitor: monitor, intents: intents.monitoring)
            } else if let form = view.pipelines.dispatchForm {
                DispatchForm(form: form, intents: intents.pipelines)
            } else if let log = view.pipelines.log {
                JobLogScreen(log: log, intents: intents.pipelines)
            } else if let run = view.pipelines.run {
                RunScreen(run: run, intents: intents.pipelines)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    DeviceTopBar(connection: connection, intents: intents)
                    RunovaIsland {
                        Group {
                            switch section {
                            case "clis": ClisScreen(view: view, intents: intents)
                            case "git":
                                VStack(alignment: .leading, spacing: 0) {
                                    GitChangesScreen(view: view, intents: intents.git)
                                        .frame(maxHeight: .infinity, alignment: .top)
                                    if let error = view.error { ErrorLine(message: error) }
                                }
                            case "status": StatusTab(view: view, intents: intents.status)
                            case "vault":
                                VStack(alignment: .leading, spacing: 0) {
                                    VaultTab(view: view, intents: intents.vault)
                                        .frame(maxHeight: .infinity, alignment: .top)
                                    if let error = view.error { ErrorLine(message: error) }
                                }
                            case "deploy": DeployTab(view: view, intents: intents.deploy)
                            case "studio": StudioTab(view: view, intents: intents.studio)
                            case "prompts": PromptsTab(view: view, intents: intents.prompts)
                            case "monitoring": MonitoringTab(view: view, intents: intents.monitoring)
                            case "pipelines":
                                VStack(alignment: .leading, spacing: 0) {
                                    PipelinesTab(view: view, intents: intents.pipelines)
                                        .frame(maxHeight: .infinity, alignment: .top)
                                    if let error = view.error { ErrorLine(message: error) }
                                }
                            case "notifications":
                                InboxTab(view: view, intents: intents.notifications, tab: $tab, showTitle: false)
                            case "remote": RemoteTab(connection: connection, intents: intents.remote)
                            case "more": MoreScreen(tab: $tab, onForget: intents.forgetThisPhone, onAbout: intents.openAbout)
                            default: ProjectsScreen(view: view, intents: intents, tab: $tab)
                            }
                        }
                        .frame(maxHeight: .infinity, alignment: .top)
                        if let notice = view.notice {
                            NoticeBar(message: notice, onDismiss: intents.dismissNotice)
                        }
                    }
                    RunovaBottomBar(
                        tabs: deviceTabs, selected: moreSections.contains { $0.id == section } ? "more" : section
                    ) { tab = $0 }
                }
            }
        }
        .onAppear { intents.openSection(onShow) }
        .onChange(of: onShow) { intents.openSection($0) }
        .onDisappear { intents.openSection(nil) }
    }
}

private struct MoreScreen: View {
    @Binding var tab: String
    let onForget: () -> Void
    let onAbout: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(moreSections) { item in
                    Button {
                        tab = item.id
                    } label: {
                        RunovaListRow(title: item.title, detail: nil, icon: item.icon).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Button(action: onForget) {
                    RunovaListRow(title: "Forget this phone", detail: nil, icon: RunovaIcons.shield)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                RunovaListRow(title: "About Runova", icon: RunovaIcons.info, onTap: onAbout)
            }
            .padding(16)
        }
    }
}

private struct NoticeBar: View {
    let message: String
    let onDismiss: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onDismiss) {
            RunovaText(message, style: RunovaType.small, color: palette.foreground)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.secondary)
        }
        .buttonStyle(.plain)
    }
}

private struct DeviceTopBar: View {
    let connection: ConnectionView
    let intents: AppIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaTopBar(
            title: connection.systemName, subtitle: connection.safetyCode.map { "Safety code \($0)" },
            onBack: intents.disconnect
        ) {
            RunovaBadge(
                text: connection.direct == true ? "Direct" : "Relay",
                tone: connection.direct == true ? .primary : .warning, dot: true
            )
            .padding(.trailing, 8)
        }
    }
}

private struct ProjectsScreen: View {
    let view: AppView
    let intents: AppIntents
    @Binding var tab: String

    var body: some View {
        if view.projects.isEmpty && view.projectsLoading {
            LoadingRows()
        } else if view.projects.isEmpty {
            RunovaEmptyState(
                icon: RunovaIcons.folder, title: "No projects yet",
                detail: "Add one in Runova on this computer.")
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(view.projects, id: \.id) { project in
                        Button {
                            intents.selectProject(project.id)
                            tab = "clis"
                        } label: {
                            RunovaListRow(
                                title: project.name,
                                detail: project.tags.isEmpty ? nil : project.tags.joined(separator: ", "),
                                icon: RunovaIcons.folder
                            )
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

private func statusBadge(_ status: AgentState) -> RunovaBadge {
    switch status {
    case .needsInput: return RunovaBadge(text: "Needs input", tone: .warning, dot: true)
    case .working: return RunovaBadge(text: "Working", tone: .primary, dot: true)
    case .done: return RunovaBadge(text: "Done", tone: .success, dot: true)
    case .idle: return RunovaBadge(text: "Idle", dot: true)
    case .exited: return RunovaBadge(text: "Exited", dot: true)
    }
}

private func statusTone(_ status: AgentState?) -> BadgeTone {
    switch status {
    case .needsInput: return .warning
    case .working: return .primary
    case .done: return .success
    default: return .neutral
    }
}

private struct ErrorLine: View {
    let message: String

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaText(message, style: RunovaType.small, color: palette.destructive).padding(16)
    }
}

private struct ClisScreen: View {
    let view: AppView
    let intents: AppIntents

    private var chosen: ProjectView? { view.projects.first { $0.id == view.selectedProject } }

    private var shown: [TerminalItem] {
        guard let selected = view.selectedProject else { return view.terminals }
        return view.terminals.filter { $0.projectId == selected }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let project = chosen {
                RunovaChip(text: project.name, icon: RunovaIcons.folder, tone: .primary) { intents.selectProject(nil) }
                    .padding(.leading, 16)
                    .padding(.top, 12)
            }
            if shown.isEmpty && view.terminalsLoading {
                LoadingRows()
            } else if shown.isEmpty {
                RunovaEmptyState(
                    icon: RunovaIcons.terminal, title: "No CLIs running",
                    detail: "Start one in Runova on this computer and it shows up here.")
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(shown, id: \.sessionId) { item in
                            // The chip above already names the project.
                            TerminalRow(item: item, projects: chosen == nil ? view.projects : [], intents: intents)
                        }
                    }
                    .padding(16)
                }
            }
            if let error = view.error { ErrorLine(message: error) }
        }
    }
}

private struct TerminalRow: View {
    let item: TerminalItem
    let projects: [ProjectView]
    let intents: AppIntents

    var body: some View {
        Button {
            intents.openTerminal(item.sessionId)
        } label: {
            HStack(spacing: 12) {
                RunovaListRow(
                    title: item.title,
                    detail: projects.first { $0.id == item.projectId }?.name ?? item.cliId,
                    icon: item.status == nil ? RunovaIcons.terminal : RunovaIcons.agent,
                    iconTone: statusTone(item.status), flat: true)
                if let status = item.status { statusBadge(status) }
            }
            .padding(.trailing, 12)
            .rowCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct TerminalScreen: View {
    let terminal: TerminalView
    let processes: [TerminalProcessView]
    let error: String?
    let intents: AppIntents

    @State private var showProcesses = false
    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(
            title: terminal.title, onBack: intents.closeTerminal,
            trailing: {
                RunovaChip(
                    text: showProcesses ? "Screen" : "Processes",
                    icon: showProcesses ? RunovaIcons.terminal : RunovaIcons.processes
                ) {
                    if !showProcesses { intents.loadProcesses(terminal.sessionId) }
                    showProcesses.toggle()
                }
                .padding(.trailing, 8)
            }
        ) {
            ZStack(alignment: .bottomTrailing) {
                if showProcesses {
                    ProcessList(processes: processes)
                } else {
                    TerminalBody(frame: terminal.frame, onScroll: intents.terminalScroll)
                    if terminal.scrolled {
                        RunovaChip(text: "Back to live", icon: RunovaIcons.pull, tone: .primary) {
                            intents.terminalScroll(backToLive)
                        }
                            .padding(12)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let error { ErrorLine(message: error) }
            if terminal.ended {
                RunovaText(terminal.endReason ?? "This terminal has ended.", color: palette.mutedForeground)
                    .padding(16)
            } else {
                TerminalInput(onInput: intents.terminalInput)
            }
        }
    }
}

private struct ProcessList: View {
    let processes: [TerminalProcessView]

    var body: some View {
        if processes.isEmpty {
            RunovaEmptyState(
                icon: RunovaIcons.processes, title: "No processes",
                detail: "Nothing is running in this terminal right now.")
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(processes.enumerated()), id: \.offset) { _, process in
                        RunovaListRow(
                            title: process.name,
                            detail: "\(process.cpuLabel) CPU, \(process.memoryLabel)",
                            icon: RunovaIcons.cpu)
                    }
                }
                .padding(16)
            }
        }
    }
}

private struct TerminalInput: View {
    let onInput: (String) -> Void

    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(terminalKeys, id: \.label) { key in
                        RunovaChip(text: key.label, icon: key.icon) { onInput(key.data) }
                    }
                }
            }
            HStack(spacing: 8) {
                RunovaTextField(value: $text, placeholder: "Type a command", icon: RunovaIcons.terminal)
                RunovaButton(text: "Send", icon: RunovaIcons.send) {
                    onInput(text + "\r")
                    text = ""
                }
            }
        }
        .padding(8)
    }
}

private func color(_ value: UInt32?, fallback: Color) -> Color {
    value.map { Color(hex: $0) } ?? fallback
}

private func attributed(_ line: LineView, size: CGFloat) -> AttributedString {
    let theme = RunovaTokens.terminal
    var result = AttributedString()
    for run in line.runs {
        var part = AttributedString(run.text)
        var ink = color(run.fg, fallback: theme.foreground)
        var fill: Color? = run.bg.map { Color(hex: $0) }
        if run.inverse {
            let swapped = fill ?? theme.background
            fill = ink
            ink = swapped
        }
        if run.cursor {
            fill = theme.cursor
            ink = theme.background
        }
        part.foregroundColor = ink
        if let fill { part.backgroundColor = fill }
        part.font = Font.custom("JetBrainsMono-Regular", fixedSize: size)
            .weight(run.bold ? .bold : .regular)
            .italic(run.italic)
        if run.underline { part.underlineStyle = .single }
        result += part
    }
    return result
}

/// Fits the computer's screen to the phone. The computer's own size is never changed.
private struct TerminalBody: View {
    let frame: FrameView
    let onScroll: (Int32) -> Void

    @State private var dragged: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            if frame.rows > 0 {
                let fit = (geometry.size.width - 12) / (CGFloat(frame.cols) * cellWidthEm)
                let cell = min(max(fit, smallestCell), largestCell)
                let lineHeight = cell * lineHeightEm
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(frame.lines.enumerated()), id: \.offset) { _, line in
                            Text(attributed(line, size: cell))
                                .lineLimit(1)
                                .fixedSize()
                                .frame(height: lineHeight, alignment: .leading)
                        }
                    }
                    .padding(6)
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 4).onChanged { change in
                        let lines = Int32((change.translation.height - dragged) / lineHeight)
                        if lines != 0 {
                            dragged += CGFloat(lines) * lineHeight
                            onScroll(lines)
                        }
                    }
                    .onEnded { _ in dragged = 0 }
                )
            }
        }
        .background(RunovaTokens.terminal.background)
        .clipped()
    }
}
