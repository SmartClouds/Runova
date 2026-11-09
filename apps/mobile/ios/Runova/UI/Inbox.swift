import SwiftUI

struct NotificationIntents {
    var open: (Int64) -> Void = { _ in }
    var dismissBanner: () -> Void = {}
    var markAllRead: () -> Void = {}
    var openSettings: () -> Void = {}
    var closeSettings: () -> Void = {}
    var setEnabled: (String, Bool) -> Void = { _, _ in }
}

/// Which tab a notification opens, which depends on whether a computer is open.
func tabFor(_ destination: NotificationDestination, connected: Bool) -> String {
    switch destination {
    case .monitors: return connected ? "monitoring" : "monitors"
    case .account: return connected ? "notifications" : "account"
    case .inbox: return connected ? "notifications" : "inbox"
    }
}

struct InboxTab: View {
    let view: AppView
    let intents: NotificationIntents
    @Binding var tab: String
    var showTitle = true

    var body: some View {
        if view.notifications.settingsOpen {
            NotificationSettings(screen: view.notifications, intents: intents)
        } else if showTitle {
            RunovaScreen(
                title: "Inbox",
                trailing: {
                    RunovaChip(text: "Settings", icon: RunovaIcons.settings, action: intents.openSettings)
                        .padding(.trailing, 8)
                }
            ) { list }
        } else {
            list
        }
    }

    @ViewBuilder private var list: some View {
        let screen = view.notifications
        VStack(alignment: .leading, spacing: 0) {
            if !showTitle {
                HStack {
                    Spacer(minLength: 0)
                    RunovaChip(text: "Settings", icon: RunovaIcons.settings, action: intents.openSettings)
                }
                .padding(16)
            }
            if screen.items.isEmpty && screen.loading {
                LoadingRows()
            } else if screen.items.isEmpty {
                RunovaEmptyState(
                    icon: RunovaIcons.notifications, title: "Nothing new", detail: "What needs you shows up here.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if screen.unread > 0 {
                            HStack {
                                Spacer(minLength: 0)
                                RunovaChip(text: "Mark all read", icon: RunovaIcons.doneAll, action: intents.markAllRead)
                            }
                        }
                        ForEach(screen.items, id: \.id) { item in
                            Button {
                                intents.open(item.id)
                                tab = tabFor(item.destination, connected: view.connection != nil)
                            } label: {
                                HStack(spacing: 8) {
                                    RunovaListRow(
                                        title: item.title, detail: item.body.isEmpty ? nil : item.body,
                                        icon: RunovaIcons.notifications, iconTone: item.read ? .neutral : .primary, flat: true)
                                    if !item.read {
                                        RunovaBadge(text: "New", tone: .primary)
                                    }
                                }
                                .padding(.trailing, 12)
                                .rowCard()
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

private struct NotificationSettings: View {
    let screen: NotificationsScreen
    let intents: NotificationIntents

    var body: some View {
        RunovaScreen(title: "Notifications", onBack: intents.closeSettings) {
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(screen.preferences, id: \.category) { preference in
                        HStack {
                            RunovaText(preference.label)
                            Spacer(minLength: 0)
                            RunovaToggle(isOn: preference.enabled, label: preference.label) {
                                intents.setEnabled(preference.category, $0)
                            }
                        }
                        .padding(.vertical, 10)
                    }
                }
                .padding(16)
            }
        }
    }
}

/// One that just arrived, over whatever is on screen.
struct NotificationBanner: View {
    let item: NotificationItemView
    let connected: Bool
    let intents: NotificationIntents
    @Binding var tab: String

    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            Button {
                intents.open(item.id)
                tab = tabFor(item.destination, connected: connected)
            } label: {
                HStack(spacing: 10) {
                    RunovaIcon(glyph: RunovaIcons.notifications, color: palette.primary)
                    RunovaText(item.title, maxLines: 2)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button(action: intents.dismissBanner) {
                RunovaIcon(glyph: RunovaIcons.close, color: palette.mutedForeground).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 14)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: RunovaShape.lg)
                .fill(palette.popover)
                .overlay(
                    RoundedRectangle(cornerRadius: RunovaShape.lg).strokeBorder(palette.primary.opacity(0.35), lineWidth: 1))
        )
        .padding(12)
    }
}
