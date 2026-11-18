import QuickLook
import SwiftUI

/// What files sent to the phone can ask for (E114). Opening and sharing are drawn in the view.
struct ReceiveIntents {
    var answer: (String, Bool) -> Void = { _, _ in }
    var cancel: (String) -> Void = { _ in }
    var dismiss: (String) -> Void = { _ in }
    var clear: () -> Void = {}
    var setEnabled: (Bool) -> Void = { _ in }
    var setAutoAccept: (Bool) -> Void = { _ in }
}

private let receiveLive: Set<ReceivePhase> = [.connecting, .asking, .receiving, .reconnecting]

/// The runway speaks in send phases; a receive reads the same way.
private func runwayPhase(_ phase: ReceivePhase) -> SendPhase {
    switch phase {
    case .connecting: return .connecting
    case .asking: return .waiting
    case .receiving: return .sending
    case .reconnecting: return .reconnecting
    case .done: return .done
    case .declined: return .declined
    case .cancelled: return .cancelled
    case .failed: return .failed
    }
}

/// Files on their way to this phone, waiting for a yes or a no, over whatever is on show. Saying
/// nothing for a minute turns them away on its own.
struct IncomingOfferSheet: View {
    let offer: IncomingOfferView
    let intents: ReceiveIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 24)
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 14) {
                    RunovaHeroIcon(icon: RunovaIcons.pull)
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(offer.title, style: RunovaType.title)
                        RunovaText(
                            "From \(offer.person) · \(offer.sizeLabel)", style: RunovaType.small,
                            color: palette.mutedForeground)
                    }
                }
                if let note = offer.note {
                    RunovaText("“\(note)”", color: palette.mutedForeground, maxLines: 4).italic()
                }
                RunovaCard(padding: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(offer.files.prefix(4).enumerated()), id: \.offset) { _, file in
                            let kind = sendKind(file.name)
                            HStack(spacing: 10) {
                                RunovaIconTile(icon: kind.icon, tone: kind.tone, size: 28)
                                VStack(alignment: .leading, spacing: 0) {
                                    RunovaText(file.name, style: RunovaType.smallMedium, maxLines: 1)
                                    RunovaText(
                                        [file.folder, file.sizeLabel].compactMap { $0 }.joined(separator: " · "),
                                        style: RunovaType.caption, color: palette.mutedForeground, maxLines: 1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 6)
                        }
                        let more = offer.files.count - 4 + Int(offer.moreFiles)
                        if more > 0 {
                            RunovaText("And \(more) more", style: RunovaType.small, color: palette.mutedForeground)
                                .padding(.vertical, 6)
                        }
                    }
                }
                RunovaText(
                    "They go to Runova's Received folder on this phone, checked against the sender's copy.",
                    style: RunovaType.small, color: palette.mutedForeground)
                HStack(spacing: 8) {
                    RunovaButton(text: "Decline", kind: .soft) { intents.answer(offer.id, false) }
                        .frame(maxWidth: .infinity)
                    RunovaButton(text: "Accept", icon: RunovaIcons.check) { intents.answer(offer.id, true) }
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(20)
            .background(shape.fill(palette.background))
            .overlay(shape.strokeBorder(palette.primary.opacity(0.25), lineWidth: 1))
            .padding(12)
        }
    }
}

/// Received sends and the phone's own rules for them, at the end of the Send files screen.
struct ReceivedSection: View {
    let screen: ReceiveScreen
    let intents: ReceiveIntents

    @State private var preview: URL?
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !screen.batches.isEmpty {
                HStack {
                    RunovaSectionTitle(text: "Received")
                    Spacer(minLength: 0)
                    if screen.batches.contains(where: { !receiveLive.contains($0.phase) }) {
                        RunovaChip(text: "Clear received", action: intents.clear)
                    }
                }
                .padding(.top, 8)
                ForEach(screen.batches, id: \.id) { batch in
                    ReceivedCard(batch: batch, intents: intents) { preview = $0 }
                }
            }
            RunovaSectionTitle(text: "Receiving on this phone").padding(.top, 8)
            RunovaCard {
                VStack(alignment: .leading, spacing: 14) {
                    setting(
                        "Take files from my computers",
                        "While Runova is open, your own computers can send files here. You see each send before it comes in.",
                        on: screen.enabled, enabled: true, change: intents.setEnabled)
                    setting(
                        "Accept from my computers without asking",
                        "Files you send yourself from a computer come straight in.",
                        on: screen.autoAccept, enabled: screen.enabled, change: intents.setAutoAccept)
                    RunovaText(
                        "Only your own computers can send to this phone. Received files are also in the Files app, under Runova.",
                        style: RunovaType.caption, color: palette.mutedForeground)
                }
            }
        }
        .quickLookPreview($preview)
    }

    private func setting(_ title: String, _ detail: String, on: Bool, enabled: Bool, change: @escaping (Bool) -> Void)
        -> some View
    {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(title, style: RunovaType.labelStrong)
                RunovaText(detail, style: RunovaType.small, color: palette.mutedForeground)
            }
            Spacer(minLength: 0)
            RunovaToggle(isOn: on, label: title, enabled: enabled, onChange: change)
        }
    }
}

private struct ReceivedCard: View {
    let batch: ReceivedBatchView
    let intents: ReceiveIntents
    let open: (URL) -> Void

    @Environment(\.palette) private var palette

    private var tone: BadgeTone {
        switch batch.phase {
        case .done: return .success
        case .failed: return .danger
        case .declined, .cancelled: return .neutral
        default: return .primary
        }
    }

    private var ink: Color {
        switch batch.phase {
        case .done: return palette.success
        case .failed: return palette.destructive
        default: return palette.mutedForeground
        }
    }

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    RunovaIconTile(icon: batch.phase == .done ? RunovaIcons.check : RunovaIcons.pull, tone: tone)
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(batch.title, style: RunovaType.labelStrong, maxLines: 1)
                        RunovaText(batch.sizeLabel, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                    }
                    Spacer(minLength: 0)
                    if receiveLive.contains(batch.phase) {
                        RunovaText("\(batch.percent)%", style: RunovaType.labelStrong, color: palette.primary)
                    }
                }
                SendRunway(percent: Int(batch.percent), phase: runwayPhase(batch.phase))
                RunovaText(batch.status, style: RunovaType.small, color: ink)
                    .accessibilityAddTraits(.updatesFrequently)
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(batch.files, id: \.transferId) { line($0) }
                    if batch.moreFiles > 0 {
                        RunovaText("And \(batch.moreFiles) more", style: RunovaType.small, color: palette.mutedForeground)
                    }
                }
                HStack(spacing: 8) {
                    if batch.canCancel {
                        RunovaChip(text: "Stop", icon: RunovaIcons.close, tone: .danger) { intents.cancel(batch.id) }
                    }
                    if batch.canDismiss {
                        RunovaChip(text: "Dismiss") { intents.dismiss(batch.id) }
                    }
                }
            }
        }
    }

    private func line(_ file: ReceivedFileView) -> some View {
        let kind = sendKind(file.name)
        return HStack(spacing: 10) {
            RunovaIconTile(icon: kind.icon, tone: kind.tone, size: 28)
            VStack(alignment: .leading, spacing: 0) {
                RunovaText(file.name, style: RunovaType.smallMedium, maxLines: 1)
                RunovaText(
                    file.error ?? [file.folder, file.sizeLabel].compactMap { $0 }.joined(separator: " · "),
                    style: RunovaType.caption, color: file.error != nil ? palette.destructive : palette.mutedForeground,
                    maxLines: 2)
            }
            Spacer(minLength: 0)
            if file.state == .done, let path = file.path {
                let url = URL(fileURLWithPath: path)
                Button {
                    open(url)
                } label: {
                    RunovaIcon(glyph: RunovaIcons.external, size: 12, color: palette.foreground.opacity(0.85))
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(palette.foreground.opacity(0.05)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(file.name)")
                ShareLink(item: url) {
                    RunovaIcon(glyph: RunovaIcons.push, size: 12, color: palette.foreground.opacity(0.85))
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(palette.foreground.opacity(0.05)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Share \(file.name)")
            } else if file.state == .sending {
                RunovaText("\(file.percent)%", style: RunovaType.caption, color: palette.primary)
            } else if file.state == .failed {
                RunovaIcon(glyph: RunovaIcons.error, size: 14, color: palette.destructive, label: "Failed")
            }
        }
        .padding(.vertical, 2)
    }
}
