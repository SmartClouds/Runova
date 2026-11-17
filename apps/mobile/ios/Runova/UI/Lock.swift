import SwiftUI
import UIKit

/// What the lock screen can ask for. The core decides what each one means.
struct LockIntents {
    var key: (UInt8) -> Void = { _ in }
    var backspace: () -> Void = {}
    var submit: (String) -> Void = { _ in }
    var useBiometric: () -> Void = {}
    var forgot: () -> Void = {}
    var forgotConfirm: (Bool) -> Void = { _ in }
}

/// What the Passcode lock settings can ask for.
struct PasscodeIntents {
    var open: () -> Void = {}
    var close: () -> Void = {}
    var start: (PasscodeKind) -> Void = { _ in }
    var key: (UInt8) -> Void = { _ in }
    var backspace: () -> Void = {}
    var submit: (String) -> Void = { _ in }
    var off: () -> Void = {}
    var setAutoLock: (AutoLock) -> Void = { _ in }
    var setBiometric: (Bool) -> Void = { _ in }
    var lockNow: () -> Void = {}
}

private let keySize: CGFloat = 72
private let letters: [UInt8: String] = [
    2: "ABC", 3: "DEF", 4: "GHI", 5: "JKL", 6: "MNO", 7: "PQRS", 8: "TUV", 9: "WXYZ",
]
private let digitStyle = RunovaTextStyle(size: 28, lineHeight: 30, weight: 400)
private let lettersStyle = RunovaTextStyle(size: 9, lineHeight: 10, weight: 500, tracking: 0.17)

private func noun(_ kind: PasscodeKind) -> String { kind == .password ? "password" : "passcode" }

private func biometricIcon(_ kind: BiometricKind) -> String {
    kind == .face ? RunovaIcons.face : RunovaIcons.fingerprint
}

/// The phone's own check, offered beside the keypad.
private struct BiometricKey {
    let label: String
    let kind: BiometricKind
    let action: () -> Void
}

/// Covers the whole app until the passcode or biometrics open it. Nothing behind it is drawn.
struct AppLockScreen: View {
    let lock: LockScreen
    let intents: LockIntents

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            palette.background.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                RunovaHeroIcon(icon: RunovaIcons.lock)
                Spacer().frame(height: 20)
                PasscodeEntry(
                    entry: lock.entry, onKey: intents.key, onBackspace: intents.backspace, onSubmit: intents.submit,
                    submitLabel: "Unlock",
                    biometric: lock.biometricLabel.map {
                        BiometricKey(label: $0, kind: lock.biometricKind, action: intents.useBiometric)
                    })
                Spacer(minLength: 0)
                Button(action: intents.forgot) {
                    RunovaText("Forgot \(noun(lock.entry.kind))?", style: RunovaType.label, color: palette.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .padding(.top, 12)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 28)
            if lock.confirmForgot {
                ForgotSheet(kind: lock.entry.kind, answer: intents.forgotConfirm)
            }
        }
    }
}

private struct ForgotSheet: View {
    let kind: PasscodeKind
    let answer: (Bool) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea().onTapGesture { answer(false) }
            RunovaCard {
                VStack(alignment: .leading, spacing: 8) {
                    RunovaText("Forgot your \(noun(kind))?", style: RunovaType.title)
                    RunovaText(
                        "The only way back in is to sign this phone out. The \(noun(kind)) is removed, and you sign "
                            + "in again. Nothing on your computers changes.",
                        color: palette.mutedForeground)
                    HStack(spacing: 8) {
                        RunovaButton(text: "Cancel", kind: .soft) { answer(false) }.frame(maxWidth: .infinity)
                        RunovaButton(text: "Sign out", kind: .danger) { answer(true) }.frame(maxWidth: .infinity)
                    }
                    .padding(.top, 8)
                }
            }
            .padding(24)
        }
    }
}

/// The title, dots or password field, the line under them and the keypad.
private struct PasscodeEntry: View {
    let entry: PasscodeEntryView
    let onKey: (UInt8) -> Void
    let onBackspace: () -> Void
    let onSubmit: (String) -> Void
    let submitLabel: String
    let biometric: BiometricKey?
    /// While choosing a new passcode: switches between a 4-digit, a 6-digit code and a password.
    var onKind: ((PasscodeKind) -> Void)?

    @Environment(\.palette) private var palette

    private var open: Bool { entry.waitSeconds == 0 && !entry.busy }

    var body: some View {
        VStack(spacing: 0) {
            RunovaText(entry.title, style: RunovaType.heading, alignment: .center)
            Spacer().frame(height: 22)
            if entry.length > 0 {
                PinDots(length: Int(entry.length), filled: Int(entry.filled), shake: entry.shake, busy: entry.busy)
            } else {
                PasswordField(entry: entry, open: open, onSubmit: onSubmit, submitLabel: submitLabel)
            }
            RunovaText(entry.error ?? "", style: RunovaType.small, color: palette.destructive, alignment: .center)
                .frame(minHeight: 18)
                .padding(.top, 14)
                .accessibilityAddTraits(.updatesFrequently)
            if let onKind {
                KindChoice(current: entry.kind, choose: onKind).padding(.top, 10)
            }
            Spacer().frame(height: 20)
            if entry.length > 0 {
                Keypad(enabled: open, onKey: onKey, onBackspace: onBackspace, biometric: biometric)
            } else if let biometric {
                RunovaButton(text: "Use \(biometric.label)", kind: .soft, icon: biometricIcon(biometric.kind)) {
                    biometric.action()
                }
                .accessibilityLabel("Unlock with \(biometric.label)")
            }
        }
        .frame(maxWidth: 360)
    }
}

/// Moves side to side, once for each step of `shakes`.
private struct Shake: GeometryEffect {
    var shakes: CGFloat
    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 12 * sin(shakes * .pi * 6), y: 0))
    }
}

/// One dot a digit. They fill with a spring and shake once for each wrong code.
private struct PinDots: View {
    let length: Int
    let filled: Int
    let shake: UInt64
    let busy: Bool

    @State private var shakes: CGFloat = 0
    @Environment(\.palette) private var palette
    @Environment(\.runovaMotion) private var motion

    var body: some View {
        HStack(spacing: 18) {
            ForEach(0..<length, id: \.self) { index in
                let on = index < filled
                Circle()
                    .fill(on ? palette.primary : Color.clear)
                    .overlay(Circle().strokeBorder(on ? palette.primary : palette.foreground.opacity(0.35), lineWidth: 1.5))
                    .frame(width: 14, height: 14)
                    .scaleEffect(on ? 1 : 0.82)
                    .animation(motion ? .spring(response: 0.3, dampingFraction: 0.45) : nil, value: on)
            }
        }
        .modifier(Shake(shakes: shakes))
        .opacity(busy ? 0.5 : 1)
        .onChange(of: shake) { _ in
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            if motion {
                withAnimation(.linear(duration: 0.38)) { shakes += 1 }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(filled) of \(length) digits entered")
    }
}

private struct PasswordField: View {
    let entry: PasscodeEntryView
    let open: Bool
    let onSubmit: (String) -> Void
    let submitLabel: String

    @State private var text = ""

    private func send() {
        if open && !text.isEmpty { onSubmit(text) }
    }

    var body: some View {
        VStack(spacing: 12) {
            RunovaTextField(value: $text, placeholder: "Password", secure: true, icon: RunovaIcons.key, label: "Password")
                .submitLabel(.go)
                .onSubmit(send)
            RunovaButton(text: submitLabel, enabled: open && !text.isEmpty, action: send)
                .frame(maxWidth: .infinity)
        }
        // A wrong password empties the field, as the dots empty for a code.
        .onChange(of: entry.shake) { _ in text = "" }
    }
}

/// A round key that lights up while held.
private struct KeyStyle: ButtonStyle {
    let filled: Bool
    @Environment(\.palette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: keySize, height: keySize)
            .background(
                Circle().fill(
                    palette.foreground.opacity(
                        configuration.isPressed ? (filled ? 0.16 : 0.1) : (filled ? 0.06 : 0))))
            .contentShape(Circle())
    }
}

private struct Keypad: View {
    let enabled: Bool
    let onKey: (UInt8) -> Void
    let onBackspace: () -> Void
    let biometric: BiometricKey?

    var body: some View {
        VStack(spacing: 14) {
            ForEach([[1, 2, 3], [4, 5, 6], [7, 8, 9]] as [[UInt8]], id: \.self) { row in
                HStack(spacing: 22) {
                    ForEach(row, id: \.self) { DigitKey(digit: $0, enabled: enabled, onKey: onKey) }
                }
            }
            HStack(spacing: 22) {
                if let biometric {
                    IconKey(
                        icon: biometricIcon(biometric.kind), label: "Unlock with \(biometric.label)", enabled: true,
                        action: biometric.action)
                } else {
                    Color.clear.frame(width: keySize, height: keySize)
                }
                DigitKey(digit: 0, enabled: enabled, onKey: onKey)
                IconKey(icon: RunovaIcons.backspace, label: "Delete", enabled: enabled, action: onBackspace)
            }
        }
    }
}

private struct DigitKey: View {
    let digit: UInt8
    let enabled: Bool
    let onKey: (UInt8) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button {
            onKey(digit)
        } label: {
            VStack(spacing: 0) {
                RunovaText("\(digit)", style: digitStyle)
                if let row = letters[digit] {
                    RunovaText(row, style: lettersStyle, color: palette.mutedForeground)
                }
            }
        }
        .buttonStyle(KeyStyle(filled: true))
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(digit)")
        .accessibilityAddTraits(.isButton)
    }
}

private struct IconKey: View {
    let icon: String
    let label: String
    let enabled: Bool
    let action: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            RunovaIcon(glyph: icon, size: 26, color: palette.foreground.opacity(0.85))
        }
        .buttonStyle(KeyStyle(filled: false))
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(label)
    }
}

private struct KindChoice: View {
    let current: PasscodeKind
    let choose: (PasscodeKind) -> Void

    private let kinds: [(PasscodeKind, String)] = [
        (.pin4, "4-digit code"), (.pin6, "6-digit code"), (.password, "Password"),
    ]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(kinds, id: \.1) { item in
                RunovaChip(text: item.1, tone: item.0 == current ? .primary : .soft) {
                    if item.0 != current { choose(item.0) }
                }
                .accessibilityAddTraits(item.0 == current ? .isSelected : [])
            }
        }
    }
}

/// Passcode lock, opened from the Account tab.
struct PasscodeSettings: View {
    let screen: PasscodeSettingsScreen
    let intents: PasscodeIntents

    var body: some View {
        RunovaScreen(title: "Passcode lock", onBack: intents.close) {
            switch screen.step {
            case .off: PasscodeOff(intents: intents)
            case .on: PasscodeOn(screen: screen, intents: intents)
            default:
                ScrollView {
                    PasscodeEntry(
                        entry: screen.entry, onKey: intents.key, onBackspace: intents.backspace,
                        onSubmit: intents.submit, submitLabel: screen.step == .verify ? "Continue" : "Next",
                        biometric: nil, onKind: screen.step == .choose ? intents.start : nil)
                        .frame(maxWidth: .infinity)
                        .padding(24)
                }
            }
        }
    }
}

private struct PasscodeOff: View {
    let intents: PasscodeIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            RunovaHeroIcon(icon: RunovaIcons.lock)
            RunovaText("Lock Runova with a passcode", style: RunovaType.heading, alignment: .center)
                .padding(.top, 20)
            RunovaText(
                "Runova asks for it each time it opens, and can use Face ID or Touch ID instead. "
                    + "If you forget it, the only way back in is to sign this phone out.",
                color: palette.mutedForeground, alignment: .center
            )
            .frame(maxWidth: 320)
            .padding(.top, 8)
            RunovaButton(text: "Turn passcode on", icon: RunovaIcons.lock) { intents.start(.pin4) }
                .frame(minWidth: 220)
                .padding(.top, 24)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }
}

private struct PasscodeOn: View {
    let screen: PasscodeSettingsScreen
    let intents: PasscodeIntents

    @Environment(\.palette) private var palette

    private var kind: PasscodeKind { screen.entry.kind }

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                RunovaCard {
                    HStack(spacing: 12) {
                        RunovaIconTile(icon: RunovaIcons.lock, tone: .success)
                        VStack(alignment: .leading, spacing: 0) {
                            RunovaText("Passcode lock is on", style: RunovaType.labelStrong)
                            RunovaText(
                                "Runova asks for your \(noun(kind)) when it opens.", style: RunovaType.small,
                                color: palette.mutedForeground)
                        }
                        Spacer(minLength: 0)
                    }
                }
                if let label = screen.biometricLabel {
                    RunovaCard {
                        HStack(spacing: 12) {
                            RunovaIconTile(icon: biometricIcon(screen.biometricKind))
                            VStack(alignment: .leading, spacing: 0) {
                                RunovaText("Unlock with \(label)", style: RunovaType.labelStrong)
                                RunovaText(
                                    "Use it instead of typing the \(noun(kind)).", style: RunovaType.small,
                                    color: palette.mutedForeground)
                            }
                            Spacer(minLength: 0)
                            RunovaToggle(isOn: screen.biometricOn, label: "Unlock with \(label)") {
                                intents.setBiometric($0)
                            }
                        }
                    }
                }
                AutoLockCard(screen: screen, choose: intents.setAutoLock)
                RunovaListRow(title: "Change \(noun(kind))", icon: RunovaIcons.key, onTap: { intents.start(kind) })
                RunovaListRow(title: "Lock now", icon: RunovaIcons.lock, onTap: intents.lockNow)
                RunovaButton(text: "Turn passcode off", kind: .danger, icon: RunovaIcons.unlock, action: intents.off)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 4)
                RunovaText(
                    "If you forget your \(noun(kind)), the only way back in is to sign this phone out.",
                    style: RunovaType.caption, color: palette.mutedForeground, alignment: .center
                )
                .frame(maxWidth: .infinity)
            }
            .padding(16)
        }
    }
}

private struct AutoLockCard: View {
    let screen: PasscodeSettingsScreen
    let choose: (AutoLock) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText("Auto-lock", style: RunovaType.labelStrong)
                    RunovaText(
                        "How long Runova can be away before it locks.", style: RunovaType.small,
                        color: palette.mutedForeground)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 6)
                ForEach(screen.autoLockChoices, id: \.label) { choice in
                    let chosen = choice.value == screen.autoLock
                    Button {
                        choose(choice.value)
                    } label: {
                        HStack {
                            RunovaText(
                                choice.label, color: chosen ? palette.foreground : palette.foreground.opacity(0.85))
                            Spacer(minLength: 0)
                            if chosen { RunovaIcon(glyph: RunovaIcons.check, size: 14, color: palette.primary) }
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(chosen ? .isSelected : [])
                }
            }
            .padding(.bottom, 12)
        }
    }
}
