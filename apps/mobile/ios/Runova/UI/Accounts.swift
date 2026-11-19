import SwiftUI

/// What the account screens can ask the core for (E118).
struct AccountsIntents {
    var add: () -> Void = {}
    var cancelAdd: () -> Void = {}
    var switchTo: (Int64) -> Void = { _ in }
    var signOutOf: (Int64) -> Void = { _ in }
    var signOutAll: () -> Void = {}
}

extension AccountsView {
    /// The account in use, or nil when the core has not said yet.
    var current: AccountItem? { items.first { $0.active } }
}

private let captionStrong = RunovaTextStyle(size: 11, lineHeight: 14, weight: 600)

/// What VoiceOver reads for the header on the Account tab.
func accountsHeaderLabel(_ accounts: AccountsView) -> String {
    "Accounts, \(max(1, accounts.items.count)) on this phone"
}

/// What VoiceOver reads for one account in a list.
func accountRowLabel(_ item: AccountItem, active: Bool) -> String {
    active ? "\(item.name), \(item.email), current account" : "Switch to \(item.name), \(item.email)"
}

/// The line under the logo while another account is being added, or one is signed in again.
func addingLine(_ accounts: AccountsView) -> String {
    if let again = accounts.reauth {
        return "Your session for \(again.email) ended. Sign in again to keep using it."
    }
    if let current = accounts.current { return "You'll stay signed in to \(current.email)." }
    return "You'll stay signed in to this account."
}

/// The accounts offered on the sign-in screen after a session ended: the ones still signed in.
func signedOutOthers(_ accounts: AccountsView) -> [AccountItem] {
    accounts.items.filter { $0.id != accounts.reauth?.id && !$0.needsSignIn }
}

/// The Account tab's last button. With more than one account it signs out of the one in use only,
/// and the core asks first. With one it signs out as it always did.
func signOutButton(_ accounts: AccountsView, intents: AppIntents) -> (text: String, action: () -> Void) {
    guard accounts.items.count > 1, let current = accounts.current else { return ("Sign out", intents.signOut) }
    let signOutOf = intents.accounts.signOutOf
    return ("Sign out of \(current.email)", { signOutOf(current.id) })
}

/// The core's push labels as the map the notification extension reads: a push's tag to the email.
func pushLabelMap(_ labels: [PushLabelView]) -> [String: String] {
    Dictionary(labels.map { ($0.tag, $0.label) }, uniquingKeysWith: { first, _ in first })
}

private func initialsOf(_ profile: ProfileView) -> String {
    let words = profile.name.split(separator: " ").filter { !$0.isEmpty }
    let letters: String
    if words.count > 1, let first = words.first?.first, let last = words.last?.first {
        letters = "\(first)\(last)"
    } else if let only = words.first?.first {
        letters = String(only)
    } else {
        letters = String(profile.email.prefix(1))
    }
    return letters.uppercased()
}

/// The top of the Account tab: who this is, and the way to the other accounts on the phone. The
/// whole card opens the switcher, which is where adding and managing accounts live too.
struct AccountHeader: View {
    let profile: ProfileView
    let accounts: AccountsView
    let onOpen: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let current = accounts.current
        let others = accounts.items.filter { !$0.active }
        Button(action: onOpen) {
            RunovaCard {
                HStack(spacing: 14) {
                    RunovaAvatar(
                        initials: current?.initials ?? initialsOf(profile), tone: Int(current?.tone ?? 0), size: 52,
                        ring: true)
                    VStack(alignment: .leading, spacing: 2) {
                        RunovaText(profile.name.isEmpty ? profile.email : profile.name, style: RunovaType.title, maxLines: 1)
                        RunovaText(profile.email, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                        if profile.twoFactor {
                            RunovaBadge(text: "Two-factor on", tone: .success, dot: true).padding(.top, 6)
                        }
                    }
                    Spacer(minLength: 0)
                    if others.isEmpty {
                        SwitchHint(text: "Add", icon: RunovaIcons.add)
                    } else {
                        HStack(spacing: 8) {
                            StackedAvatars(others: others)
                            SwitchHint(text: "Switch", icon: RunovaIcons.forward)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accountsHeaderLabel(accounts))
    }
}

private struct SwitchHint: View {
    let text: String
    let icon: String

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            RunovaText(text, style: captionStrong, color: palette.primary, maxLines: 1)
            RunovaIcon(glyph: icon, size: 10, color: palette.primary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Capsule().fill(palette.primary.opacity(0.12)))
    }
}

/// Up to three of the other accounts, overlapping, so the header hints at who else is here.
private struct StackedAvatars: View {
    let others: [AccountItem]

    @Environment(\.palette) private var palette

    var body: some View {
        let shown = Array(others.prefix(3))
        ZStack(alignment: .leading) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                RunovaAvatar(initials: item.initials, tone: Int(item.tone), size: 26)
                    .overlay(Circle().strokeBorder(palette.card, lineWidth: 2))
                    .offset(x: CGFloat(index * 14))
            }
        }
        .frame(width: CGFloat(22 + (shown.count - 1) * 14), height: 26, alignment: .leading)
    }
}

/// A small avatar of the account in use for a top bar, opening the switcher.
struct AccountAvatarButton: View {
    let accounts: AccountsView
    let onOpen: () -> Void

    var body: some View {
        if let current = accounts.current {
            Button(action: onOpen) {
                RunovaAvatar(initials: current.initials, tone: Int(current.tone), size: 40, ring: true)
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Switch account")
            .padding(.trailing, 6)
        }
    }
}

/// The account switcher, as a sheet from the bottom over whatever is on show. Tapping outside it
/// closes it. Accounts keep the order they were added in, so they stay where the thumb expects.
struct AccountSwitcherSheet: View {
    let accounts: AccountsView
    let intents: AccountsIntents
    let onManage: () -> Void
    let onClose: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 24)
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
                .accessibilityLabel("Close accounts")
                .accessibilityAddTraits(.isButton)
            VStack(alignment: .leading, spacing: 0) {
                Capsule()
                    .fill(palette.mutedForeground.opacity(0.35))
                    .frame(width: 36, height: 4)
                    .frame(maxWidth: .infinity)
                Spacer().frame(height: 14)
                RunovaText("Accounts", style: RunovaType.heading)
                RunovaText(
                    "Switch any time. Every account keeps its notifications.", style: RunovaType.small,
                    color: palette.mutedForeground)
                Spacer().frame(height: 12)
                ForEach(accounts.items, id: \.id) { item in
                    AccountRow(item: item, active: item.active) {
                        onClose()
                        intents.switchTo(item.id)
                    }
                }
                Spacer().frame(height: 6)
                SheetAction(text: "Add another account", icon: RunovaIcons.add, tone: .primary) {
                    onClose()
                    intents.add()
                }
                SheetAction(text: "Manage accounts", icon: RunovaIcons.settings, tone: .neutral) {
                    onClose()
                    onManage()
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 16)
            .background(shape.fill(palette.card))
            .overlay(shape.strokeBorder(palette.border.opacity(0.7), lineWidth: 1))
            .padding(12)
        }
    }
}

/// One account in a list: its avatar, who it is, and whether it is the one in use.
private struct AccountRow: View {
    let item: AccountItem
    let active: Bool
    let onTap: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let ink = palette.avatarInk(Int(item.tone))
        Button(action: onTap) {
            HStack(spacing: 12) {
                RunovaAvatar(initials: item.initials, tone: Int(item.tone), size: 42, ring: active)
                VStack(alignment: .leading, spacing: 0) {
                    RunovaText(item.name, style: RunovaType.labelStrong, maxLines: 1)
                    RunovaText(item.email, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                }
                Spacer(minLength: 0)
                if item.needsSignIn {
                    RunovaBadge(text: "Sign in again", tone: .warning)
                } else if active {
                    RunovaIcon(glyph: RunovaIcons.check, size: 11, color: palette.primaryForeground)
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(palette.primary))
                } else {
                    RunovaIcon(glyph: RunovaIcons.forward, size: 11, color: palette.mutedForeground.opacity(0.7))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(RoundedRectangle(cornerRadius: RunovaShape.md).fill(active ? ink.opacity(0.08) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accountRowLabel(item, active: active))
    }
}

private struct SheetAction: View {
    let text: String
    let icon: String
    let tone: BadgeTone
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                RunovaIconTile(icon: icon, tone: tone, size: 36).frame(width: 42, height: 42)
                RunovaText(text, style: RunovaType.labelStrong, maxLines: 1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Every account on the phone, each with its own way out, and one way out of them all.
struct ManageAccountsScreen: View {
    let accounts: AccountsView
    let intents: AccountsIntents
    let onBack: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaScreen(title: "Accounts", subtitle: "\(accounts.items.count) on this phone", onBack: onBack) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(accounts.items, id: \.id) { item in
                        ManagedAccount(item: item, intents: intents)
                    }
                    RunovaButton(text: "Add another account", kind: .tint, icon: RunovaIcons.add) {
                        onBack()
                        intents.add()
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 6)
                    VStack(alignment: .leading, spacing: 8) {
                        RunovaSectionTitle(text: "This phone")
                        RunovaButton(
                            text: "Sign out of all accounts", kind: .danger, icon: RunovaIcons.signOut,
                            action: intents.signOutAll
                        )
                        .frame(maxWidth: .infinity)
                        RunovaText(
                            "This also removes the passcode and recovery phrases on this phone.",
                            style: RunovaType.small, color: palette.mutedForeground)
                    }
                    .padding(.top, 18)
                }
                .padding(16)
            }
        }
    }
}

private struct ManagedAccount: View {
    let item: AccountItem
    let intents: AccountsIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    RunovaAvatar(initials: item.initials, tone: Int(item.tone), size: 44, ring: item.active)
                    VStack(alignment: .leading, spacing: 0) {
                        RunovaText(item.name, style: RunovaType.labelStrong, maxLines: 1)
                        RunovaText(item.email, style: RunovaType.small, color: palette.mutedForeground, maxLines: 1)
                        RunovaText(item.lastUsed, style: RunovaType.caption, color: palette.mutedForeground.opacity(0.8))
                    }
                    Spacer(minLength: 0)
                    if item.needsSignIn {
                        RunovaBadge(text: "Sign in again", tone: .warning)
                    } else if item.active {
                        RunovaBadge(text: "Current", tone: .primary, dot: true)
                    }
                }
                HStack(spacing: 8) {
                    if !item.active {
                        RunovaButton(text: item.needsSignIn ? "Sign in" : "Switch", kind: .soft) {
                            intents.switchTo(item.id)
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("Switch to \(item.name)")
                    }
                    RunovaButton(text: "Sign out", kind: .soft, icon: RunovaIcons.signOut) {
                        intents.signOutOf(item.id)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Sign out of \(item.email)")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The moment between accounts: who the phone is switching to, while it starts.
struct SwitchingScreen: View {
    let item: AccountItem

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            RunovaAvatar(initials: item.initials, tone: Int(item.tone), size: 88, ring: true)
            Spacer().frame(height: 20)
            RunovaText("Switching to \(item.name)", style: RunovaType.heading, alignment: .center)
            Spacer().frame(height: 4)
            RunovaText(item.email, color: palette.mutedForeground, alignment: .center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A short line from the core over the tabs, such as which account is now in use. It goes by
/// itself after a few seconds, or with a tap.
struct AccountToast: View {
    let message: String
    let onDismiss: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onDismiss) {
            HStack(spacing: 8) {
                RunovaIcon(glyph: RunovaIcons.success, size: 13, color: palette.success)
                RunovaText(message, style: RunovaType.small, color: palette.popoverForeground, maxLines: 2)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Capsule().fill(palette.popover))
            .overlay(Capsule().strokeBorder(palette.border, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 24)
        .task(id: message) {
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            if !Task.isCancelled { onDismiss() }
        }
    }
}

/// On the sign-in screen after a session ended: whose it was, and the other accounts on the phone
/// to carry on with instead.
struct SignedOutAccounts: View {
    let accounts: AccountsView
    let onSwitch: (Int64) -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        let others = signedOutOthers(accounts)
        VStack(alignment: .leading, spacing: 8) {
            if let reauth = accounts.reauth {
                RunovaCard {
                    HStack(spacing: 12) {
                        RunovaAvatar(initials: reauth.initials, tone: Int(reauth.tone), size: 40)
                        RunovaText(
                            "Your session for \(reauth.email) ended. Sign in again to keep using it.",
                            style: RunovaType.small, color: palette.foreground)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if !others.isEmpty {
                RunovaSectionTitle(text: "Or switch to").padding(.top, 8)
                ForEach(others, id: \.id) { item in
                    AccountRow(item: item, active: false) { onSwitch(item.id) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
