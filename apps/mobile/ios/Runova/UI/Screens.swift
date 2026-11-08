import SwiftUI

/// What the screens can ask for. Everything else is decided in the Rust core.
struct AppIntents {
    var signIn: () -> Void = {}
    var refresh: () -> Void = {}
    var connect: (Int64) -> Void = { _ in }
    var disconnect: () -> Void = {}
    var signOut: () -> Void = {}
}

let appTabs = [
    TabItem(id: "systems", title: "Systems", icon: RunovaIcons.systems),
    TabItem(id: "account", title: "Account", icon: RunovaIcons.account),
]

struct AppRoot: View {
    let view: AppView
    @Binding var tab: String
    let intents: AppIntents

    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            palette.background.ignoresSafeArea()
            switch view.auth {
            case .starting: StartingScreen()
            case .signedOut: SignInScreen(error: view.error, onSignIn: intents.signIn)
            case .signedIn: signedIn
            }
        }
    }

    @ViewBuilder private var signedIn: some View {
        if let connection = view.connection {
            if connection.phase == .connected {
                ProjectsScreen(view: view, connection: connection, intents: intents)
            } else {
                ConnectionScreen(connection: connection, intents: intents)
            }
        } else {
            VStack(spacing: 0) {
                Group {
                    if tab == "account" {
                        AccountScreen(intents: intents)
                    } else {
                        SystemsScreen(view: view, intents: intents)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
                RunovaBottomBar(tabs: appTabs, selected: tab) { tab = $0 }
            }
        }
    }
}

struct StartingScreen: View {
    var body: some View {
        RunovaText("Runova", style: RunovaType.heading)
    }
}

struct SignInScreen: View {
    let error: String?
    let onSignIn: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            RunovaIcon(glyph: RunovaIcons.systems, size: 40, color: palette.primary)
            Spacer().frame(height: 16)
            RunovaText("Runova", style: RunovaType.heading)
            Spacer().frame(height: 6)
            RunovaText(
                "Your computers, terminals and deployments, wherever you are.",
                color: palette.mutedForeground, alignment: .center)
            Spacer().frame(height: 24)
            RunovaButton(text: "Sign in", action: onSignIn).frame(maxWidth: .infinity)
            if let error {
                Spacer().frame(height: 12)
                RunovaText(error, style: RunovaType.small, color: palette.destructive, alignment: .center)
            }
        }
        .padding(32)
    }
}

private func platformName(_ platform: String) -> String {
    switch platform {
    case "windows": return "Windows"
    case "macos": return "macOS"
    case "linux": return "Linux"
    default: return platform
    }
}

private struct LoadingRows: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            RunovaSkeleton(width: 358)
            RunovaSkeleton(width: 250)
            RunovaSkeleton(width: 304)
        }
        .padding(16)
    }
}

struct SystemsScreen: View {
    let view: AppView
    let intents: AppIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RunovaTopBar(title: "Systems")
            if view.systems.isEmpty && view.systemsLoading {
                LoadingRows()
            } else if view.systems.isEmpty {
                RunovaEmptyState(
                    icon: RunovaIcons.systems, title: "No computers yet",
                    detail: "Sign in to Runova on a computer with this account and it shows up here.")
            } else {
                ScrollView {
                    RunovaCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(view.systems, id: \.id) { SystemRow(system: $0, intents: intents) }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
            }
            if let error = view.error {
                RunovaText(error, style: RunovaType.small, color: palette.destructive).padding(16)
            }
        }
    }
}

private struct SystemRow: View {
    let system: SystemView
    let intents: AppIntents

    private var badge: RunovaBadge {
        if !system.online { return RunovaBadge(text: "Offline") }
        if !system.canManage { return RunovaBadge(text: "Screen only", tone: .warning) }
        return RunovaBadge(text: "Online", tone: .success)
    }

    var body: some View {
        let row = HStack(spacing: 12) {
            RunovaListRow(
                title: system.name, detail: platformName(system.platform), icon: RunovaIcons.systems
            )
            badge.padding(.trailing, 16)
        }
        if system.online && system.canManage {
            Button { intents.connect(system.id) } label: { row.contentShape(Rectangle()) }
                .buttonStyle(.plain)
        } else {
            row
        }
    }
}

private func phaseText(_ connection: ConnectionView) -> (title: String, detail: String) {
    let name = connection.systemName
    switch connection.phase {
    case .requesting: return ("Reaching \(name)", "Asking Runova where it is.")
    case .waitingForApproval:
        return (
            "Approve on \(name)",
            "Runova on that computer is asking whether to let this phone in. You only do this once."
        )
    case .connecting: return ("Connecting", "Looking for a direct route to \(name).")
    case .securing: return ("Securing the connection", "Checking it really is \(name).")
    case .connected: return (name, "")
    case .failed: return ("Couldn't connect", connection.error ?? "Something went wrong.")
    }
}

struct ConnectionScreen: View {
    let connection: ConnectionView
    let intents: AppIntents

    @Environment(\.palette) private var palette

    var body: some View {
        let failed = connection.phase == .failed
        let text = phaseText(connection)
        VStack(spacing: 0) {
            RunovaTopBar(title: connection.systemName, onBack: intents.disconnect)
            VStack(spacing: 10) {
                RunovaIcon(
                    glyph: failed ? RunovaIcons.warning : RunovaIcons.shield, size: 36,
                    color: failed ? palette.destructive : palette.primary)
                RunovaText(text.title, style: RunovaType.title, alignment: .center)
                RunovaText(text.detail, color: palette.mutedForeground, alignment: .center)
                if failed {
                    HStack(spacing: 8) {
                        RunovaButton(text: "Back", kind: .soft, action: intents.disconnect)
                        RunovaButton(text: "Try again") { intents.connect(connection.systemId) }
                    }
                    .padding(.top, 6)
                }
            }
            .padding(32)
            .frame(maxHeight: .infinity)
        }
    }
}

struct ProjectsScreen: View {
    let view: AppView
    let connection: ConnectionView
    let intents: AppIntents

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .trailing) {
                RunovaTopBar(title: connection.systemName, onBack: intents.disconnect)
                RunovaBadge(
                    text: connection.direct == true ? "Direct" : "Relay",
                    tone: connection.direct == true ? .primary : .warning
                )
                .padding(.trailing, 16)
            }
            if let code = connection.safetyCode {
                RunovaText("Safety code \(code)", style: RunovaType.small, color: palette.mutedForeground)
                    .padding(.horizontal, 16)
            }
            if view.projects.isEmpty && view.projectsLoading {
                LoadingRows()
            } else if view.projects.isEmpty {
                RunovaEmptyState(
                    icon: RunovaIcons.folder, title: "No projects yet",
                    detail: "Add one in Runova on this computer.")
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(view.projects, id: \.id) { project in
                            RunovaListRow(
                                title: project.name,
                                detail: project.tags.isEmpty ? nil : project.tags.joined(separator: ", "),
                                icon: RunovaIcons.folder)
                        }
                    }
                    .padding(16)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct AccountScreen: View {
    let intents: AppIntents

    var body: some View {
        VStack(spacing: 0) {
            RunovaTopBar(title: "Account")
            RunovaButton(text: "Sign out", kind: .soft, action: intents.signOut)
                .frame(maxWidth: .infinity)
                .padding(16)
        }
    }
}
