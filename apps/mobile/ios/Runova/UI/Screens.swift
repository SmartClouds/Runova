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
    var scanSignIn: (String) -> Void = { _ in }
    var cancelQrSignIn: () -> Void = {}
    /// Asks the core for a passkey challenge (E115).
    var signInWithPasskey: () -> Void = {}
    /// Shows the platform's passkey prompt for a challenge the core put in the view.
    var promptPasskey: (_ challengeId: String, _ optionsJson: String) -> Void = { _, _ in }
    /// Asks the core for a nonce for a provider's own sheet: Sign in with Apple on iOS (E117).
    var signInWithProvider: (_ provider: String) -> Void = { _ in }
    /// Opens the browser sign-in going straight to a provider (E117).
    var signInInBrowser: (_ provider: String) -> Void = { _ in }
    /// Shows the Sign in with Apple sheet for a nonce the core put in the view.
    var promptApple: (_ nonce: String) -> Void = { _ in }
    var openAbout: () -> Void = {}
    /// Opens the account switcher (E118). The app's root fills this in.
    var openAccounts: () -> Void = {}
    var accounts = AccountsIntents()
    var git = GitIntents()
    var status = StatusIntents()
    var vault = VaultIntents()
    var deploy = DeployIntents()
    var cloudflare = CloudflareIntents()
    var monitoring = MonitoringIntents()
    var pipelines = PipelineIntents()
    var account = AccountIntents()
    var forgetThisPhone: () -> Void = {}
    var notifications = NotificationIntents()
    var remote = RemoteIntents()
    var studio = StudioIntents()
    var prompts = PromptIntents()
    var lock = LockIntents()
    var passcode = PasscodeIntents()
    var phrases = PhraseIntents()
    var send = SendIntents()
    var receive = ReceiveIntents()
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
    @State private var switcherOpen = false
    @State private var manageOpen = false
    @ObservedObject private var sendPicks: SendPicks
    @Environment(\.palette) private var palette

    init(view: AppView, tab: Binding<String>, intents: AppIntents) {
        self.view = view
        self._tab = tab
        self.appIntents = intents
        self._sendPicks = ObservedObject(wrappedValue: intents.send.picks)
    }

    private var intents: AppIntents {
        var routed = appIntents
        routed.openAbout = { aboutOpen = true }
        routed.openAccounts = { switcherOpen = true }
        return routed
    }

    var body: some View {
        if view.lock.locked {
            // Only the lock is drawn, so nothing behind it reaches the screen or VoiceOver.
            AppLockScreen(lock: view.lock, intents: intents.lock)
        } else {
            app
        }
    }

    private var app: some View {
        ZStack {
            // The chrome: what the desktop's title bar and menu are drawn on.
            palette.card.ignoresSafeArea()
            switch view.auth {
            case .starting: StartingScreen()
            case .signedOut:
                if view.showIntro {
                    IntroScreen(onDone: intents.finishIntro)
                } else {
                    SignInFlow(view: view, intents: intents, adding: false)
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
            // What the core says about a switch, over the tabs (a connected computer has its own bar).
            if view.auth == .signedIn, view.connection == nil, view.accounts.switching == nil, let notice = view.notice {
                VStack {
                    Spacer(minLength: 0)
                    AccountToast(message: notice, onDismiss: intents.dismissNotice)
                        .padding(.bottom, 92)
                }
            }
            if switcherOpen, view.auth == .signedIn, !view.accounts.adding {
                AccountSwitcherSheet(
                    accounts: view.accounts, intents: intents.accounts, onManage: { manageOpen = true }
                ) { switcherOpen = false }
            }
            if let stepUp = view.account.stepUp {
                StepUpOverlay(stepUp: stepUp, intents: intents.account)
            }
            if let confirm = view.confirm {
                ConfirmOverlay(confirm: confirm, onConfirm: intents.confirm, onDismiss: intents.dismissConfirm)
            }
            // Files on their way to the phone ask first, over whatever is on show (E114).
            if view.auth == .signedIn, let offer = view.receive.offers.first {
                IncomingOfferSheet(offer: offer, intents: intents.receive)
            }
            if aboutOpen {
                AboutSheet(version: view.appVersion) { aboutOpen = false }
            }
        }
        .environment(\.gitTools, view.gitTools)
    }

    private var appSection: String { appTabs.first { $0.id == tab }?.id ?? "systems" }

    private var openMonitor: MonitorView? {
        (view.monitoring.local + view.monitoring.cloud).first { $0.id == view.monitoring.open }
    }

    @ViewBuilder private var signedIn: some View {
        if let switching = view.accounts.switching {
            SwitchingScreen(item: switching)
        } else if view.accounts.adding {
            // Adding an account: the sign-in screen over the account in use (E118).
            SignInFlow(view: view, intents: intents, adding: true)
        } else if manageOpen {
            ManageAccountsScreen(accounts: view.accounts, intents: intents.accounts) { manageOpen = false }
        } else if sendPicks.open {
            // Sending files goes beside a connection, so it opens over whatever is on show.
            SendFilesScreen(
                screen: view.send, intents: intents.send, receive: view.receive, receiveIntents: intents.receive
            ) { sendPicks.open = false }
        } else if let remote = view.remote {
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

/// Signing in, with its QR scan and the platform prompts. Used signed out, and over the account in
/// use when another is being added.
private struct SignInFlow: View {
    let view: AppView
    let intents: AppIntents
    let adding: Bool

    @State private var scanning = false

    var body: some View {
        if let qr = view.qrSignIn {
            QrWaitingScreen(view: qr, onCancel: intents.cancelQrSignIn)
        } else if scanning {
            QrScanScreen(
                onCode: {
                    scanning = false
                    intents.scanSignIn($0)
                },
                onCancel: { scanning = false })
        } else {
            SignInScreen(
                error: view.error, onSignIn: intents.signIn, onScanQr: { scanning = true },
                onPasskey: intents.signInWithPasskey, passkeyWaiting: view.passkeySignIn != nil,
                onApple: { intents.signInWithProvider("apple") },
                appleWaiting: view.providerSignIn?.provider == "apple",
                onBrowserProvider: intents.signInInBrowser,
                adding: adding ? view.accounts : nil,
                onCancelAdding: intents.accounts.cancelAdd,
                signedOut: !adding && !view.accounts.items.isEmpty ? view.accounts : nil,
                onSwitch: intents.accounts.switchTo
            )
            // Once per challenge: a redraw must not open the prompt again.
            .task(id: view.passkeySignIn?.challengeId) {
                if let passkey = view.passkeySignIn, let options = passkey.optionsJson {
                    intents.promptPasskey(passkey.challengeId, options)
                }
            }
            // Once per nonce, as with the passkey prompt.
            .task(id: view.providerSignIn?.nonce) {
                if let sheet = view.providerSignIn, sheet.provider == "apple", let nonce = sheet.nonce {
                    intents.promptApple(nonce)
                }
            }
            // Two-step sign-in: the browser asks for the code. Once each time it is set.
            .task(id: view.continueInBrowser) {
                if let provider = view.continueInBrowser { intents.signInInBrowser(provider) }
            }
        }
    }
}

struct SignInScreen: View {
    let error: String?
    let onSignIn: () -> Void
    var onScanQr: () -> Void = {}
    var onPasskey: () -> Void = {}
    var passkeyWaiting = false
    var onApple: () -> Void = {}
    var appleWaiting = false
    var onBrowserProvider: (String) -> Void = { _ in }
    /// The accounts already on the phone while one more is added (E118).
    var adding: AccountsView? = nil
    var onCancelAdding: () -> Void = {}
    /// The accounts on the phone after a session ended, to sign in again or switch.
    var signedOut: AccountsView? = nil
    var onSwitch: (Int64) -> Void = { _ in }

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            if let adding {
                RunovaTopBar(title: adding.reauth != nil ? "Sign in again" : "Add an account", onBack: onCancelAdding)
            }
            // Scrolls only when it does not fit, such as with several accounts listed above the buttons.
            ViewThatFits(in: .vertical) {
                form
                ScrollView { form }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private var form: some View {
        VStack(spacing: 0) {
            if let adding {
                RunovaLogo(size: 72)
                Spacer().frame(height: 12)
                RunovaText(addingLine(adding), color: palette.mutedForeground, alignment: .center)
            } else {
                RunovaLogo(size: 112)
                Spacer().frame(height: 12)
                RunovaText("Runova", style: RunovaType.heading)
                Spacer().frame(height: 6)
                RunovaText(
                    "Your computers, terminals and deployments, wherever you are.",
                    color: palette.mutedForeground, alignment: .center)
                if let signedOut {
                    Spacer().frame(height: 16)
                    SignedOutAccounts(accounts: signedOut, onSwitch: onSwitch)
                }
            }
            Spacer().frame(height: 24)
            RunovaButton(text: "Sign in", icon: RunovaIcons.forward, action: onSignIn).frame(maxWidth: .infinity)
            Spacer().frame(height: 8)
            RunovaButton(text: "Scan QR code", kind: .soft, icon: RunovaIcons.qrCode, action: onScanQr)
                .frame(maxWidth: .infinity)
            Spacer().frame(height: 8)
            RunovaButton(
                text: passkeyWaiting ? "Waiting for your passkey…" : "Use a passkey", kind: .soft,
                icon: RunovaIcons.fingerprint, action: onPasskey
            )
            .disabled(passkeyWaiting)
            .frame(maxWidth: .infinity)
            Spacer().frame(height: 16)
            AppleButton(waiting: appleWaiting, action: onApple)
            Spacer().frame(height: 8)
            RunovaButton(text: "Continue with Google", kind: .soft, action: { onBrowserProvider("google") })
                .frame(maxWidth: .infinity)
            Spacer().frame(height: 8)
            RunovaButton(text: "Continue with Microsoft", kind: .soft, action: { onBrowserProvider("microsoft") })
                .frame(maxWidth: .infinity)
            if let error {
                Spacer().frame(height: 12)
                RunovaText(error, style: RunovaType.small, color: palette.destructive, alignment: .center)
            }
        }
        .padding(32)
    }
}

/// Continue with Apple as Apple's guidelines draw it: white, with the Apple logo, on a dark screen.
private struct AppleButton: View {
    let waiting: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "apple.logo")
                Text(waiting ? "Waiting for Apple…" : "Continue with Apple").font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(.white, in: Capsule())
        }
        .disabled(waiting)
        .accessibilityLabel(waiting ? "Waiting for Apple" : "Continue with Apple")
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
        let openSend = { intents.send.picks.open = true }
        RunovaScreen(
            title: "Systems",
            trailing: {
                HStack(spacing: 0) {
                    // With one account there is nothing to switch to, so the bar stays as it was.
                    if view.accounts.items.count > 1 {
                        AccountAvatarButton(accounts: view.accounts, onOpen: intents.openAccounts)
                    }
                    SendFilesButton(onOpen: openSend)
                }
            }
        ) {
            if let label = view.send.progressLabel {
                SendingStrip(label: label, percent: Int(view.send.progressPercent), icon: RunovaIcons.send, onOpen: openSend)
                    .padding(.horizontal, 16).padding(.top, 12)
            }
            if let label = view.receive.progressLabel {
                SendingStrip(label: label, percent: Int(view.receive.progressPercent), icon: RunovaIcons.pull, onOpen: openSend)
                    .padding(.horizontal, 16).padding(.top, 12)
            }
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

