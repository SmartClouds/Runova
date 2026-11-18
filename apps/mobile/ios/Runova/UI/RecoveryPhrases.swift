import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// What the recovery phrases screen can ask for (E108). Copy and save are done by the app model.
struct PhraseIntents {
    var scan: (String) -> Void = { _ in }
    var reveal: (String) -> Void = { _ in }
    var hide: () -> Void = {}
    var delete: (String) -> Void = { _ in }
    var deleteAnswer: (Bool) -> Void = { _ in }
    var unlockVault: (String) -> Void = { _ in }
    /// Puts the words on the pasteboard for this device only, cleared after a minute.
    var copy: (String) -> Void = { _ in }
    /// Offers the numbered words as a text file to save or share.
    var save: (_ fileName: String, _ text: String) -> Void = { _, _ in }
}

/// Recovery phrases scanned from a computer, from the Account tab.
struct RecoveryPhrasesView: View {
    let screen: RecoveryPhrasesScreen
    let intents: PhraseIntents
    let onClose: () -> Void

    @State private var scanning = false

    var body: some View {
        ZStack {
            if scanning {
                QrScanScreen(
                    onCode: {
                        scanning = false
                        intents.scan($0)
                    },
                    onCancel: { scanning = false })
            } else if let revealed = screen.revealed {
                RevealedPhrase(phrase: revealed, intents: intents)
            } else {
                PhraseList(screen: screen, intents: intents, onClose: onClose) { scanning = true }
            }
            if let id = screen.confirmDelete {
                ConfirmDelete(
                    label: screen.items.first { $0.id == id }?.label ?? "this phrase",
                    answer: intents.deleteAnswer)
            }
        }
    }
}

private struct PhraseList: View {
    let screen: RecoveryPhrasesScreen
    let intents: PhraseIntents
    let onClose: () -> Void
    let onScan: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: "Recovery phrases", onBack: onClose) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    RunovaText(
                        "When Runova on a computer makes a recovery phrase, it shows a QR code. "
                            + "Scan it here and the phone keeps the words behind its own lock.",
                        color: palette.mutedForeground)
                    RunovaButton(text: "Scan a phrase", icon: RunovaIcons.qrCode, action: onScan)
                    if let notice = screen.notice {
                        RunovaText(notice, style: RunovaType.small, color: palette.primary)
                    }
                    if let error = screen.error {
                        RunovaText(error, style: RunovaType.small, color: palette.destructive)
                    }
                    if screen.items.isEmpty {
                        RunovaEmptyState(
                            icon: RunovaIcons.key, title: "No phrases yet", detail: "Phrases you scan show up here.")
                    }
                    ForEach(screen.items, id: \.id) { item in
                        HStack(spacing: 8) {
                            Button { intents.reveal(item.id) } label: {
                                RunovaListRow(
                                    title: item.label, detail: "\(item.opens) · \(item.saved)",
                                    icon: RunovaIcons.key, flat: true)
                            }
                            .buttonStyle(.plain)
                            Button { intents.delete(item.id) } label: {
                                RunovaIcon(
                                    glyph: RunovaIcons.trash, color: palette.mutedForeground,
                                    label: "Delete \(item.label)")
                                    .frame(width: 40, height: 40)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.trailing, 8)
                        .rowCard()
                    }
                }
                .padding(16)
            }
        }
    }
}

private struct RevealedPhrase: View {
    let phrase: RevealedPhraseView
    let intents: PhraseIntents

    @State private var showQr = false
    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: phrase.label, subtitle: "Recovery phrase", onBack: intents.hide) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    RunovaText(
                        "Anyone who sees these words can open what they protect. "
                            + "The screen is covered in the app switcher.",
                        style: RunovaType.small, color: palette.warning)
                    RunovaCard {
                        if showQr {
                            PhraseQr(payload: phrase.qrPayload).frame(maxWidth: .infinity)
                        } else {
                            WordGrid(words: phrase.words)
                        }
                    }
                    HStack(spacing: 8) {
                        RunovaButton(text: "Copy", kind: .soft, icon: RunovaIcons.copy) {
                            intents.copy(phrase.words.joined(separator: " "))
                        }
                        RunovaButton(text: "Save to a file", kind: .soft, icon: RunovaIcons.file) {
                            intents.save(phrase.fileName, phraseFileText(phrase))
                        }
                    }
                    RunovaButton(
                        text: showQr ? "Show the words" : "Show the QR code", kind: .soft,
                        icon: showQr ? RunovaIcons.show : RunovaIcons.qrCode
                    ) { showQr.toggle() }
                    if phrase.canUnlockVault {
                        RunovaButton(text: "Unlock the Vault on the computer", kind: .tint, icon: RunovaIcons.unlock) {
                            intents.unlockVault(phrase.id)
                        }
                    }
                    RunovaButton(text: "Hide", kind: .ghost, icon: RunovaIcons.hide, action: intents.hide)
                }
                .padding(16)
            }
        }
    }
}

/// The 24 words in three numbered columns, read along the rows as on the computer.
struct WordGrid: View {
    let words: [String]

    @Environment(\.palette) private var palette

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                HStack(spacing: 6) {
                    RunovaText("\(index + 1)", style: RunovaType.caption, color: palette.mutedForeground)
                        .frame(width: 18, alignment: .leading)
                    Text(word).font(.system(.callout, design: .monospaced).weight(.medium))
                        .foregroundStyle(palette.foreground)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8).padding(.vertical, 7)
                .background(palette.foreground.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Word \(index + 1), \(word)")
            }
        }
    }
}

private struct PhraseQr: View {
    let payload: String

    var body: some View {
        if let image = qrImage(payload) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .frame(width: 220, height: 220)
                .padding(10)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 14))
                .accessibilityLabel("QR code of the recovery phrase")
        }
    }
}

/// The phrase as a QR code, drawn on the phone so the words never leave it to be drawn.
func qrImage(_ payload: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(payload.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
        let image = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return UIImage(cgImage: image)
}

/// The saved file: what it is, the numbered words and a warning, as the computer writes it.
func phraseFileText(_ phrase: RevealedPhraseView) -> String {
    var lines = ["Runova recovery phrase", "", "Name: \(phrase.label)", ""]
    for row in stride(from: 0, to: phrase.words.count, by: 4) {
        let four = phrase.words[row..<min(row + 4, phrase.words.count)]
        lines.append(
            four.enumerated().map { col, word in
                let n = String(row + col + 1)
                return "\(String(repeating: " ", count: max(0, 2 - n.count)))\(n). \(word)"
            }.joined(separator: "   "))
    }
    lines += [
        "", "Anyone who has these words can open what they protect.",
        "Keep this file where only you can reach it, or print it and delete the file.", "",
    ]
    return lines.joined(separator: "\n")
}

private struct ConfirmDelete: View {
    let label: String
    let answer: (Bool) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            RunovaCard {
                VStack(alignment: .leading, spacing: 8) {
                    RunovaText("Delete \(label)?", style: RunovaType.title)
                    RunovaText(
                        "The phone forgets these words. Keep another copy if you still need them.",
                        color: palette.mutedForeground)
                    HStack(spacing: 8) {
                        RunovaButton(text: "Keep it", kind: .soft) { answer(false) }
                        RunovaButton(text: "Delete", kind: .danger) { answer(true) }
                    }
                    .padding(.top, 8)
                }
            }
            .padding(24)
        }
    }
}
