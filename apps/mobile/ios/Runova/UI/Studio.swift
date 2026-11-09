import SwiftUI
import UIKit

struct StudioIntents {
    var openComposer: () -> Void = {}
    var closeComposer: () -> Void = {}
    var create: (String, String, String, UInt32, String?) -> Void = { _, _, _, _, _ in }
    var openVideo: (String) -> Void = { _ in }
    var closeVideo: () -> Void = {}
    var ask: (String) -> Void = { _ in }
    var applyProposal: () -> Void = {}
    var discardProposal: () -> Void = {}
    var undo: () -> Void = {}
    var animate: (String) -> Void = { _ in }
    var animateAll: () -> Void = {}
    var cancelRun: () -> Void = {}
    var openRender: () -> Void = {}
    var closeRender: () -> Void = {}
    var render: (String) -> Void = { _ in }
    var cancelRender: (String) -> Void = { _ in }
    var thumbnail: (String) -> Data? = { _ in nil }
}

/// A title always gets the same poster colour, so a library doesn't read as one grey list.
private func posterHue(_ title: String) -> Double {
    var hash = 0
    for unit in title.utf16 { hash = (hash * 31 + Int(unit)) & 0xFFFFFF }
    return Double(hash % 360)
}

private func ratioOf(_ aspect: String) -> CGFloat {
    let parts = aspect.split(separator: ":").compactMap { Double($0) }
    return parts.count == 2 && parts[1] > 0 ? CGFloat(parts[0] / parts[1]) : 16.0 / 9.0
}

private func colorOf(_ hex: String) -> Color {
    guard let value = UInt32(hex.replacingOccurrences(of: "#", with: ""), radix: 16) else { return .clear }
    return Color(
        red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255)
}

private func renderTone(_ state: StudioRenderState?) -> BadgeTone {
    switch state {
    case .done: return .success
    case .running: return .primary
    case .failed: return .danger
    case .queued: return .warning
    default: return .neutral
    }
}

struct StudioTab: View {
    let view: AppView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let screen = view.studio
        if let note = screen.note, screen.videos.isEmpty {
            RunovaEmptyState(icon: RunovaIcons.studio, title: "Studio is off", detail: note)
        } else if screen.videos.isEmpty && screen.loading {
            LoadingRows()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    StudioHero(onNew: intents.openComposer)
                    if screen.videos.isEmpty {
                        RunovaText("Your videos will show up here.", color: palette.mutedForeground, alignment: .center)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 28)
                    } else {
                        RunovaSectionTitle(text: "Your videos").padding(.top, 8)
                        ForEach(screen.videos, id: \.id) { StudioVideoRow(video: $0, intents: intents) }
                    }
                }
                .padding(16)
            }
        }
    }
}

/// A strip of film: the mark that makes these screens Studio's own.
private struct FilmStrip: View {
    let color: Color

    var body: some View {
        Canvas { context, size in
            var x: CGFloat = 3.5
            while x < size.width {
                context.fill(
                    Path(roundedRect: CGRect(x: x, y: 1, width: 7, height: size.height - 2), cornerRadius: 1.5),
                    with: .color(color))
                x += 14
            }
        }
        .frame(height: 8)
    }
}

private struct StudioHero: View {
    let onNew: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18)
        VStack(spacing: 0) {
            FilmStrip(color: palette.primary.opacity(0.22))
            VStack(alignment: .leading, spacing: 0) {
                RunovaIconTile(icon: RunovaIcons.studio, size: 44)
                Spacer().frame(height: 14)
                RunovaText("Make a video from a sentence", style: RunovaType.heading)
                Spacer().frame(height: 4)
                RunovaText(
                    "Describe it here. The AI on this computer writes the scenes, animates them and renders the film.",
                    style: RunovaType.small, color: palette.mutedForeground)
                Spacer().frame(height: 16)
                RunovaButton(text: "New video", icon: RunovaIcons.sparkles, action: onNew).frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            FilmStrip(color: palette.primary.opacity(0.22))
        }
        .padding(.vertical, 10)
        .background(
            shape.fill(
                LinearGradient(
                    colors: [palette.primary.opacity(0.24), palette.primary.opacity(0.04)], startPoint: .topLeading,
                    endPoint: .bottomTrailing))
        )
        .overlay(shape.strokeBorder(palette.primary.opacity(0.26), lineWidth: 1))
    }
}

private struct Poster: View {
    let title: String
    let width: CGFloat

    var body: some View {
        let hue = posterHue(title)
        RunovaIcon(glyph: RunovaIcons.studio, size: 18, color: Color.white.opacity(0.88))
            .frame(width: width, height: width * 9 / 16)
            .background(
                RoundedRectangle(cornerRadius: 10).fill(
                    LinearGradient(
                        colors: [
                            Color(hue: hue / 360, saturation: 0.62, brightness: 0.42),
                            Color(
                                hue: (hue + 48).truncatingRemainder(dividingBy: 360) / 360, saturation: 0.7, brightness: 0.2
                            ),
                        ], startPoint: .topLeading, endPoint: .bottomTrailing))
            )
    }
}

private struct StudioVideoRow: View {
    let video: StudioVideoItemView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        Button {
            intents.openVideo(video.id)
        } label: {
            HStack(spacing: 12) {
                Poster(title: video.title, width: 84)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        RunovaText(video.title, style: RunovaType.labelStrong, maxLines: 1)
                        if video.pinned { RunovaIcon(glyph: RunovaIcons.bolt, size: 10, color: palette.primary) }
                    }
                    RunovaText(
                        video.missing ? "The folder is missing" : video.detail, style: RunovaType.small,
                        color: video.missing ? palette.warning : palette.mutedForeground, maxLines: 1)
                    if let label = video.renderLabel {
                        RunovaBadge(text: label, tone: renderTone(video.renderState), dot: true).padding(.top, 4)
                    }
                }
                Spacer(minLength: 0)
                RunovaIcon(glyph: RunovaIcons.forward, size: 11, color: palette.mutedForeground.opacity(0.7))
            }
            .padding(10)
            .runovaGlass()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(video.missing)
    }
}

private let aspects = [("16:9", "Wide"), ("9:16", "Tall"), ("1:1", "Square"), ("4:5", "Post")]
private let lengths: [(UInt32, String)] = [(15, "15s"), (30, "30s"), (60, "1 min"), (120, "2 min")]

struct StudioComposerScreen: View {
    let composer: StudioComposerView
    let busy: Bool
    let error: String?
    let intents: StudioIntents

    @State private var brief = ""
    @State private var aspect = "16:9"
    @State private var seconds: UInt32 = 30
    @State private var style: String?
    @State private var language = "en"
    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: "New video", onBack: intents.closeComposer) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    PromptBox(value: $brief)
                    RunovaSectionTitle(text: "Shape").padding(.top, 8)
                    HStack(spacing: 8) {
                        ForEach(aspects, id: \.0) { value, label in
                            AspectOption(aspect: value, label: label, on: value == aspect) { aspect = value }
                        }
                    }
                    RunovaSectionTitle(text: "Length").padding(.top, 8)
                    HStack(spacing: 8) {
                        ForEach(lengths, id: \.0) { value, label in
                            RunovaChip(text: label, tone: value == seconds ? .primary : .soft) { seconds = value }
                                .frame(maxWidth: .infinity)
                        }
                    }
                    if !composer.styles.isEmpty {
                        RunovaSectionTitle(text: "Look").padding(.top, 8)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                StyleCard(label: "Let the AI pick", style: nil, on: style == nil) { style = nil }
                                ForEach(composer.styles, id: \.id) { option in
                                    StyleCard(label: option.name, style: option, on: style == option.id) { style = option.id }
                                }
                            }
                        }
                    }
                    if !composer.languages.isEmpty {
                        RunovaSectionTitle(text: "Language").padding(.top, 8)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(composer.languages, id: \.code) { option in
                                    RunovaChip(text: option.native, tone: option.code == language ? .primary : .soft) {
                                        language = option.code
                                    }
                                }
                            }
                        }
                    }
                    if let error { RunovaText(error, style: RunovaType.small, color: palette.destructive) }
                }
                .padding(16)
            }
            VStack(spacing: 8) {
                RunovaButton(
                    text: "Write the scenes",
                    enabled: !brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy,
                    icon: RunovaIcons.sparkles
                ) {
                    intents.create(
                        brief.trimmingCharacters(in: .whitespacesAndNewlines), aspect, language, seconds, style)
                }
                .frame(maxWidth: .infinity)
                RunovaText(
                    "Your AI CLI on this computer does the writing.", style: RunovaType.caption,
                    color: palette.mutedForeground, alignment: .center)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }
}

private struct PromptBox: View {
    @Binding var value: String

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                RunovaIcon(glyph: RunovaIcons.sparkles, size: 13, color: palette.primary)
                RunovaText("What's the video about?", style: RunovaType.labelStrong)
            }
            ZStack(alignment: .topLeading) {
                if value.isEmpty {
                    RunovaText(
                        "A 30 second launch film for our new app, upbeat, ending on the logo.",
                        color: palette.mutedForeground.opacity(0.7))
                }
                TextEditor(text: $value)
                    .font(RunovaType.body.font)
                    .foregroundColor(palette.foreground)
                    .tint(palette.primary)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 84)
                    .padding(.horizontal, -4)
                    .padding(.vertical, -8)
                    .accessibilityLabel("What the video is about")
            }
        }
        .padding(14)
        .background(shape.fill(palette.foreground.opacity(0.05)))
        .overlay(shape.strokeBorder(palette.primary.opacity(0.3), lineWidth: 1))
    }
}

private struct AspectOption: View {
    let aspect: String
    let label: String
    let on: Bool
    let onPick: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = on ? palette.primary : palette.mutedForeground
        let ratio = ratioOf(aspect)
        let shape = RoundedRectangle(cornerRadius: 14)
        Button(action: onPick) {
            VStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(ink, lineWidth: 1.5)
                    .frame(width: ratio >= 1 ? 38 : 38 * ratio, height: ratio >= 1 ? 38 / ratio : 38)
                    .frame(width: 38, height: 38)
                RunovaText(label, style: RunovaType.small, color: ink)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(shape.fill(on ? palette.primary.opacity(0.13) : palette.foreground.opacity(0.05)))
            .overlay(shape.strokeBorder(on ? palette.primary.opacity(0.45) : palette.foreground.opacity(0.08), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
    }
}

private struct StyleCard: View {
    let label: String
    let style: StudioStyleView?
    let on: Bool
    let onPick: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14)
        Button(action: onPick) {
            VStack(alignment: .leading, spacing: 8) {
                Group {
                    if let style {
                        HStack(spacing: 0) {
                            ForEach(style.colors, id: \.self) { colorOf($0).frame(maxWidth: .infinity) }
                        }
                    } else {
                        LinearGradient(
                            colors: [palette.primary.opacity(0.5), palette.primary.opacity(0.1)], startPoint: .leading,
                            endPoint: .trailing
                        )
                        .overlay(RunovaIcon(glyph: RunovaIcons.sparkles, size: 14, color: palette.foreground))
                    }
                }
                .frame(height: 34)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                RunovaText(label, style: RunovaType.small, color: on ? palette.primary : palette.foreground, maxLines: 1)
            }
            .padding(10)
            .frame(width: 118)
            .background(shape.fill(on ? palette.primary.opacity(0.13) : palette.foreground.opacity(0.05)))
            .overlay(shape.strokeBorder(on ? palette.primary.opacity(0.45) : palette.foreground.opacity(0.08), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
    }
}

struct StudioVideoScreen: View {
    let video: StudioVideoView
    let busy: Bool
    let error: String?
    let notice: String?
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            RunovaScreen(
                title: video.title.isEmpty ? "Video" : video.title, onBack: intents.closeVideo,
                trailing: {
                    if video.canUndo {
                        RunovaChip(text: "Undo", icon: RunovaIcons.undo, action: intents.undo).padding(.trailing, 8)
                    }
                }
            ) {
                if video.loading {
                    LoadingRows().frame(maxHeight: .infinity, alignment: .top)
                } else {
                    ScrollView { content.padding(16) }
                    if video.canAsk { AskBar(onAsk: intents.ask) }
                }
            }
            if let sheet = video.renderSheet { RenderSheet(sheet: sheet, intents: intents) }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            StepBar(steps: video.steps)
            if let problem = video.problem ?? error { ProblemCard(message: problem) }
            if let notice { RunovaText(notice, style: RunovaType.small, color: palette.primary) }
            if let run = video.run { RunCard(run: run, animatingAll: video.animatingAll, onStop: intents.cancelRun) }
            if let proposal = video.proposal { ProposalCard(proposal: proposal, intents: intents) }
            if let render = video.renders.first(where: { $0.canCancel || $0.state == .done }) {
                RenderCard(render: render, intents: intents)
            }
            actions
            if !video.scenes.isEmpty {
                RunovaSectionTitle(text: "Scenes").padding(.top, 6)
                ForEach(video.scenes, id: \.id) { SceneCard(scene: $0, aspect: video.aspect, intents: intents) }
            }
        }
    }

    @ViewBuilder private var actions: some View {
        if video.animateAllLabel != nil || video.canRender {
            HStack(spacing: 8) {
                if let animate = video.animateAllLabel {
                    RunovaButton(
                        text: animate, kind: .tint, enabled: !busy, icon: RunovaIcons.sparkles, action: intents.animateAll
                    )
                    .frame(maxWidth: .infinity)
                }
                if video.canRender {
                    RunovaButton(text: "Render", enabled: !busy, icon: RunovaIcons.video, action: intents.openRender)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

private struct StepBar: View {
    let steps: [StudioStepView]

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(steps.indices, id: \.self) { index in
                StepNode(number: index + 1, step: steps[index])
                if index < steps.count - 1 {
                    Capsule()
                        .fill(steps[index].state == .done ? palette.primary : palette.foreground.opacity(0.12))
                        .frame(height: 2)
                        .padding(.top, 13)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .runovaGlass()
    }
}

private struct StepNode: View {
    let number: Int
    let step: StudioStepView

    @Environment(\.palette) private var palette

    private var fill: Color {
        switch step.state {
        case .done: return palette.primary
        case .active: return palette.primary.opacity(0.16)
        case .todo: return palette.foreground.opacity(0.07)
        }
    }

    var body: some View {
        VStack(spacing: 3) {
            ZStack {
                Circle().fill(fill)
                if step.state == .active { Circle().strokeBorder(palette.primary, lineWidth: 1) }
                if step.state == .done {
                    RunovaIcon(glyph: RunovaIcons.check, size: 12, color: palette.primaryForeground)
                } else {
                    RunovaText(
                        String(number), style: RunovaType.caption,
                        color: step.state == .active ? palette.primary : palette.mutedForeground)
                }
            }
            .frame(width: 28, height: 28)
            RunovaText(step.label, style: RunovaType.labelStrong, maxLines: 1)
            RunovaText(step.detail, style: RunovaType.caption, color: palette.mutedForeground, maxLines: 1)
        }
        .frame(width: 76)
    }
}

private struct ProblemCard: View {
    let message: String

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RunovaIcon(glyph: RunovaIcons.warning, size: 14, color: palette.destructive)
            RunovaText(message, style: RunovaType.small, color: palette.destructive)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(palette.destructive.opacity(0.1)))
    }
}

private struct RunCard: View {
    let run: StudioRunView
    let animatingAll: Bool
    let onStop: () -> Void

    @Environment(\.palette) private var palette
    @Environment(\.runovaMotion) private var allowed
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var turned = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18)
        let theme = RunovaTokens.terminal
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                RunovaIcon(glyph: RunovaIcons.sparkles, size: 16, color: palette.primary)
                    .rotationEffect(.degrees(turned ? 360 : 0))
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(run.title, style: RunovaType.labelStrong, maxLines: 1)
                    RunovaText(
                        animatingAll ? "\(run.detail), then the next scene" : run.detail, style: RunovaType.small,
                        color: palette.mutedForeground, maxLines: 1)
                }
                Spacer(minLength: 0)
                RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger, action: onStop)
            }
            if !run.lines.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(run.lines.suffix(4).enumerated()), id: \.offset) { _, line in
                        RunovaText(line, style: RunovaType.mono, color: theme.foreground.opacity(0.82), maxLines: 1)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(theme.background))
            }
        }
        .padding(14)
        .background(shape.fill(palette.primary.opacity(0.08)))
        .overlay(shape.strokeBorder(palette.primary.opacity(0.35), lineWidth: 1))
        .onAppear {
            guard allowed && !reduced else { return }
            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { turned = true }
        }
    }
}

private struct ProposalCard: View {
    let proposal: StudioProposalView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                RunovaIconTile(icon: RunovaIcons.sparkles, size: 30)
                RunovaText(proposal.summary, style: RunovaType.labelStrong)
            }
            ForEach(Array(proposal.changes.enumerated()), id: \.offset) { _, change in
                VStack(alignment: .leading, spacing: 4) {
                    RunovaText(change.title, style: RunovaType.label)
                    ForEach(Array(change.fields.enumerated()), id: \.offset) { _, field in
                        RunovaSectionTitle(text: field.label)
                        RunovaText(field.before, style: RunovaType.small, color: palette.mutedForeground, maxLines: 3)
                            .strikethrough(true, color: palette.mutedForeground)
                        RunovaText(field.after, style: RunovaType.small, color: palette.primary, maxLines: 4)
                    }
                }
            }
            HStack(spacing: 8) {
                RunovaButton(text: "Discard", kind: .soft, icon: RunovaIcons.close, action: intents.discardProposal)
                    .frame(maxWidth: .infinity)
                RunovaButton(text: "Apply", icon: RunovaIcons.check, action: intents.applyProposal)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .runovaGlass()
    }
}

private struct RenderCard: View {
    let render: StudioRenderView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                RunovaIconTile(
                    icon: render.state == .done ? RunovaIcons.check : RunovaIcons.film, tone: renderTone(render.state),
                    size: 34)
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(render.fileName, style: RunovaType.labelStrong, maxLines: 1)
                    RunovaText(render.label, style: RunovaType.small, color: palette.mutedForeground, maxLines: 2)
                }
                Spacer(minLength: 0)
                if render.canCancel {
                    RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger) { intents.cancelRender(render.id) }
                }
            }
            if let percent = render.percent { RunovaProgress(percent: percent) }
        }
        .padding(14)
        .runovaGlass()
    }
}

private struct SceneCard: View {
    let scene: StudioSceneView
    let aspect: String
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    private var thumbnail: UIImage? {
        guard scene.thumbnailReady, let key = scene.thumbnail, let data = intents.thumbnail(key) else { return nil }
        return UIImage(data: data)
    }

    var body: some View {
        let ratio = ratioOf(aspect)
        let height: CGFloat = 78
        let shape = RoundedRectangle(cornerRadius: 10)
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .topLeading) {
                Group {
                    if let thumbnail {
                        Image(uiImage: thumbnail).resizable().scaledToFill()
                    } else {
                        RunovaIcon(
                            glyph: scene.animated ? RunovaIcons.playCircle : RunovaIcons.image, size: 18,
                            color: palette.mutedForeground.opacity(0.7)
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.foreground.opacity(scene.animated ? 0.08 : 0.05))
                    }
                }
                .frame(width: ratio >= 1 ? height * ratio : height * 0.75, height: height)
                .clipShape(shape)
                RunovaText(String(scene.number), style: RunovaType.caption, color: .white)
                    .padding(.horizontal, 6)
                    .background(Capsule().fill(Color.black.opacity(0.6)))
                    .padding(4)
            }
            .overlay(shape.strokeBorder(palette.foreground.opacity(0.1), lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    RunovaText(scene.title, style: RunovaType.labelStrong, maxLines: 1)
                    Spacer(minLength: 0)
                    RunovaText(scene.durationLabel, style: RunovaType.caption, color: palette.mutedForeground)
                }
                RunovaText(scene.narration, style: RunovaType.small, color: palette.mutedForeground, maxLines: 2)
                if !scene.animated && scene.canAnimate {
                    RunovaChip(text: "Animate", icon: RunovaIcons.sparkles, tone: .primary) { intents.animate(scene.id) }
                        .padding(.top, 2)
                }
            }
        }
        .padding(10)
        .runovaGlass()
    }
}

private struct AskBar: View {
    let onAsk: (String) -> Void

    @State private var text = ""
    @Environment(\.palette) private var palette

    private var blank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(spacing: 10) {
            RunovaIcon(glyph: RunovaIcons.sparkles, size: 13, color: palette.primary)
            ZStack(alignment: .leading) {
                if text.isEmpty {
                    RunovaText("Ask AI to change something", color: palette.mutedForeground.opacity(0.75), maxLines: 1)
                }
                TextField("", text: $text)
                    .font(RunovaType.body.font)
                    .foregroundColor(palette.foreground)
                    .tint(palette.primary)
                    .accessibilityLabel("Ask AI to change something")
            }
            Button {
                onAsk(text.trimmingCharacters(in: .whitespacesAndNewlines))
                text = ""
            } label: {
                RunovaIcon(
                    glyph: RunovaIcons.send, size: 13, color: blank ? palette.mutedForeground : palette.primaryForeground
                )
                .frame(width: 36, height: 36)
                .background(Circle().fill(blank ? palette.foreground.opacity(0.08) : palette.primary))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(blank)
            .accessibilityLabel("Send")
            .padding(.vertical, 5)
        }
        .padding(.leading, 16)
        .padding(.trailing, 5)
        .background(Capsule().fill(palette.foreground.opacity(0.06)))
        .overlay(Capsule().strokeBorder(palette.primary.opacity(0.28), lineWidth: 1))
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }
}

private let qualities = [("draft", "Draft"), ("standard", "Standard"), ("high", "High"), ("master", "Master")]

private struct RenderSheet: View {
    let sheet: StudioRenderSheetView
    let intents: StudioIntents

    @State private var quality: String?
    @Environment(\.palette) private var palette

    private var picked: String { quality ?? sheet.quality }

    var body: some View {
        let shape = UnevenCorners(radius: 24)
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.6).ignoresSafeArea().onTapGesture(perform: intents.closeRender)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    RunovaIconTile(icon: RunovaIcons.video, size: 38)
                    RunovaText("Render this video", style: RunovaType.heading)
                }
                RunovaSectionTitle(text: "Quality")
                HStack(spacing: 6) {
                    ForEach(qualities, id: \.0) { value, label in
                        RunovaChip(text: label, tone: value == picked ? .primary : .soft) { quality = value }
                            .frame(maxWidth: .infinity)
                    }
                }
                if sheet.loading {
                    RunovaText("Working out the size", style: RunovaType.small, color: palette.mutedForeground)
                } else if let summary = sheet.summary {
                    RunovaText("At \(sheet.quality): \(summary)", style: RunovaType.small, color: palette.mutedForeground)
                }
                ForEach(sheet.warnings, id: \.self) {
                    RunovaText($0, style: RunovaType.small, color: palette.warning)
                }
                ForEach(sheet.problems, id: \.self) {
                    RunovaText($0, style: RunovaType.small, color: palette.destructive)
                }
                RunovaButton(
                    text: "Render on this computer", enabled: !sheet.loading && sheet.problems.isEmpty,
                    icon: RunovaIcons.video
                ) { intents.render(picked) }
                .frame(maxWidth: .infinity)
                RunovaText(
                    "The file stays on this computer. You'll get a notification when it's done.",
                    style: RunovaType.caption, color: palette.mutedForeground, alignment: .center
                )
                .frame(maxWidth: .infinity)
            }
            .padding(20)
            .background(shape.fill(palette.popover).ignoresSafeArea(edges: .bottom))
            .overlay(shape.stroke(palette.foreground.opacity(0.1), lineWidth: 1))
        }
    }
}

/// Round at the top only. iOS 16 has no ready-made shape for this.
private struct UnevenCorners: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(
            UIBezierPath(
                roundedRect: rect, byRoundingCorners: [.topLeft, .topRight],
                cornerRadii: CGSize(width: radius, height: radius)
            ).cgPath)
    }
}
