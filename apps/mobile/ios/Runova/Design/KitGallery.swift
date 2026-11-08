import SwiftUI

let galleryTabs = [
    TabItem(id: "systems", title: "Systems", icon: RunovaIcons.systems),
    TabItem(id: "activity", title: "Activity", icon: RunovaIcons.monitoring),
    TabItem(id: "alerts", title: "Alerts", icon: RunovaIcons.notifications),
    TabItem(id: "account", title: "Account", icon: RunovaIcons.account),
]

/// Every kit component in fixed states. `KitGallery.kt` lays out the same thing.
struct KitGallery: View {
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            RunovaTopBar(title: "Kit", onBack: {})
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    RunovaButton(text: "Connect", icon: RunovaIcons.check) {}
                    RunovaButton(text: "Later", kind: .soft) {}
                    RunovaButton(text: "Remove", kind: .danger) {}
                }
                HStack(spacing: 8) {
                    RunovaBadge(text: "Online", tone: .success)
                    RunovaBadge(text: "Direct", tone: .primary)
                    RunovaBadge(text: "Relay", tone: .warning)
                    RunovaBadge(text: "Failed", tone: .danger)
                    RunovaBadge(text: "Idle")
                }
                RunovaCard(padding: 0) {
                    VStack(spacing: 0) {
                        RunovaListRow(
                            title: "Sam's desk", detail: "Windows, online", icon: RunovaIcons.systems, onTap: {})
                        RunovaListRow(
                            title: "Build server", detail: "Linux, offline", icon: RunovaIcons.server, onTap: {})
                    }
                }
                RunovaTextField(value: .constant(""), placeholder: "Search projects")
                RunovaTextField(value: .constant("runova-link"), placeholder: "")
                RunovaSkeleton(width: 180)
                RunovaEmptyState(
                    icon: RunovaIcons.folder, title: "No projects yet", detail: "Add one on your computer.")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            RunovaBottomBar(tabs: galleryTabs, selected: "systems") { _ in }
        }
        .background(palette.background)
    }
}
