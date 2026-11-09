import SwiftUI

private struct GitToolsKey: EnvironmentKey {
    static let defaultValue = GitToolsScreen(tags: nil, ai: nil, resolving: nil)
}

extension EnvironmentValues {
    var gitTools: GitToolsScreen {
        get { self[GitToolsKey.self] }
        set { self[GitToolsKey.self] = newValue }
    }
}

/// The round button beside a field that asks the AI on the computer, and stops it.
struct AiButton: View {
    let loading: Bool
    let label: String
    let onAsk: () -> Void
    let onStop: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = loading ? palette.destructive : palette.primary
        Button(action: loading ? onStop : onAsk) {
            RunovaIcon(glyph: loading ? RunovaIcons.stop : RunovaIcons.sparkles, size: 15, color: ink)
                .frame(width: 44, height: 44)
                .background(Circle().fill(ink.opacity(0.13)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(loading ? "Stop" : label)
    }
}

/// What the AI said about a field, under it.
struct AiNote: View {
    let kind: GitAiKind

    @Environment(\.gitTools) private var tools
    @Environment(\.palette) private var palette

    var body: some View {
        if let ai = tools.ai, ai.kind == kind {
            if ai.loading {
                RunovaText("Asking the AI on this computer", style: RunovaType.small, color: palette.primary)
            } else if let error = ai.error {
                RunovaText(error, style: RunovaType.small, color: palette.destructive)
            } else if let note = ai.note {
                RunovaText(note, style: RunovaType.small, color: palette.mutedForeground)
            }
        }
    }
}

extension View {
    /// Takes an answer from the computer into a field, once.
    func takingAiAnswer(_ tools: GitToolsScreen, kind: GitAiKind, into text: Binding<String>, onTaken: @escaping () -> Void)
        -> some View
    {
        let answer = tools.ai?.kind == kind ? tools.ai?.text : nil
        return onChange(of: answer) { value in
            guard let value else { return }
            text.wrappedValue = value
            onTaken()
        }
    }
}

struct TagsScreen: View {
    let tags: GitTagsView
    let error: String?
    var version: GitVersionView?
    let intents: GitIntents

    @State private var tag = ""
    @State private var message = ""
    @State private var push: Bool?
    @State private var channel = "stable"
    @Environment(\.palette) private var palette

    private var pushing: Bool { push ?? tags.hasRemote }

    var body: some View {
        RunovaScreen(title: "Tag a version", onBack: intents.closeTags) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        RunovaSectionTitle(text: "Latest")
                        RunovaText(tags.latest ?? "No tags yet", style: RunovaType.mono)
                        if !tags.commitsLabel.isEmpty {
                            RunovaText(tags.commitsLabel, style: RunovaType.small, color: palette.mutedForeground)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .runovaGlass()
                    if !tags.channels.isEmpty {
                        RunovaSectionTitle(text: "Next").padding(.top, 4)
                        HStack(spacing: 6) {
                            ForEach(tags.channels, id: \.channel) { item in
                                RunovaChip(text: item.label, tone: item.channel == channel ? .primary : .soft) {
                                    channel = item.channel
                                }
                            }
                        }
                        HStack(spacing: 8) {
                            ForEach(tags.channels.first { $0.channel == channel }?.options ?? [], id: \.kind) { option in
                                BumpOption(kind: option.kind, tag: option.tag, on: option.tag == tag) { tag = option.tag }
                            }
                        }
                    }
                    RunovaButton(
                        text: tags.suggesting ? "Stop asking" : "Suggest with AI",
                        kind: tags.suggesting ? .danger : .tint,
                        icon: tags.suggesting ? RunovaIcons.stop : RunovaIcons.sparkles,
                        action: tags.suggesting ? intents.cancelAi : intents.suggestTag
                    )
                    .frame(maxWidth: .infinity)
                    if tags.suggesting {
                        RunovaText(
                            "The AI on this computer is reading the commits.", style: RunovaType.small, color: palette.primary)
                    }
                    if let suggestion = tags.suggestion {
                        HStack(alignment: .top, spacing: 10) {
                            RunovaIconTile(icon: RunovaIcons.sparkles, size: 30)
                            VStack(alignment: .leading, spacing: 0) {
                                if let reason = suggestion.reason { RunovaText(reason, style: RunovaType.label) }
                                RunovaText(suggestion.note, style: RunovaType.small, color: palette.mutedForeground)
                            }
                        }
                    }
                    if let problem = tags.error ?? error {
                        RunovaText(problem, style: RunovaType.small, color: palette.destructive)
                    }
                    RunovaTextField(value: $tag, placeholder: "Tag name", icon: RunovaIcons.tag)
                    RunovaTextArea(value: $message, placeholder: "Release notes (optional)", minHeight: 96)
                    if let version {
                        VersionCard(version: version, intents: intents)
                    } else if !tag.trimmingCharacters(in: .whitespaces).isEmpty {
                        RunovaChip(text: "Update the version in files", icon: RunovaIcons.sparkles) {
                            intents.applyVersion(tag.trimmingCharacters(in: .whitespaces))
                        }
                    }
                    if tags.hasRemote {
                        HStack {
                            VStack(alignment: .leading, spacing: 0) {
                                RunovaText("Push it", style: RunovaType.label)
                                RunovaText(
                                    "Sends the tag and the current branch to the remote.", style: RunovaType.small,
                                    color: palette.mutedForeground)
                            }
                            Spacer(minLength: 0)
                            RunovaToggle(isOn: pushing, label: "Push it") { push = $0 }
                        }
                    }
                    if !tags.recent.isEmpty {
                        RunovaSectionTitle(text: "Recent").padding(.top, 4)
                        ForEach(tags.recent, id: \.self) { recent in
                            HStack(spacing: 8) {
                                RunovaIcon(glyph: RunovaIcons.tag, size: 11, color: palette.mutedForeground)
                                RunovaText(recent, style: RunovaType.mono, color: palette.mutedForeground)
                                Spacer(minLength: 0)
                                RunovaChip(text: "Delete", icon: RunovaIcons.trash, tone: .danger) { intents.deleteTag(recent) }
                            }
                        }
                    }
                }
                .padding(16)
            }
            RunovaButton(
                text: pushing ? "Create and push" : "Create tag",
                enabled: !tag.trimmingCharacters(in: .whitespaces).isEmpty && !tags.suggesting,
                icon: RunovaIcons.tag
            ) { intents.createTag(tag.trimmingCharacters(in: .whitespaces), message, pushing) }
            .frame(maxWidth: .infinity)
            .padding(16)
        }
        .onChange(of: tags.suggestion) { suggestion in
            guard let suggestion else { return }
            tag = suggestion.tag
            message = suggestion.message
        }
    }
}

private struct BumpOption: View {
    let kind: String
    let tag: String
    let on: Bool
    let onPick: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14)
        Button(action: onPick) {
            VStack(spacing: 2) {
                RunovaText(kind, style: RunovaType.small, color: on ? palette.primary : palette.mutedForeground)
                RunovaText(tag, style: RunovaType.labelStrong, maxLines: 1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(shape.fill(on ? palette.primary.opacity(0.13) : palette.foreground.opacity(0.05)))
            .overlay(shape.strokeBorder(on ? palette.primary.opacity(0.45) : palette.foreground.opacity(0.08), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
    }
}

private struct VersionCard: View {
    let version: GitVersionView
    let intents: GitIntents

    @Environment(\.palette) private var palette

    private var heading: String {
        switch version.state {
        case .running: return "Updating to \(version.tag)"
        case .done: return "Updated to \(version.tag)"
        case .failed: return "That did not work"
        case .stopped: return "Stopped"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                RunovaIconTile(icon: version.state == .running ? RunovaIcons.sparkles : RunovaIcons.check, size: 30)
                RunovaText(heading, style: RunovaType.labelStrong)
                Spacer(minLength: 0)
                if version.state == .running {
                    RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger, action: intents.cancelVersion)
                } else {
                    RunovaChip(text: "Clear", icon: RunovaIcons.close, action: intents.closeVersion)
                }
            }
            ForEach(Array(version.lines.suffix(3).enumerated()), id: \.offset) { _, line in
                RunovaText(line, style: RunovaType.mono, color: palette.mutedForeground, maxLines: 1)
            }
            if let error = version.error { RunovaText(error, style: RunovaType.small, color: palette.destructive) }
            if let warning = version.warning { RunovaText(warning, style: RunovaType.small, color: palette.warning) }
            if version.committed {
                RunovaText("The CLI committed this itself.", style: RunovaType.small, color: palette.mutedForeground)
            }
            ForEach(version.files, id: \.path) { file in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(file.path, style: RunovaType.label, maxLines: 1)
                        RunovaText(file.detail, style: RunovaType.small, color: palette.mutedForeground)
                    }
                    Spacer(minLength: 0)
                    RunovaChip(text: file.kept ? "Undo" : "Redo") { intents.versionToggle(file.path) }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .runovaGlass()
    }
}

/// A branch's pull request, or the form to open one.
struct PrScreen: View {
    let pr: GitPrView
    let intents: GitIntents

    @State private var title = ""
    @State private var body_ = ""
    @State private var draft = false
    @State private var review = ""
    @Environment(\.palette) private var palette
    @Environment(\.openURL) private var openURL

    var body: some View {
        RunovaScreen(title: "Pull request", subtitle: pr.branchLabel.isEmpty ? nil : pr.branchLabel, onBack: intents.closePr) {
            if pr.loading {
                LoadingRows().frame(maxHeight: .infinity, alignment: .top)
            } else {
                ScrollView { content.padding(16) }
            }
        }
        .onChange(of: pr.suggestion) { suggestion in
            guard let suggestion else { return }
            title = suggestion.title
            body_ = suggestion.body
            intents.prSuggestionTaken()
        }
        .onChange(of: pr.review) { text in
            guard let text else { return }
            review = text
            intents.prReviewTaken()
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let note = pr.note { RunovaText(note, style: RunovaType.small, color: palette.warning) }
            if let error = pr.error { RunovaText(error, style: RunovaType.small, color: palette.destructive) }
            if let info = pr.pr { existing(info) }
            if pr.canCreate { form }
            if let link = pr.fallbackUrl, let url = URL(string: link) {
                RunovaChip(text: "Finish on GitHub", icon: RunovaIcons.external, tone: .primary) { openURL(url) }
            }
        }
    }

    @ViewBuilder private func existing(_ info: GitPrInfoView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                RunovaBadge(text: info.stateLabel, tone: .primary, dot: true)
                if let label = info.reviewLabel { RunovaBadge(text: label, tone: .success) }
                RunovaText("#\(info.number)", style: RunovaType.small, color: palette.mutedForeground)
            }
            RunovaText(info.title, style: RunovaType.title)
            RunovaText(info.meta, style: RunovaType.small, color: info.checksFailed ? palette.destructive : palette.mutedForeground)
            if let label = info.unresolvedLabel { RunovaText(label, style: RunovaType.small, color: palette.warning) }
            if let url = URL(string: info.url) {
                RunovaChip(text: "Open on GitHub", icon: RunovaIcons.external) { openURL(url) }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .runovaGlass()
        RunovaButton(
            text: pr.reviewing ? "Stop" : "Review with AI", kind: pr.reviewing ? .danger : .tint,
            icon: pr.reviewing ? RunovaIcons.stop : RunovaIcons.sparkles,
            action: pr.reviewing ? intents.cancelPrAi : intents.reviewPr
        )
        .frame(maxWidth: .infinity)
        if pr.reviewing {
            RunovaText("The AI on this computer is reading the changes.", style: RunovaType.small, color: palette.primary)
        }
        if !review.isEmpty {
            if let note = pr.reviewNote { RunovaText(note, style: RunovaType.small, color: palette.mutedForeground) }
            RunovaTextArea(value: $review, placeholder: "The review", minHeight: 160)
            RunovaButton(text: "Post as a comment", icon: RunovaIcons.send) { intents.postReview(review) }
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var form: some View {
        RunovaText("\(pr.branchLabel) into \(pr.base), \(pr.aheadLabel)", style: RunovaType.small, color: palette.mutedForeground)
        if pr.dirty {
            RunovaText("You have uncommitted changes that won't be included.", style: RunovaType.small, color: palette.warning)
        }
        RunovaButton(
            text: pr.suggesting ? "Stop" : "Write it with AI", kind: pr.suggesting ? .danger : .tint,
            icon: pr.suggesting ? RunovaIcons.stop : RunovaIcons.sparkles,
            action: pr.suggesting ? intents.cancelPrAi : intents.suggestPr
        )
        .frame(maxWidth: .infinity)
        RunovaTextField(value: $title, placeholder: "Title", icon: RunovaIcons.edit)
        RunovaTextArea(value: $body_, placeholder: "What changed and why", minHeight: 120)
        HStack {
            RunovaText("Open as a draft", style: RunovaType.label)
            Spacer(minLength: 0)
            RunovaToggle(isOn: draft, label: "Open as a draft") { draft = $0 }
        }
        RunovaButton(
            text: "Open pull request", enabled: !title.trimmingCharacters(in: .whitespaces).isEmpty && !pr.suggesting,
            icon: RunovaIcons.git
        ) { intents.createPr(title.trimmingCharacters(in: .whitespaces), body_, draft) }
        .frame(maxWidth: .infinity)
    }
}

/// The chip on a conflicted file: starts the AI, then shows it can be stopped.
struct FixConflictChip: View {
    let path: String
    let intents: GitIntents

    @Environment(\.gitTools) private var tools

    var body: some View {
        let working = tools.resolving == path
        RunovaChip(
            text: working ? "Stop" : "AI", icon: working ? RunovaIcons.stop : RunovaIcons.sparkles,
            tone: working ? .danger : .primary
        ) {
            if working { intents.cancelAi() } else { intents.resolveWithAi(path) }
        }
    }
}
