import SwiftUI
import UIKit

private struct RunovaMotionKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// Off in tests, so a screenshot is always the finished picture.
    var runovaMotion: Bool {
        get { self[RunovaMotionKey.self] }
        set { self[RunovaMotionKey.self] = newValue }
    }
}

/// One of the files in the shared brand folder.
func brandImage(_ name: String, _ ext: String) -> UIImage? {
    Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "brand")
        .flatMap { UIImage(contentsOfFile: $0.path) }
}

/// The app's mark, in the version drawn for this theme.
struct RunovaLogo: View {
    let size: CGFloat

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if let image = brandImage(scheme == .dark ? "runova_logo" : "runova_logo_light", "png") {
                Image(uiImage: image).resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Runova")
    }
}

/// Lifts a piece of a page into place each time the page comes round.
private struct Rise: ViewModifier {
    let active: Bool
    let delay: Double

    @Environment(\.runovaMotion) private var allowed
    @Environment(\.accessibilityReduceMotion) private var reduced
    @State private var shown = false

    private var motion: Bool { allowed && !reduced }
    private var visible: Bool { !motion || shown }

    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 16)
            .onAppear { update(active) }
            .onChange(of: active) { update($0) }
    }

    private func update(_ on: Bool) {
        guard motion else { return }
        if on {
            withAnimation(.easeOut(duration: 0.52).delay(delay)) { shown = true }
        } else {
            shown = false
        }
    }
}

private extension View {
    func rise(_ active: Bool, _ delay: Double) -> some View {
        modifier(Rise(active: active, delay: delay))
    }
}

/// True while animations should play.
private struct MotionReader<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content

    @Environment(\.runovaMotion) private var allowed
    @Environment(\.accessibilityReduceMotion) private var reduced

    var body: some View { content(allowed && !reduced) }
}

/// A soft light behind the page, in the app's accent.
private struct Aurora: View {
    let motion: Bool

    @Environment(\.palette) private var palette
    @State private var drift = false

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let height = geometry.size.height
            let across = drift || !motion ? 1.0 : 0.0
            ZStack {
                RadialGradient(
                    colors: [palette.primary.opacity(0.26), .clear], center: .center, startRadius: 0,
                    endRadius: width * 0.95
                )
                .frame(width: width * 1.9, height: width * 1.9)
                .position(x: width * (0.22 + 0.5 * across), y: height * 0.2)
                RadialGradient(
                    colors: [palette.primary.opacity(0.1), .clear], center: .center, startRadius: 0,
                    endRadius: width * 0.8
                )
                .frame(width: width * 1.6, height: width * 1.6)
                .position(x: width * (0.9 - 0.5 * across), y: height * 0.56)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .onAppear {
            guard motion else { return }
            withAnimation(.easeInOut(duration: 7).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

/// What fills the screen while the app gets going.
struct RunovaSplash: View {
    @State private var lit = false

    var body: some View {
        MotionReader { motion in
            ZStack {
                Aurora(motion: motion)
                VStack(spacing: 12) {
                    RunovaLogo(size: 132)
                        .scaleEffect(lit || !motion ? 1 : 0.94)
                        .opacity(lit || !motion ? 1 : 0.65)
                    RunovaText("Runova", style: RunovaType.heading)
                }
            }
            .onAppear {
                guard motion else { return }
                withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { lit = true }
            }
        }
    }
}

private struct IntroPage {
    let title: String
    let detail: String
}

private let introPages = [
    IntroPage(
        title: "Every computer, in your pocket",
        detail: "See which of your machines are online and step into any of them, from anywhere."),
    IntroPage(
        title: "Your agents, one tap away",
        detail: "Follow Claude Code, Codex and your shells as they run, and answer the moment one needs you."),
    IntroPage(
        title: "Ship from wherever you are",
        detail:
            "Review a diff, commit, restart a container or rerun a pipeline. When something breaks, your phone hears first."),
    IntroPage(
        title: "Private by design",
        detail:
            "Your phone connects straight to your computer whenever it can, and anything relayed stays end-to-end encrypted."),
]

/// The welcome a new install opens on. Always dark, because the art is lit from behind.
struct IntroScreen: View {
    let onDone: () -> Void
    var startPage = 0

    var body: some View {
        RunovaTheme(dark: true) {
            IntroBody(onDone: onDone, page: startPage)
        }
    }
}

private struct IntroBody: View {
    let onDone: () -> Void
    @State var page: Int

    @Environment(\.palette) private var palette

    private var last: Bool { page == introPages.count - 1 }

    var body: some View {
        MotionReader { motion in
            ZStack {
                palette.background.ignoresSafeArea()
                Aurora(motion: motion)
                VStack(spacing: 0) {
                    HStack(spacing: 6) {
                        RunovaLogo(size: 30)
                        RunovaText("Runova", style: RunovaType.labelStrong)
                        Spacer(minLength: 0)
                        if !last { RunovaChip(text: "Skip", action: onDone) }
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 60)
                    TabView(selection: $page) {
                        ForEach(introPages.indices, id: \.self) { index in
                            pageView(index, motion: motion).tag(index)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    PageDots(current: page, count: introPages.count)
                    RunovaButton(text: last ? "Get started" : "Next", icon: RunovaIcons.forward) {
                        if last {
                            onDone()
                        } else {
                            withAnimation(motion ? .easeInOut(duration: 0.3) : nil) { page += 1 }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                }
            }
        }
    }

    private func pageView(_ index: Int, motion: Bool) -> some View {
        let active = index == page
        return VStack(spacing: 0) {
            Group {
                switch index {
                case 0: DevicesArt(active: active, motion: motion)
                case 1: TerminalArt(active: active, motion: motion)
                case 2: ShipArt(active: active, motion: motion)
                default: PrivateArt(active: active, motion: motion)
                }
            }
            .padding(.horizontal, 28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityHidden(true)
            RunovaText(introPages[index].title, style: RunovaType.heading, alignment: .center)
                .padding(.horizontal, 28)
            Spacer().frame(height: 10)
            RunovaText(introPages[index].detail, color: palette.mutedForeground, alignment: .center)
                .padding(.horizontal, 32)
                .frame(minHeight: 72, alignment: .top)
        }
    }
}

private struct PageDots: View {
    let current: Int
    let count: Int

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == current ? palette.primary : palette.foreground.opacity(0.2))
                    .frame(width: index == current ? 24 : 6, height: 6)
                    .animation(.easeInOut(duration: 0.26), value: current)
            }
        }
        .padding(.vertical, 18)
        .accessibilityHidden(true)
    }
}

private struct ArtRow: View {
    let icon: String
    let tone: BadgeTone
    let title: String
    let detail: String
    let badge: String
    let badgeTone: BadgeTone

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            RunovaIconTile(icon: icon, tone: tone, size: 36)
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(title, style: RunovaType.labelStrong, maxLines: 1)
                RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
            }
            Spacer(minLength: 0)
            RunovaBadge(text: badge, tone: badgeTone, dot: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .runovaGlass()
    }
}

private struct DevicesArt: View {
    let active: Bool
    let motion: Bool

    @State private var up = false

    var body: some View {
        VStack(spacing: 10) {
            RunovaLogo(size: 136)
                .offset(y: motion ? (up ? -5 : 5) : 5)
                .padding(.bottom, 8)
                .onAppear {
                    guard motion else { return }
                    withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) { up = true }
                }
            ArtRow(
                icon: RunovaIcons.systems, tone: .primary, title: "Studio PC", detail: "Windows, 3 agents running",
                badge: "Online", badgeTone: .success
            )
            .rise(active, 0.12)
            ArtRow(
                icon: RunovaIcons.systems, tone: .primary, title: "MacBook Pro", detail: "macOS", badge: "Online",
                badgeTone: .success
            )
            .padding(.horizontal, 10)
            .rise(active, 0.24)
            ArtRow(
                icon: RunovaIcons.server, tone: .neutral, title: "Build server", detail: "Linux", badge: "Offline",
                badgeTone: .neutral
            )
            .padding(.horizontal, 20)
            .rise(active, 0.36)
        }
    }
}

private let terminalLines: [(text: String, strong: Bool)] = [
    ("> Fix the login redirect", true),
    ("Reading auth/session.ts", false),
    ("Edited 2 files", false),
    ("All 243 tests passed", true),
]

private struct TerminalArt: View {
    let active: Bool
    let motion: Bool

    @State private var shown = terminalLines.count
    @Environment(\.palette) private var palette

    private var asking: Bool { shown == terminalLines.count }

    var body: some View {
        let theme = RunovaTokens.terminal
        let shape = RoundedRectangle(cornerRadius: 18)
        VStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Circle().fill(palette.destructive).frame(width: 9, height: 9)
                    Circle().fill(palette.warning).frame(width: 9, height: 9)
                    Circle().fill(palette.primary).frame(width: 9, height: 9)
                    RunovaText("claude", style: RunovaType.small, color: palette.mutedForeground)
                        .padding(.leading, 8)
                    Spacer(minLength: 0)
                    RunovaBadge(text: asking ? "Needs input" : "Working", tone: asking ? .warning : .primary, dot: true)
                }
                .padding(.bottom, 4)
                ForEach(terminalLines.indices, id: \.self) { index in
                    RunovaText(
                        terminalLines[index].text, style: RunovaType.mono,
                        color: terminalLines[index].strong ? theme.foreground : palette.mutedForeground, maxLines: 1
                    )
                    .opacity(index < shown ? 1 : 0)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(theme.background))
            .overlay(shape.strokeBorder(palette.foreground.opacity(0.12), lineWidth: 1))
            ArtRow(
                icon: RunovaIcons.agent, tone: .warning, title: "Apply this change?", detail: "Claude Code is waiting",
                badge: "Yes", badgeTone: .primary
            )
            .opacity(asking ? 1 : 0)
        }
        .task(id: active) {
            guard active && motion else {
                shown = terminalLines.count
                return
            }
            while !Task.isCancelled {
                shown = 0
                for line in 1...terminalLines.count {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    withAnimation(.easeOut(duration: 0.22)) { shown = line }
                }
                try? await Task.sleep(nanoseconds: 2_800_000_000)
            }
        }
    }
}

private struct ShipArt: View {
    let active: Bool
    let motion: Bool

    @State private var done = 2
    @Environment(\.palette) private var palette

    private var percent: Int { min(done * 32 + 4, 100) }

    var body: some View {
        VStack(spacing: 12) {
            VStack(spacing: 16) {
                HStack(spacing: 8) {
                    RunovaIconTile(icon: RunovaIcons.git, size: 30)
                    RunovaText("main", style: RunovaType.labelStrong)
                    Spacer(minLength: 0)
                    RunovaText("2 commits ahead", style: RunovaType.small, color: palette.mutedForeground)
                }
                HStack(alignment: .top, spacing: 0) {
                    PipelineStep(label: "Build", index: 0, done: done)
                    PipelineLink(on: done > 0)
                    PipelineStep(label: "Test", index: 1, done: done)
                    PipelineLink(on: done > 1)
                    PipelineStep(label: "Deploy", index: 2, done: done)
                }
                VStack(spacing: 6) {
                    HStack {
                        RunovaText("Deploying to production", style: RunovaType.small, color: palette.mutedForeground)
                        Spacer(minLength: 0)
                        RunovaText("\(percent)%", style: RunovaType.small)
                    }
                    RunovaProgress(percent: Double(percent))
                }
            }
            .padding(16)
            .runovaGlass()
            ArtRow(
                icon: RunovaIcons.deploy, tone: .success, title: "web-1", detail: "Restarted just now", badge: "Running",
                badgeTone: .success
            )
            .rise(active, 0.2)
        }
        .task(id: active) {
            guard active && motion else {
                done = 2
                return
            }
            while !Task.isCancelled {
                for (step, wait) in [(0, 900), (1, 900), (2, 1400), (3, 2600)] {
                    withAnimation(.easeInOut(duration: 0.5)) { done = step }
                    try? await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000)
                }
            }
        }
    }
}

private struct PipelineStep: View {
    let label: String
    let index: Int
    let done: Int

    @Environment(\.palette) private var palette

    private var finished: Bool { index < done }
    private var running: Bool { index == done }

    var body: some View {
        VStack(spacing: 6) {
            RunovaIconTile(
                icon: finished ? RunovaIcons.check : running ? RunovaIcons.bolt : RunovaIcons.clock,
                tone: finished ? .success : running ? .primary : .neutral, size: 44)
            RunovaText(label, style: RunovaType.caption, color: palette.mutedForeground)
        }
    }
}

private struct PipelineLink: View {
    let on: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        Capsule()
            .fill(on ? palette.primary : palette.foreground.opacity(0.12))
            .frame(height: 2)
            .padding(.horizontal, 6)
            .padding(.top, 21)
            .frame(maxWidth: .infinity)
    }
}

private struct PrivateArt: View {
    let active: Bool
    let motion: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            RunovaHeroIcon(icon: RunovaIcons.shield)
            Spacer().frame(height: 32)
            HStack(spacing: 0) {
                RunovaIconTile(icon: RunovaIcons.mobile, size: 68)
                FlowLine(motion: motion).frame(height: 24).padding(.horizontal, 10)
                RunovaIconTile(icon: RunovaIcons.systems, size: 68)
            }
            Spacer().frame(height: 24)
            HStack(spacing: 8) {
                RunovaBadge(text: "Direct", tone: .primary, dot: true)
                RunovaBadge(text: "End-to-end encrypted", tone: .success, dot: true)
            }
            .rise(active, 0.16)
        }
    }
}

/// Dots travelling along a dashed line, from the phone to the computer.
private struct FlowLine: View {
    let motion: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        if motion {
            TimelineView(.animation) { timeline in
                let seconds = timeline.date.timeIntervalSinceReferenceDate
                line(travel: seconds.truncatingRemainder(dividingBy: 1.8) / 1.8)
            }
        } else {
            line(travel: 0.3)
        }
    }

    private func line(travel: Double) -> some View {
        Canvas { context, size in
            let middle = size.height / 2
            var path = Path()
            path.move(to: CGPoint(x: 0, y: middle))
            path.addLine(to: CGPoint(x: size.width, y: middle))
            context.stroke(
                path, with: .color(palette.foreground.opacity(0.22)),
                style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 7]))
            for index in 0..<3 {
                let place = (travel + Double(index) / 3).truncatingRemainder(dividingBy: 1)
                let x = size.width * place
                context.fill(
                    Path(ellipseIn: CGRect(x: x - 4, y: middle - 4, width: 8, height: 8)),
                    with: .color(palette.primary))
            }
        }
    }
}
