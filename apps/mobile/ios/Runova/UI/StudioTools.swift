import SwiftUI

private struct PickRow: View {
    let items: [(id: String, label: String)]
    let selected: String?
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.id) { item in
                    RunovaChip(text: item.label, tone: item.id == selected ? .primary : .soft) { onPick(item.id) }
                }
            }
        }
    }
}

struct NarrationCard: View {
    let narration: StudioNarrationView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                RunovaIconTile(icon: RunovaIcons.mic, tone: narration.running ? .primary : .danger, size: 34)
                RunovaText(
                    narration.label, style: RunovaType.labelStrong,
                    color: narration.running ? palette.foreground : palette.destructive)
                Spacer(minLength: 0)
                if narration.running {
                    RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger, action: intents.cancelSpeak)
                }
            }
            if let percent = narration.percent { RunovaProgress(percent: percent) }
        }
        .padding(14)
        .runovaGlass()
    }
}

struct DownloadCard: View {
    let download: StudioDownloadView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    private var detail: String {
        switch download.state {
        case .running: return "\(Int(download.percent))% of \(download.sizeLabel)"
        case .done: return "On this phone, \(download.sizeLabel)"
        case .failed: return download.error ?? ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                RunovaIconTile(
                    icon: download.state == .done
                        ? RunovaIcons.check : download.state == .failed ? RunovaIcons.warning : RunovaIcons.pull,
                    tone: download.state == .done ? .success : download.state == .failed ? .danger : .primary, size: 34)
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(
                        download.fileName.isEmpty ? "Getting the file" : download.fileName, style: RunovaType.labelStrong,
                        maxLines: 1)
                    RunovaText(
                        detail, style: RunovaType.small,
                        color: download.state == .failed ? palette.destructive : palette.mutedForeground, maxLines: 2)
                }
                Spacer(minLength: 0)
                if download.state == .running {
                    RunovaChip(text: "Stop", icon: RunovaIcons.stop, tone: .danger, action: intents.downloadStop)
                } else {
                    RunovaChip(text: "Clear", icon: RunovaIcons.close, action: intents.downloadDismiss)
                }
            }
            if download.state == .running { RunovaProgress(percent: download.percent) }
            if download.nonCommercial {
                RunovaText(
                    "It uses a voice licensed for non-commercial use only.", style: RunovaType.small, color: palette.warning)
            }
            if let path = download.path {
                RunovaButton(text: "Share or save", kind: .tint, icon: RunovaIcons.send) { intents.shareVideo(path) }
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(14)
        .runovaGlass()
    }
}

/// Pick an engine and a voice, see the price, then speak.
struct VoiceSheet: View {
    let voice: StudioVoiceView
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let engine = voice.engines.first { $0.id == voice.engine }
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.6).ignoresSafeArea().onTapGesture(perform: intents.closeVoice)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    RunovaIconTile(icon: RunovaIcons.mic, size: 38)
                    RunovaText("Give it a voice", style: RunovaType.heading)
                }
                RunovaSectionTitle(text: "Engine")
                PickRow(items: voice.engines.map { (id: $0.id, label: $0.label) }, selected: voice.engine, onPick: intents.pickEngine)
                if let problem = engine?.problem {
                    RunovaText(problem, style: RunovaType.small, color: palette.warning)
                }
                if !voice.voices.isEmpty {
                    RunovaSectionTitle(text: "Voice").padding(.top, 4)
                    PickRow(items: voice.voices.map { (id: $0.reference, label: $0.label) }, selected: voice.voice, onPick: intents.pickVoice)
                }
                if voice.voices.contains(where: { $0.reference == voice.voice && $0.nonCommercial }) {
                    RunovaText("This voice is for non-commercial use only.", style: RunovaType.small, color: palette.warning)
                }
                if let price = voice.priceLabel { RunovaText(price, style: RunovaType.label) }
                if let error = voice.error { RunovaText(error, style: RunovaType.small, color: palette.destructive) }
                RunovaButton(
                    text: voice.sceneCount == 1 ? "Speak 1 scene" : "Speak \(voice.sceneCount) scenes",
                    enabled: voice.priceLabel != nil, icon: RunovaIcons.mic, action: intents.speak
                )
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
            }
            .padding(20)
            .background(RoundedRectangle(cornerRadius: 24).fill(palette.popover).ignoresSafeArea(edges: .bottom))
        }
    }
}

private let gains: [(Double, String)] = [(0, "Mute"), (0.5, "50%"), (1, "100%"), (1.5, "150%")]
private let fades: [(Double, String)] = [(0, "None"), (0.5, "0.5s"), (1, "1s")]

struct StudioTimelineScreen: View {
    let timeline: StudioTimelineView
    let error: String?
    let intents: StudioIntents

    @State private var selected: String?
    @Environment(\.palette) private var palette

    private var clip: StudioClipView? { timeline.tracks.flatMap(\.clips).first { $0.id == selected } }

    var body: some View {
        RunovaScreen(
            title: "Timeline", subtitle: timeline.lengthLabel.isEmpty ? nil : timeline.lengthLabel,
            onBack: intents.closeTimeline
        ) {
            if timeline.loading {
                LoadingRows().frame(maxHeight: .infinity, alignment: .top)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let error { RunovaText(error, style: RunovaType.small, color: palette.destructive) }
                        ForEach(timeline.tracks, id: \.id) { track in
                            TrackCard(track: track, selected: selected, onSelect: { selected = $0 }, intents: intents)
                        }
                        if timeline.truncated {
                            RunovaText("Only the first clips are shown here.", style: RunovaType.small, color: palette.mutedForeground)
                        }
                        if !timeline.music.isEmpty {
                            RunovaSectionTitle(text: "Add music").padding(.top, 6)
                            ForEach(timeline.music, id: \.hash) { song in
                                HStack(spacing: 10) {
                                    RunovaIconTile(icon: RunovaIcons.playCircle, size: 32)
                                    RunovaText(song.name, style: RunovaType.label, maxLines: 1)
                                    Spacer(minLength: 0)
                                    RunovaText(song.detail, style: RunovaType.small, color: palette.mutedForeground)
                                    RunovaChip(text: "Add", icon: RunovaIcons.add) { intents.addMusic(song.hash) }
                                }
                                .padding(10)
                                .runovaGlass()
                            }
                        }
                    }
                    .padding(16)
                }
                if let clip { ClipPanel(clip: clip, intents: intents) { selected = nil } }
            }
        }
    }
}

private struct TrackCard: View {
    let track: StudioTrackView
    let selected: String?
    let onSelect: (String) -> Void
    let intents: StudioIntents

    @Environment(\.palette) private var palette

    private var lane: Color {
        switch track.kind {
        case "scene": return palette.primary
        case "voice": return palette.warning
        case "music", "sfx": return Color(red: 0.545, green: 0.361, blue: 0.965)
        default: return palette.foreground.opacity(0.5)
        }
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                RunovaText(track.name, style: RunovaType.labelStrong, maxLines: 1)
                Spacer(minLength: 0)
                if track.locked {
                    RunovaIcon(glyph: RunovaIcons.lock, size: 11, color: palette.mutedForeground)
                } else {
                    RunovaChip(text: track.muted ? "Muted" : "Mute", tone: track.muted ? .danger : .soft) {
                        intents.muteTrack(track.id, !track.muted)
                    }
                }
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    ForEach(track.clips, id: \.id) { clip in
                        let on = clip.id == selected
                        Button {
                            onSelect(clip.id)
                        } label: {
                            RunovaText(clip.label, style: RunovaType.caption, maxLines: 1)
                                .padding(.horizontal, 4)
                                .frame(
                                    width: max(geometry.size.width * clip.width - 2, 6), height: 28, alignment: .leading
                                )
                                .background(RoundedRectangle(cornerRadius: 5).fill(lane.opacity(on ? 0.9 : 0.35)))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 5).strokeBorder(on ? palette.foreground : .clear, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(track.locked)
                        .offset(x: geometry.size.width * clip.left + 1)
                    }
                }
                .frame(height: 34)
            }
            .frame(height: 34)
            .background(RoundedRectangle(cornerRadius: 8).fill(palette.foreground.opacity(0.05)))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(12)
        .runovaGlass()
    }
}

private struct ClipPanel: View {
    let clip: StudioClipView
    let intents: StudioIntents
    let onClose: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(clip.label, style: RunovaType.labelStrong, maxLines: 1)
                    RunovaText(clip.detail, style: RunovaType.small, color: palette.mutedForeground)
                }
                Spacer(minLength: 0)
                RunovaChip(text: "Delete", icon: RunovaIcons.trash, tone: .danger) { intents.removeClip(clip.id) }
                RunovaChip(text: "Done", action: onClose)
            }
            stepper("Move", { intents.nudge(clip.id, -1) }, { intents.nudge(clip.id, 1) })
            stepper("Trim start", { intents.trim(clip.id, false, -1) }, { intents.trim(clip.id, false, 1) })
            stepper("Trim end", { intents.trim(clip.id, true, -1) }, { intents.trim(clip.id, true, 1) })
            HStack(spacing: 0) {
                caption("Volume")
                PickRow(items: gains.map { (id: $0.1, label: $0.1) }, selected: gains.first { $0.0 == clip.gain }?.1) { label in
                    if let gain = gains.first(where: { $0.1 == label })?.0 { intents.gain(clip.id, gain) }
                }
            }
            HStack(spacing: 0) {
                caption("Fades")
                PickRow(items: fades.map { (id: $0.1, label: $0.1) }, selected: nil) { label in
                    if let fade = fades.first(where: { $0.1 == label })?.0 { intents.fades(clip.id, fade) }
                }
            }
        }
        .padding(12)
        .runovaGlass()
        .padding(12)
    }

    private func caption(_ text: String) -> some View {
        RunovaText(text, style: RunovaType.small, color: palette.mutedForeground).frame(width: 76, alignment: .leading)
    }

    private func stepper(_ label: String, _ less: @escaping () -> Void, _ more: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            caption(label)
            RunovaChip(text: "-1s", action: less)
            RunovaChip(text: "+1s", action: more)
        }
    }
}
