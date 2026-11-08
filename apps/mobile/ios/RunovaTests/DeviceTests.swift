import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `DeviceTest.kt` and `GitTest.kt`, for the comparison with Android.
@MainActor
final class DeviceTests: XCTestCase {
    private let connected = ConnectionView(
        systemId: 1, systemName: "Sam's desk", phase: .connected, safetyCode: "483921", direct: true, error: nil)
    private let emptyGit = GitScreen(
        state: nil, loading: false, diff: nil, branchesOpen: false, branches: [], stashes: [])

    private func view(
        terminals: [TerminalItem] = [], terminal: TerminalView? = nil, processes: [TerminalProcessView] = [],
        git: GitScreen? = nil, selected: String? = "p1", confirm: ConfirmView? = nil
    ) -> AppView {
        fixtureView(
            connection: connected, selected: selected, terminals: terminals, terminal: terminal,
            processes: processes, git: git ?? emptyGit, confirm: confirm)
    }

    private func run(_ text: String, fg: UInt32? = nil, cursor: Bool = false) -> RunView {
        RunView(text: text, fg: fg, bg: nil, bold: false, italic: false, underline: false, inverse: false, cursor: cursor)
    }

    private var frame: FrameView {
        FrameView(
            cols: 40, rows: 4, cursor: CursorView(row: 2, col: 2),
            lines: [
                LineView(runs: [run("~/website")]),
                LineView(runs: [run("build ", fg: 0x7FD962), run("passed in 4s")]),
                LineView(runs: [run("$ "), run(" ", cursor: true)]),
                LineView(runs: []),
            ])
    }

    private func terminal(scrolled: Bool = false, ended: Bool = false, reason: String? = nil) -> TerminalView {
        TerminalView(
            sessionId: "t1", title: "Claude", frame: frame, scrolled: scrolled, ended: ended, endReason: reason)
    }

    private func file(_ path: String, _ group: GitGroup, conflict: String? = nil) -> GitFileView {
        GitFileView(
            path: path, origPath: nil, group: group, status: "M", conflict: conflict, additions: 3, deletions: 1,
            binary: false)
    }

    private var state: GitStateView {
        GitStateView(
            isRepo: true, branch: "master", detached: false, upstream: "origin/master", ahead: 1, behind: 2,
            hasRemote: true, operation: nil,
            files: [
                file("conflict.ts", .conflict, conflict: "UU"), file("staged.ts", .staged),
                file("changed.ts", .unstaged), file("new.ts", .untracked),
            ], truncated: false)
    }

    func testClis() throws {
        let items = [
            TerminalItem(
                sessionId: "t1", title: "Claude", projectId: "p1", cliId: "claude", status: .needsInput, createdAt: 5),
            TerminalItem(sessionId: "t2", title: "Terminal", projectId: nil, cliId: nil, status: nil, createdAt: 6),
        ]
        try renderSnapshot(view(terminals: items, selected: nil), "clis", tab: "clis")
    }

    func testTerminal() throws { try renderSnapshot(view(terminal: terminal()), "terminal", tab: "clis") }

    func testTerminalHistory() throws {
        try renderSnapshot(view(terminal: terminal(scrolled: true)), "terminal-history", tab: "clis")
    }

    func testTerminalEnded() throws {
        try renderSnapshot(
            view(terminal: terminal(ended: true, reason: "That terminal has closed.")), "terminal-ended", tab: "clis")
    }

    func testGit() throws {
        let git = GitScreen(state: state, loading: false, diff: nil, branchesOpen: false, branches: [], stashes: [])
        try renderSnapshot(view(git: git), "git", tab: "git")
    }

    func testGitDiff() throws {
        let lines = [
            DiffLineView(kind: .hunk, text: "@@ -1,2 +1,2 @@"),
            DiffLineView(kind: .context, text: "same"),
            DiffLineView(kind: .removed, text: "old line"),
            DiffLineView(kind: .added, text: "new line"),
        ]
        let diff = GitDiffView(
            path: "changed.ts", group: .unstaged, loading: false, binary: false, tooLarge: false, lines: lines)
        let git = GitScreen(state: state, loading: false, diff: diff, branchesOpen: false, branches: [], stashes: [])
        try renderSnapshot(view(git: git), "git-diff", tab: "git")
    }

    func testGitBranches() throws {
        let git = GitScreen(
            state: state, loading: false, diff: nil, branchesOpen: true,
            branches: [
                GitBranchView(name: "master", current: true, local: true),
                GitBranchView(name: "dev", current: false, local: true),
            ],
            stashes: [GitStashView(reference: "stash@{0}", message: "WIP on master")])
        try renderSnapshot(view(git: git), "git-branches", tab: "git")
    }

    func testStatus() throws {
        let system = SystemStatsView(
            cpuPercent: 12.5, cpuLabel: "12.5%", cpuDetail: "Ryzen 9, 16 cores", memPercent: 50,
            memLabel: "8 GB of 16 GB", netDownLabel: "1.5 MB/s", netUpLabel: "2 KB/s")
        let window = LimitWindowView(
            label: "5 hours", percent: 25, percentLabel: "25%", resetsLabel: "Resets in 3h 12m")
        let status = StatusScreen(
            system: system, loading: false,
            limits: [
                LimitChipView(
                    providerId: "claude-code", name: "Claude", plan: "Max", state: .ok, windows: [window], problem: nil)
            ],
            providers: [], detail: nil)
        try renderSnapshot(fixtureView(connection: connected, status: status), "status", tab: "status")
    }

    private var vaultEntry: VaultEntryView {
        VaultEntryView(
            id: "e1", title: "GitHub", subtitle: "sam", favorite: true, editable: true,
            secrets: [
                VaultSecretField(key: "password", label: "Password", custom: false),
                VaultSecretField(key: "f1", label: "PIN", custom: true),
            ])
    }

    private func vaultScreen(_ state: VaultLockState, open: String? = nil) -> VaultScreen {
        VaultScreen(
            state: state, loading: false, onShow: true, unlockError: nil,
            entries: state == .unlocked ? [vaultEntry] : [], openEntry: open, biometric: nil, revealed: nil)
    }

    func testVaultLocked() throws {
        try renderSnapshot(
            fixtureView(connection: connected, vault: vaultScreen(.locked)), "vault-locked", tab: "vault")
    }

    func testVault() throws {
        try renderSnapshot(fixtureView(connection: connected, vault: vaultScreen(.unlocked)), "vault", tab: "vault")
    }

    func testVaultEntry() throws {
        try renderSnapshot(
            fixtureView(connection: connected, vault: vaultScreen(.unlocked, open: "e1")), "vault-entry", tab: "vault")
    }

    func testMore() throws {
        try renderSnapshot(fixtureView(connection: connected), "more", tab: "more")
    }

    func testDeploy() throws {
        let deploy = DeployScreen(
            servers: [
                DeployServerView(
                    id: "srv1", name: "Prod", host: "10.0.0.1", stateLabel: "Online", online: true, problem: nil),
                DeployServerView(
                    id: "srv2", name: "Lab", host: "10.0.0.2", stateLabel: "Needs sign-in", online: false, problem: nil),
            ], loading: false, server: nil, logs: nil)
        try renderSnapshot(fixtureView(connection: connected, deploy: deploy), "deploy", tab: "deploy")
    }

    func testMonitoring() throws {
        let cloud = MonitorView(
            id: "m1", name: "Shop", source: .cloud, state: .down, detail: "Timed out", latencyLabel: nil,
            uptimeLabel: "90.0%", paused: false, canCheck: false, canPause: true, samples: [])
        let monitoring = MonitoringScreen(local: [], cloud: [cloud], loading: false, localNote: nil, open: nil)
        try renderSnapshot(fixtureView(connection: connected, monitoring: monitoring), "monitoring", tab: "monitoring")
    }

    func testPipelines() throws {
        let run = PipelineRunView(
            id: 100, title: "Fix it", branch: "master", number: 12, state: .running, stateLabel: "Running",
            canCancel: true)
        let status = PipelinesStatusView(
            problem: nil, workflows: [WorkflowView(id: 7, name: "CI", canDispatch: true, run: run)])
        let pipelines = PipelinesScreen(status: status, loading: false, run: nil, log: nil)
        try renderSnapshot(
            fixtureView(connection: connected, selected: "p1", pipelines: pipelines), "pipelines", tab: "pipelines")
    }

    func testAccount() throws {
        let account = AccountScreen(
            profile: ProfileView(name: "Sam", email: "sam@example.com", twoFactor: true), loading: false,
            sessions: [
                SessionView(id: 4, title: "Pixel", detail: "Runova app, android", current: true),
                SessionView(id: 9, title: "Sam's desk", detail: "Runova desktop app, windows", current: false),
            ],
            activity: [ActivityView(id: 1, action: "signed in", detail: "Pixel")],
            teams: [TeamView(id: 3, name: "Acme", role: "Owner", memberCount: 2)],
            invitations: [MyInvitationView(id: 7, team: "Beta", role: "Member", invitedBy: "Lee")],
            team: nil, stepUp: nil)
        try renderSnapshot(fixtureView(account: account), "account", tab: "account")
    }

    func testInbox() throws {
        let screen = NotificationsScreen(
            items: [
                NotificationItemView(
                    id: 1, title: "Deploy failed on prod", body: "", category: "deploys", destination: .inbox,
                    read: false)
            ],
            unread: 1, loading: false, preferences: [], settingsOpen: false, banner: nil)
        try renderSnapshot(fixtureView(notifications: screen), "inbox", tab: "inbox")
    }

    func testConfirm() throws {
        let question = ConfirmView(
            title: "Discard these changes?", detail: "a.ts goes back.", action: "Discard", danger: true)
        try renderSnapshot(view(confirm: question), "confirm", tab: "git")
    }
}

/// One place to build what the core publishes, so a new screen changes only this function.
func fixtureView(
    auth: AuthState = .signedIn, systems: [SystemView] = [], connection: ConnectionView? = nil,
    projects: [ProjectView] = [], selected: String? = nil, terminals: [TerminalItem] = [],
    terminal: TerminalView? = nil, processes: [TerminalProcessView] = [],
    git: GitScreen = GitScreen(state: nil, loading: false, diff: nil, branchesOpen: false, branches: [], stashes: []),
    status: StatusScreen = StatusScreen(system: nil, loading: false, limits: [], providers: [], detail: nil),
    vault: VaultScreen = VaultScreen(
        state: .unknown, loading: false, onShow: false, unlockError: nil, entries: [], openEntry: nil, biometric: nil,
        revealed: nil),
    deploy: DeployScreen = DeployScreen(servers: [], loading: false, server: nil, logs: nil),
    monitoring: MonitoringScreen = MonitoringScreen(local: [], cloud: [], loading: false, localNote: nil, open: nil),
    pipelines: PipelinesScreen = PipelinesScreen(status: nil, loading: false, run: nil, log: nil),
    account: AccountScreen = AccountScreen(
        profile: nil, loading: false, sessions: [], activity: [], teams: [], invitations: [], team: nil, stepUp: nil),
    notifications: NotificationsScreen = NotificationsScreen(
        items: [], unread: 0, loading: false, preferences: [], settingsOpen: false, banner: nil),
    notice: String? = nil, confirm: ConfirmView? = nil, error: String? = nil
) -> AppView {
    AppView(
        auth: auth, hubConnected: true, systems: systems, systemsLoading: false, connection: connection,
        projects: projects, projectsLoading: false, selectedProject: selected, terminals: terminals,
        terminalsLoading: false, terminal: terminal, terminalProcesses: processes, git: git, status: status, vault: vault, deploy: deploy,
        monitoring: monitoring, pipelines: pipelines, account: account,
        notifications: notifications,
        busy: false, notice: notice, confirm: confirm, error: error)
}

/// Draws a state at a phone's size and writes it where the comparison with Android looks.
@MainActor
func renderSnapshot(_ view: AppView, _ name: String, tab: String = "systems", dark: Bool = true) throws {
    let root = RunovaTheme(dark: dark) {
        AppRoot(view: view, tab: .constant(tab), intents: AppIntents())
    }
    let controller = UIHostingController(rootView: root.ignoresSafeArea())
    let bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
    let window = UIWindow(frame: bounds)
    window.rootViewController = controller
    window.isHidden = false
    controller.view.frame = bounds
    controller.view.layoutIfNeeded()
    let format = UIGraphicsImageRendererFormat()
    format.scale = 3
    let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
        controller.view.drawHierarchy(in: bounds, afterScreenUpdates: true)
    }
    let folder = ProcessInfo.processInfo.environment["SNAPSHOT_OUTPUT"] ?? NSTemporaryDirectory()
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    try XCTUnwrap(image.pngData())
        .write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
}
