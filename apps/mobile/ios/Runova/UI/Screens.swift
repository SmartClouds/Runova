import SwiftUI

/// What the screens can ask for. Everything else is decided in the Rust core.
struct AppIntents {
    var signIn: () -> Void = {}
    var refresh: () -> Void = {}
    var connect: (Int64) -> Void = { _ in }
    var disconnect: () -> Void = {}
    var signOut: () -> Void = {}
    var openSection: (Section?) -> Void = { _ in }
    var selectProject: (String?) -> Void = { _ in }
    var openTerminal: (String) -> Void = { _ in }
    var closeTerminal: () -> Void = {}
    var terminalInput: (String) -> Void = { _ in }
    var terminalScroll: (Int32) -> Void = { _ in }
    var loadProcesses: (String) -> Void = { _ in }
    var confirm: () -> Void = {}
    var dismissConfirm: () -> Void = {}
    var dismissNotice: () -> Void = {}
    var finishIntro: () -> Void = {}
    var openAbout: () -> Void = {}
    var git = GitIntents()
    var status = StatusIntents()
    var vault = VaultIntents()
    var deploy = DeployIntents()
    var monitoring = MonitoringIntents()
    var pipelines = PipelineIntents()
    var account = AccountIntents()
    var forgetThisPhone: () -> Void = {}
    var notifications = NotificationIntents()
    var remote = RemoteIntents()
    var studio = StudioIntents()
}

let appTabs = [
    TabItem(id: "systems", title: "Systems", icon: RunovaIcons.systems),
    TabItem(id: "monitors", title: "Monitors", icon: RunovaIcons.monitoring),
    TabItem(id: "inbox", title: "Inbox", icon: RunovaIcons.notifications),
    TabItem(id: "account", title: "Account", icon: RunovaIcons.account),
]

struct AppRoot: View {
    let view: AppView
    @Binding var tab: String
    let appIntents: AppIntents

    @State private var aboutOpen = false
    @Environment(\.palette) private var palette

    init(view: AppView, tab: Binding<String>, intents: AppIntents) {
        self.view = view
        self._tab = tab
        self.appIntents = intents
    }

    private var intents: AppIntents {
        var routed = appIntents
        routed.openAbout = { aboutOpen = true }
        return routed
    }

    var body: some View {
        ZStack {
            // The chrome: what the desktop's title bar and menu are drawn on.
            palette.card.ignoresSafeArea()
            switch view.auth {
            case .starting: StartingScreen()
            case .signedOut:
                if view.showIntro {
                    IntroScreen(onDone: intents.finishIntro)
                } else {
                    SignInScreen(error: view.error, onSignIn: intents.signIn)
                }
            case .signedIn: signedIn
            }
            if let banner = view.notifications.banner {
                VStack {
                    NotificationBanner(
                        item: banner, connected: view.connection != nil, intents: intents.notifications, tab: $tab)
                    Spacer(minLength: 0)
                }
            }
            if let stepUp = view.account.stepUp {
                StepUpOverlay(stepUp: stepUp, intents: intents.account)
            }
            if let confirm = view.confirm {
                ConfirmOverlay(confirm: confirm, onConfirm: intents.confirm, onDismiss: intents.dismissConfirm)
            }
            if aboutOpen {
                AboutSheet(version: view.appVersion) { aboutOpen = false }
            }
        }
    }

    private var appSection: String { appTabs.first { $0.id == tab }?.id ?? "systems" }

    private var openMonitor: MonitorView? {
        (view.monitoring.local + view.monitoring.cloud).first { $0.id == view.monitoring.open }
    }

    @ViewBuilder private var signedIn: some View {
        if let remote = view.remote {
            RemoteViewerScreen(view: remote, intents: intents.remote)
        } else if let connection = view.connection {
            if connection.phase == .connected {
                DeviceShell(view: view, connection: connection, tab: $tab, intents: intents)
            } else {
                ConnectionScreen(connection: connection, intents: intents, fingerprint: view.phoneFingerprint)
            }
        } else if appSection == "monitors", let monitor = openMonitor {
            MonitorScreen(monitor: monitor, intents: intents.monitoring)
        } else {
            VStack(spacing: 0) {
                Group {
                    switch appSection {
                    case "account":
                        AccountTab(view: view, intents: intents)
                            .onAppear { intents.openSection(.account) }
                            .onDisappear { intents.openSection(nil) }
                    case "inbox":
                        InboxTab(view: view, intents: intents.notifications, tab: $tab)
                            .onAppear { intents.openSection(.notifications) }
                            .onDisappear { intents.openSection(nil) }
                    case "monitors":
                        RunovaScreen(title: "Monitors") {
                            MonitoringTab(view: view, intents: intents.monitoring)
                                .onAppear { intents.openSection(.monitoring) }
                                .onDisappear { intents.openSection(nil) }
                        }
                    default: SystemsScreen(view: view, intents: intents)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
                RunovaBottomBar(tabs: appTabs, selected: appSection) { tab = $0 }
            }
        }
    }
}

struct StartingScreen: View {
    var body: some View {
        RunovaSplash()
    }
}

struct SignInScreen: View {
    let error: String?
    let onSignIn: () -> Void

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            RunovaLogo(size: 112)
            Spacer().frame(height: 12)
            RunovaText("Runova", style: RunovaType.heading)
            Spacer().frame(height: 6)
            RunovaText(
                "Your computers, terminals and deployments, wherever you are.",
                color: palette.mutedForeground, alignment: .center)
            Spacer().frame(height: 24)
            RunovaButton(text: "Sign in", icon: RunovaIcons.forward, action: onSignIn).frame(maxWidth: .infinity)
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

struct LoadingRows: View {
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
        RunovaScreen(title: "Systems") {
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
        if !system.online { return RunovaBadge(text: "Offline", dot: true) }
        if !system.canManage { return RunovaBadge(text: "Screen only", tone: .warning, dot: true) }
        return RunovaBadge(text: "Online", tone: .success, dot: true)
    }

    var body: some View {
        let row = HStack(spacing: 12) {
            RunovaListRow(
                title: system.name, detail: platformName(system.platform), icon: RunovaIcons.systems,
                iconTone: system.online ? .primary : .neutral, flat: true
            )
            badge.padding(.trailing, 12)
        }
        if system.online {
            // Only its screen can be reached, by the background agent or as someone else's computer.
            let open: () -> Void =
                system.canManage ? { intents.connect(system.id) } : { intents.remote.open(system.id) }
            Button(action: open) { row.contentShape(Rectangle()) }
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
    var fingerprint: String?

    @Environment(\.palette) private var palette

    var body: some View {
        let failed = connection.phase == .failed
        let text = phaseText(connection)
        RunovaScreen(title: connection.systemName, onBack: intents.disconnect) {
            VStack(spacing: 10) {
                RunovaHeroIcon(icon: failed ? RunovaIcons.warning : RunovaIcons.shield, tone: failed ? .danger : .primary)
                    .padding(.bottom, 8)
                RunovaText(text.title, style: RunovaType.title, alignment: .center)
                RunovaText(text.detail, color: palette.mutedForeground, alignment: .center)
                if connection.phase == .waitingForApproval, let fingerprint {
                    RunovaText("It should show \(fingerprint)", style: RunovaType.title, alignment: .center)
                }
                if failed {
                    HStack(spacing: 8) {
                        RunovaButton(text: "Back", kind: .soft, action: intents.disconnect)
                        RunovaButton(text: "Try again", icon: RunovaIcons.refresh) { intents.connect(connection.systemId) }
                    }
                    .padding(.top, 6)
                }
            }
            .padding(32)
            .frame(maxHeight: .infinity)
        }
    }
}

