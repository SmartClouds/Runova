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
        AppView(
            auth: .signedIn, hubConnected: true, systems: [], systemsLoading: false, connection: connected,
            projects: [], projectsLoading: false, selectedProject: selected, terminals: terminals,
            terminalsLoading: false, terminal: terminal, terminalProcesses: processes, git: git ?? emptyGit,
            busy: false, notice: nil, confirm: confirm, error: nil)
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

    func testConfirm() throws {
        let question = ConfirmView(
            title: "Discard these changes?", detail: "a.ts goes back.", action: "Discard", danger: true)
        try renderSnapshot(view(confirm: question), "confirm", tab: "git")
    }
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
