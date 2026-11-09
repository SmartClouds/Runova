import SwiftUI

/// What the git screens can ask for.
struct GitIntents {
    var openDiff: (String, GitGroup) -> Void = { _, _ in }
    var closeDiff: () -> Void = {}
    var openBranches: () -> Void = {}
    var closeBranches: () -> Void = {}
    var openTags: () -> Void = {}
    var closeTags: () -> Void = {}
    var suggestTag: () -> Void = {}
    var createTag: (String, String, Bool) -> Void = { _, _, _ in }
    var suggestCommit: () -> Void = {}
    var suggestBranch: () -> Void = {}
    var aiTaken: () -> Void = {}
    var cancelAi: () -> Void = {}
    var resolveWithAi: (String) -> Void = { _ in }
    var deleteTag: (String) -> Void = { _ in }
    var openPr: () -> Void = {}
    var closePr: () -> Void = {}
    var suggestPr: () -> Void = {}
    var prSuggestionTaken: () -> Void = {}
    var createPr: (String, String, Bool) -> Void = { _, _, _ in }
    var reviewPr: () -> Void = {}
    var prReviewTaken: () -> Void = {}
    var postReview: (String) -> Void = { _ in }
    var cancelPrAi: () -> Void = {}
    var applyVersion: (String) -> Void = { _ in }
    var cancelVersion: () -> Void = {}
    var versionToggle: (String) -> Void = { _ in }
    var closeVersion: () -> Void = {}
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

private func fileTone(_ group: GitGroup) -> BadgeTone {
    switch group {
    case .conflict: return .danger
    case .staged: return .success
    case .unstaged: return .warning
    case .untracked: return .primary
    }
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
                            RunovaIconTile(icon: RunovaIcons.warning, tone: .warning)
                            RunovaText("A \(operation) is in progress")
                            Spacer(minLength: 0)
                            RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger, action: intents.abort)
                        }
                        .padding(.vertical, 8)
                    }
                    ForEach(groupTitles, id: \.title) { entry in
                        let files = state.files.filter { $0.group == entry.group }
                        if !files.isEmpty {
                            RunovaSectionTitle(text: entry.title)
                                .padding(.top, 14)
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
                    RunovaChip(
                        text: state.branch ?? "Detached", icon: RunovaIcons.git, tone: .primary,
                        action: intents.openBranches)
                    if let text = aheadBehind(state) {
                        RunovaText(text, style: RunovaType.small, color: palette.mutedForeground)
                    }
                }
                if state.hasRemote {
                    HStack(spacing: 6) {
                        RunovaChip(text: "Fetch", icon: RunovaIcons.fetch, action: intents.fetch)
                        RunovaChip(text: "Pull", icon: RunovaIcons.pull, action: intents.pull)
                        RunovaChip(text: "Push", icon: RunovaIcons.push, action: intents.push)
                        RunovaChip(text: "Tags", icon: RunovaIcons.tag, action: intents.openTags)
                        RunovaChip(text: "Pull request", icon: RunovaIcons.git, action: intents.openPr)
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
                RunovaListRow(title: file.path, detail: changeDetail(file), icon: RunovaIcons.file, iconTone: fileTone(file.group), flat: true)
            } else {
                Button {
                    intents.openDiff(file.path, file.group)
                } label: {
                    RunovaListRow(title: file.path, detail: changeDetail(file), icon: RunovaIcons.file, iconTone: fileTone(file.group), flat: true)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            switch file.group {
            case .conflict:
                RunovaChip(text: "Mine") { intents.resolve(file.path, "ours") }
                RunovaChip(text: "Theirs") { intents.resolve(file.path, "theirs") }
                FixConflictChip(path: file.path, intents: intents)
            case .staged:
                RunovaChip(text: "Unstage", icon: RunovaIcons.minus) { intents.unstage([file.path]) }
            case .unstaged:
                RunovaChip(text: "Stage", icon: RunovaIcons.add) { intents.stage([file.path]) }
            case .untracked:
                RunovaChip(text: "Add", icon: RunovaIcons.add) { intents.stage([file.path]) }
            }
        }
        .padding(.trailing, 12)
        .rowCard()
    }
}

private struct CommitBox: View {
    let intents: GitIntents

    @State private var message = ""
    @Environment(\.gitTools) private var tools

    private var blank: Bool { message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                RunovaTextField(value: $message, placeholder: "Commit message", icon: RunovaIcons.commit)
                AiButton(
                    loading: tools.ai?.kind == .commit && tools.ai?.loading == true,
                    label: "Suggest a commit message", onAsk: intents.suggestCommit, onStop: intents.cancelAi)
            }
            AiNote(kind: .commit)
            HStack(spacing: 8) {
                RunovaButton(text: "Commit", kind: .soft, enabled: !blank, icon: RunovaIcons.commit) {
                    intents.commit(message, false)
                    message = ""
                }
                .frame(maxWidth: .infinity)
                RunovaButton(text: "Commit and push", enabled: !blank, icon: RunovaIcons.push) {
                    intents.commit(message, true)
                    message = ""
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(8)
        .takingAiAnswer(tools, kind: .commit, into: $message, onTaken: intents.aiTaken)
    }
}

struct DiffScreen: View {
    let diff: GitDiffView
    let intents: GitIntents

    var body: some View {
        RunovaScreen(title: diff.path, onBack: intents.closeDiff) {
            HStack(spacing: 6) {
                switch diff.group {
                case .staged:
                    RunovaChip(text: "Unstage", icon: RunovaIcons.minus) { intents.unstage([diff.path]) }
                case .unstaged, .untracked:
                    RunovaChip(text: "Stage", icon: RunovaIcons.add) { intents.stage([diff.path]) }
                    RunovaChip(text: "Discard", icon: RunovaIcons.eraser, tone: .danger) {
                        intents.discard(diff.path, diff.group)
                    }
                case .conflict:
                    EmptyView()
                }
            }
            .padding(.leading, 16)
            .padding(.top, 12)
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
    @Environment(\.gitTools) private var tools

    var body: some View {
        RunovaScreen(title: "Branches", onBack: intents.closeBranches) {
            HStack(spacing: 8) {
                RunovaTextField(value: $name, placeholder: "New branch name", icon: RunovaIcons.git)
                AiButton(
                    loading: tools.ai?.kind == .branch && tools.ai?.loading == true,
                    label: "Suggest a branch name", onAsk: intents.suggestBranch, onStop: intents.cancelAi)
                RunovaButton(text: "Create", enabled: !name.isEmpty, icon: RunovaIcons.add) {
                    intents.createBranch(name)
                    name = ""
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(git.branches, id: \.name) { BranchRow(branch: $0, intents: intents) }
                    HStack {
                        RunovaSectionTitle(text: "Stashes")
                        Spacer(minLength: 0)
                        RunovaChip(text: "Stash changes", icon: RunovaIcons.stash) { intents.stashPush(nil) }
                    }
                    .padding(.top, 16)
                    .padding(.bottom, 4)
                    ForEach(git.stashes, id: \.reference) { stash in
                        HStack(spacing: 6) {
                            RunovaListRow(title: stash.message, detail: stash.reference, icon: RunovaIcons.stash, flat: true)
                            RunovaChip(text: "Pop", icon: RunovaIcons.pull) { intents.stashPop(stash.reference) }
                            RunovaChip(text: "Drop", icon: RunovaIcons.trash, tone: .danger) {
                                intents.stashDrop(stash.reference)
                            }
                        }
                        .padding(.trailing, 12)
                        .rowCard()
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
                RunovaListRow(title: branch.name, detail: nil, icon: RunovaIcons.git, flat: true)
                RunovaBadge(text: "Current", tone: .primary, dot: true)
            } else {
                Button {
                    intents.checkout(branch.name)
                } label: {
                    RunovaListRow(
                        title: branch.name, detail: branch.local ? nil : "On the remote", icon: RunovaIcons.git
                    , flat: true)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if branch.local {
                    RunovaChip(text: "Delete", icon: RunovaIcons.trash, tone: .danger) {
                        intents.deleteBranch(branch.name)
                    }
                }
            }
        }
        .padding(.trailing, 12)
        .rowCard()
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
