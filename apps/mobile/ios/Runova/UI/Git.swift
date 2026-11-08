import SwiftUI

/// What the git screens can ask for.
struct GitIntents {
    var openDiff: (String, GitGroup) -> Void = { _, _ in }
    var closeDiff: () -> Void = {}
    var openBranches: () -> Void = {}
    var closeBranches: () -> Void = {}
    var stage: ([String]) -> Void = { _ in }
    var unstage: ([String]) -> Void = { _ in }
    var discard: (String, GitGroup) -> Void = { _, _ in }
    var commit: (String, Bool) -> Void = { _, _ in }
    var fetch: () -> Void = {}
    var pull: () -> Void = {}
    var push: () -> Void = {}
    var checkout: (String) -> Void = { _ in }
    var createBranch: (String) -> Void = { _ in }
    var deleteBranch: (String) -> Void = { _ in }
    var stashPush: (String?) -> Void = { _ in }
    var stashPop: (String) -> Void = { _ in }
    var stashDrop: (String) -> Void = { _ in }
    var resolve: (String, String) -> Void = { _, _ in }
    var abort: () -> Void = {}
}

private let groupTitles: [(group: GitGroup, title: String)] = [
    (.conflict, "Conflicts"),
    (.staged, "Staged"),
    (.unstaged, "Changes"),
    (.untracked, "Untracked"),
]

private func aheadBehind(_ state: GitStateView) -> String? {
    guard state.upstream != nil else { return nil }
    if state.ahead == 0 && state.behind == 0 { return "Up to date" }
    return "\(state.ahead) ahead, \(state.behind) behind"
}

private func changeDetail(_ file: GitFileView) -> String? {
    if file.conflict != nil { return "In conflict" }
    if file.binary { return "Binary file" }
    if file.additions != nil || file.deletions != nil {
        return "+\(file.additions ?? 0) -\(file.deletions ?? 0)"
    }
    return nil
}

struct GitChangesScreen: View {
    let view: AppView
    let intents: GitIntents

    var body: some View {
        if view.selectedProject == nil {
            RunovaEmptyState(
                icon: RunovaIcons.git, title: "Choose a project",
                detail: "Pick one in Projects to see its changes.")
        } else if let state = view.git.state {
            if state.isRepo {
                LoadedChanges(state: state, intents: intents)
            } else {
                RunovaEmptyState(
                    icon: RunovaIcons.git, title: "Not a git repository",
                    detail: "This project's folder isn't tracked by git.")
            }
        } else if view.git.loading {
            LoadingRows()
        } else {
            RunovaEmptyState(icon: RunovaIcons.git, title: "No changes to show", detail: "Nothing has loaded yet.")
        }
    }
}

private struct LoadedChanges: View {
    let state: GitStateView
    let intents: GitIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    BranchCard(state: state, intents: intents)
                    if let operation = state.operation {
                        HStack(spacing: 8) {
                            RunovaIcon(glyph: RunovaIcons.warning, size: 14, color: palette.warning)
                            RunovaText("A \(operation) is in progress")
                            Spacer(minLength: 0)
                            RunovaChip(text: "Stop", action: intents.abort)
                        }
                        .padding(.vertical, 8)
                    }
                    ForEach(groupTitles, id: \.title) { entry in
                        let files = state.files.filter { $0.group == entry.group }
                        if !files.isEmpty {
                            RunovaText(entry.title, style: RunovaType.caption, color: palette.mutedForeground)
                                .padding(.top, 12)
                                .padding(.bottom, 4)
                            ForEach(files, id: \.path) { FileRow(file: $0, intents: intents) }
                        }
                    }
                    if state.files.isEmpty {
                        RunovaText("Nothing to commit", color: palette.mutedForeground).padding(.top, 24)
                    }
                }
                .padding(16)
            }
            if state.files.contains(where: { $0.group == .staged }) {
                CommitBox(intents: intents)
            }
        }
    }
}

private struct BranchCard: View {
    let state: GitStateView
    let intents: GitIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    RunovaChip(text: state.branch ?? "Detached", action: intents.openBranches)
                    if let text = aheadBehind(state) {
                        RunovaText(text, style: RunovaType.small, color: palette.mutedForeground)
                    }
                }
                if state.hasRemote {
                    HStack(spacing: 6) {
                        RunovaChip(text: "Fetch", action: intents.fetch)
                        RunovaChip(text: "Pull", action: intents.pull)
                        RunovaChip(text: "Push", action: intents.push)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct FileRow: View {
    let file: GitFileView
    let intents: GitIntents

    var body: some View {
        HStack(spacing: 8) {
            if file.group == .conflict {
                RunovaListRow(title: file.path, detail: changeDetail(file), icon: RunovaIcons.folder)
            } else {
                Button {
                    intents.openDiff(file.path, file.group)
                } label: {
                    RunovaListRow(title: file.path, detail: changeDetail(file), icon: RunovaIcons.folder)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            switch file.group {
            case .conflict:
                RunovaChip(text: "Mine") { intents.resolve(file.path, "ours") }
                RunovaChip(text: "Theirs") { intents.resolve(file.path, "theirs") }
            case .staged:
                RunovaChip(text: "Unstage") { intents.unstage([file.path]) }
            case .unstaged:
                RunovaChip(text: "Stage") { intents.stage([file.path]) }
            case .untracked:
                RunovaChip(text: "Add") { intents.stage([file.path]) }
            }
        }
    }
}

private struct CommitBox: View {
    let intents: GitIntents

    @State private var message = ""

    private var blank: Bool { message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            RunovaTextField(value: $message, placeholder: "Commit message")
            HStack(spacing: 8) {
                RunovaButton(text: "Commit", kind: .soft, enabled: !blank) {
                    intents.commit(message, false)
                    message = ""
                }
                .frame(maxWidth: .infinity)
                RunovaButton(text: "Commit and push", enabled: !blank) {
                    intents.commit(message, true)
                    message = ""
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(8)
    }
}

struct DiffScreen: View {
    let diff: GitDiffView
    let intents: GitIntents

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: diff.path, onBack: intents.closeDiff)
            HStack(spacing: 6) {
                switch diff.group {
                case .staged:
                    RunovaChip(text: "Unstage") { intents.unstage([diff.path]) }
                case .unstaged, .untracked:
                    RunovaChip(text: "Stage") { intents.stage([diff.path]) }
                    RunovaChip(text: "Discard") { intents.discard(diff.path, diff.group) }
                case .conflict:
                    EmptyView()
                }
            }
            .padding(.leading, 16)
            .padding(.bottom, 8)
            if diff.loading {
                LoadingRows()
            } else if diff.tooLarge {
                RunovaEmptyState(
                    icon: RunovaIcons.warning, title: "Too large to show on a phone",
                    detail: "Open it in Runova on the computer.")
            } else if diff.binary {
                RunovaEmptyState(icon: RunovaIcons.warning, title: "Binary file", detail: "There's no text to compare.")
            } else if diff.lines.isEmpty {
                RunovaEmptyState(icon: RunovaIcons.check, title: "No differences", detail: "")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(diff.lines.enumerated()), id: \.offset) { _, line in
                            DiffLine(line: line)
                        }
                    }
                }
                .background(RunovaTokens.terminal.background)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct DiffLine: View {
    let line: DiffLineView

    private var colors: (fill: Color, ink: Color) {
        let theme = RunovaTokens.terminal
        switch line.kind {
        case .added: return (theme.green.opacity(0.16), theme.foreground)
        case .removed: return (theme.red.opacity(0.16), theme.foreground)
        case .hunk: return (.clear, theme.brightBlack)
        case .context: return (.clear, theme.foreground)
        }
    }

    var body: some View {
        RunovaText(line.text, style: RunovaType.mono, color: colors.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(colors.fill)
    }
}

struct BranchesScreen: View {
    let git: GitScreen
    let intents: GitIntents

    @State private var name = ""
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: "Branches", onBack: intents.closeBranches)
            HStack(spacing: 8) {
                RunovaTextField(value: $name, placeholder: "New branch name")
                RunovaButton(text: "Create", enabled: !name.isEmpty) {
                    intents.createBranch(name)
                    name = ""
                }
            }
            .padding(.horizontal, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(git.branches, id: \.name) { BranchRow(branch: $0, intents: intents) }
                    HStack {
                        RunovaText("Stashes", style: RunovaType.caption, color: palette.mutedForeground)
                        Spacer(minLength: 0)
                        RunovaChip(text: "Stash changes") { intents.stashPush(nil) }
                    }
                    .padding(.top, 16)
                    .padding(.bottom, 4)
                    ForEach(git.stashes, id: \.reference) { stash in
                        HStack(spacing: 6) {
                            RunovaListRow(title: stash.message, detail: stash.reference, icon: RunovaIcons.folder)
                            RunovaChip(text: "Pop") { intents.stashPop(stash.reference) }
                            RunovaChip(text: "Drop") { intents.stashDrop(stash.reference) }
                        }
                    }
                }
                .padding(16)
            }
        }
    }
}

private struct BranchRow: View {
    let branch: GitBranchView
    let intents: GitIntents

    var body: some View {
        HStack(spacing: 8) {
            if branch.current {
                RunovaListRow(title: branch.name, detail: nil, icon: RunovaIcons.git)
                RunovaBadge(text: "Current")
            } else {
                Button {
                    intents.checkout(branch.name)
                } label: {
                    RunovaListRow(
                        title: branch.name, detail: branch.local ? nil : "On the remote", icon: RunovaIcons.git
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if branch.local {
                    RunovaChip(text: "Delete") { intents.deleteBranch(branch.name) }
                }
            }
        }
    }
}

/// The one question asked before anything hard to undo.
struct ConfirmOverlay: View {
    let confirm: ConfirmView
    let onConfirm: () -> Void
    let onDismiss: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea().onTapGesture(perform: onDismiss)
            RunovaCard {
                VStack(alignment: .leading, spacing: 8) {
                    RunovaText(confirm.title, style: RunovaType.title)
                    RunovaText(confirm.detail, color: palette.mutedForeground)
                    HStack(spacing: 8) {
                        RunovaButton(text: "Cancel", kind: .soft, action: onDismiss).frame(maxWidth: .infinity)
                        RunovaButton(text: confirm.action, kind: confirm.danger ? .danger : .primary, action: onConfirm)
                            .frame(maxWidth: .infinity)
                    }
                    .padding(.top, 8)
                }
            }
            .padding(24)
        }
    }
}
