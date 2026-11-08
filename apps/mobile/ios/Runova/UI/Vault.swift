import SwiftUI

struct VaultIntents {
    var unlock: (String) -> Void = { _ in }
    var lock: () -> Void = {}
    var openEntry: (String) -> Void = { _ in }
    var closeEntry: () -> Void = {}
    var requestReveal: (String, Bool) -> Void = { _, _ in }
    var hide: () -> Void = {}
    var save: (String?, String, String?, String?) -> Void = { _, _, _, _ in }
    var remove: (String) -> Void = { _ in }
}

struct VaultTab: View {
    let view: AppView
    let intents: VaultIntents

    var body: some View {
        switch view.vault.state {
        case .unknown: LoadingRows()
        case .uninitialized:
            RunovaEmptyState(
                icon: RunovaIcons.vault, title: "No vault on this computer",
                detail: "Set one up in Runova on this computer.")
        case .locked: UnlockForm(error: view.vault.unlockError, onUnlock: intents.unlock)
        case .unlocked: VaultList(entries: view.vault.entries, intents: intents)
        }
    }
}

private struct UnlockForm: View {
    let error: String?
    let onUnlock: (String) -> Void

    @State private var password = ""
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 12) {
            RunovaIcon(glyph: RunovaIcons.lock, size: 36, color: palette.primary)
            RunovaText("The vault is locked", style: RunovaType.title)
            RunovaTextField(value: $password, placeholder: "Vault password", secure: true)
            RunovaButton(text: "Unlock", enabled: !password.isEmpty) {
                onUnlock(password)
                password = ""
            }
            .frame(maxWidth: .infinity)
            if let error {
                RunovaText(error, style: RunovaType.small, color: palette.destructive, alignment: .center)
            }
        }
        .padding(24)
        .frame(maxHeight: .infinity)
    }
}

private struct VaultList: View {
    let entries: [VaultEntryView]
    let intents: VaultIntents

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer(minLength: 0)
                RunovaChip(text: "Lock", action: intents.lock)
            }
            .padding(16)
            if entries.isEmpty {
                RunovaEmptyState(
                    icon: RunovaIcons.vault, title: "Nothing saved yet",
                    detail: "Add entries in Runova on this computer.")
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(entries, id: \.id) { entry in
                            Button {
                                intents.openEntry(entry.id)
                            } label: {
                                RunovaListRow(title: entry.title, detail: entry.subtitle, icon: RunovaIcons.lock)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
        }
    }
}

struct VaultEntryScreen: View {
    let entry: VaultEntryView
    let revealed: RevealedSecretView?
    let intents: VaultIntents

    @State private var editing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: entry.title, onBack: intents.closeEntry)
            if editing {
                EditForm(entry: entry, intents: intents) { editing = false }
            } else {
                EntryDetail(entry: entry, revealed: revealed, intents: intents) { editing = true }
            }
            Spacer(minLength: 0)
        }
    }
}

private struct EntryDetail: View {
    let entry: VaultEntryView
    let revealed: RevealedSecretView?
    let intents: VaultIntents
    let onEdit: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let subtitle = entry.subtitle { RunovaText(subtitle, color: palette.mutedForeground) }
            ForEach(entry.secrets, id: \.key) { secret in
                SecretRow(secret: secret, revealed: revealed?.label == secret.label ? revealed : nil, intents: intents)
            }
            HStack(spacing: 8) {
                if entry.editable {
                    RunovaButton(text: "Edit", kind: .soft, action: onEdit).frame(maxWidth: .infinity)
                }
                RunovaButton(text: "Delete", kind: .danger) { intents.remove(entry.id) }.frame(maxWidth: .infinity)
            }
        }
        .padding(16)
    }
}

private struct SecretRow: View {
    let secret: VaultSecretField
    let revealed: RevealedSecretView?
    let intents: VaultIntents

    @Environment(\.palette) private var palette

    var body: some View {
        RunovaCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    RunovaText(secret.label, style: RunovaType.caption, color: palette.mutedForeground)
                    RunovaText(revealed?.value ?? "••••••••", style: RunovaType.mono)
                }
                Spacer(minLength: 0)
                if revealed != nil {
                    RunovaChip(text: "Hide", action: intents.hide)
                } else {
                    RunovaChip(text: "Reveal") { intents.requestReveal(secret.key, secret.custom) }
                        .accessibilityLabel("Reveal \(secret.label)")
                }
            }
        }
    }
}

private struct EditForm: View {
    let entry: VaultEntryView
    let intents: VaultIntents
    let onDone: () -> Void

    @State private var title = ""
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 12) {
            RunovaTextField(value: $title, placeholder: "Title")
            RunovaTextField(value: $username, placeholder: "Username")
            RunovaTextField(value: $password, placeholder: "New password (leave empty to keep it)", secure: true)
            RunovaButton(text: "Save", enabled: !title.isEmpty) {
                intents.save(entry.id, title, username, password.isEmpty ? nil : password)
                onDone()
            }
            .frame(maxWidth: .infinity)
        }
        .padding(16)
        .onAppear {
            title = entry.title
            username = entry.subtitle ?? ""
        }
    }
}
