import AuthenticationServices
import Security
import LocalAuthentication
import UserNotifications
import SwiftUI

private let service = "com.runovahq.app.secure"

/// Values kept in the iOS Keychain, readable only by this app and only after the first unlock.
final class KeychainStore: SecureStore {
    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func get(key: String) -> String? {
        var request = query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(key: String, value: String) {
        let data = Data(value.utf8)
        let update = [kSecValueData as String: data]
        if SecItemUpdate(query(key) as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = query(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func remove(key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}

private let site = "https://runovahq.com"
private let backgroundGraceMs: UInt64 = 30_000

/// Holds the core and publishes what it says for SwiftUI.
@MainActor
final class AppModel: NSObject, ObservableObject {
    @Published var view: AppView?
    @Published var tab = "systems"

    private var core: RunovaCore?
    private var browser: ASWebAuthenticationSession?

    func start() {
        guard core == nil else { return }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        core = try? RunovaCore(
            config: CoreConfig(site: site, platform: "ios", appVersion: version),
            secure: KeychainStore(),
            listener: Listener(model: self))
    }

    var intents: AppIntents {
        AppIntents(
            signIn: { [weak self] in self?.signIn() },
            refresh: { [weak self] in self?.core?.refresh() },
            connect: { [weak self] in self?.core?.connect(systemId: $0) },
            disconnect: { [weak self] in self?.core?.disconnect() },
            signOut: { [weak self] in self?.core?.signOut() },
            openSection: { [weak self] in self?.core?.openSection(section: $0) },
            selectProject: { [weak self] in self?.core?.selectProject(projectId: $0) },
            openTerminal: { [weak self] in self?.core?.openTerminal(sessionId: $0) },
            closeTerminal: { [weak self] in self?.core?.closeTerminal() },
            terminalInput: { [weak self] in self?.core?.terminalInput(data: $0) },
            terminalScroll: { [weak self] in self?.core?.terminalScroll(lines: $0) },
            loadProcesses: { [weak self] in self?.core?.loadTerminalProcesses(sessionId: $0) },
            confirm: { [weak self] in self?.engine?.confirm() },
            dismissConfirm: { [weak self] in self?.engine?.dismissConfirm() },
            dismissNotice: { [weak self] in self?.engine?.dismissNotice() },
            finishIntro: { [weak self] in self?.engine?.introDone() },
            git: gitIntents,
            status: StatusIntents(
                openProvider: { [weak self] in self?.engine?.openUsageProvider(providerId: $0) },
                closeProvider: { [weak self] in self?.engine?.closeUsageProvider() }),
            vault: VaultIntents(
                unlock: { [weak self] in self?.engine?.vaultUnlock(password: $0) },
                lock: { [weak self] in self?.engine?.vaultLock() },
                openEntry: { [weak self] in self?.engine?.vaultOpenEntry(id: $0) },
                closeEntry: { [weak self] in self?.engine?.vaultCloseEntry() },
                requestReveal: { [weak self] in self?.engine?.vaultRequestReveal(field: $0, custom: $1) },
                hide: { [weak self] in self?.engine?.vaultHide() },
                save: { [weak self] in self?.engine?.vaultSave(id: $0, title: $1, username: $2, password: $3) },
                remove: { [weak self] in self?.engine?.vaultRemove(id: $0) }),
            deploy: DeployIntents(
                openServer: { [weak self] in self?.engine?.deployOpenServer(id: $0) },
                closeServer: { [weak self] in self?.engine?.deployCloseServer() },
                openLogs: { [weak self] in self?.engine?.deployOpenLogs(containerId: $0) },
                closeLogs: { [weak self] in self?.engine?.deployCloseLogs() },
                containerAction: { [weak self] in self?.engine?.deployContainerAction(containerId: $0, action: $1) },
                stackAction: { [weak self] in self?.engine?.deployStackAction(stack: $0, action: $1) },
                redeploy: { [weak self] in self?.engine?.deployStackRedeploy(stack: $0) }),
            monitoring: MonitoringIntents(
                open: { [weak self] in self?.engine?.monitorOpen(id: $0) },
                close: { [weak self] in self?.engine?.monitorClose() },
                check: { [weak self] in self?.engine?.monitorCheck(id: $0) },
                setPaused: { [weak self] in self?.engine?.monitorSetPaused(id: $0, source: $1, paused: $2) },
                openErrors: { [weak self] in self?.engine?.errorsOpen() },
                closeErrors: { [weak self] in self?.engine?.errorsClose() },
                openIssue: { [weak self] in self?.engine?.errorsOpenIssue(connectionId: $0, issueId: $1) },
                closeIssue: { [weak self] in self?.engine?.errorsCloseIssue() },
                resolveIssue: { [weak self] in self?.engine?.errorsResolve() },
                reopenIssue: { [weak self] in self?.engine?.errorsReopen() }),
            pipelines: PipelineIntents(
                openRun: { [weak self] in self?.engine?.pipelinesOpenRun(runId: $0) },
                closeRun: { [weak self] in self?.engine?.pipelinesCloseRun() },
                openJob: { [weak self] in self?.engine?.pipelinesOpenJob(jobId: $0) },
                closeJob: { [weak self] in self?.engine?.pipelinesCloseJob() },
                dispatch: { [weak self] in self?.engine?.pipelinesDispatch(workflowId: $0) },
                submitDispatch: { [weak self] in self?.engine?.pipelinesSubmitDispatch(values: $0) },
                closeDispatch: { [weak self] in self?.engine?.pipelinesCloseDispatch() },
                cancel: { [weak self] in self?.engine?.pipelinesCancel(runId: $0) }),
            account: AccountIntents(
                setName: { [weak self] in self?.engine?.accountSetName(name: $0) },
                endSession: { [weak self] in self?.engine?.accountEndSession(id: $0) },
                endOtherSessions: { [weak self] in self?.engine?.accountEndOtherSessions() },
                submitStepUp: { [weak self] in self?.engine?.accountSubmitStepUp(password: $0, code: $1) },
                cancelStepUp: { [weak self] in self?.engine?.accountCancelStepUp() },
                openTeam: { [weak self] in self?.engine?.accountOpenTeam(id: $0) },
                closeTeam: { [weak self] in self?.engine?.accountCloseTeam() },
                invite: { [weak self] in self?.engine?.accountInvite(email: $0, role: $1) },
                cancelInvitation: { [weak self] in self?.engine?.accountCancelInvitation(id: $0) },
                removeMember: { [weak self] in self?.engine?.accountRemoveMember(userId: $0) },
                setMemberRole: { [weak self] in self?.engine?.accountSetMemberRole(userId: $0, role: $1) },
                acceptInvitation: { [weak self] in self?.engine?.accountAcceptInvitation(id: $0) },
                declineInvitation: { [weak self] in self?.engine?.accountDeclineInvitation(id: $0) }),
            forgetThisPhone: { [weak self] in self?.engine?.forgetThisPhone() },
            notifications: NotificationIntents(
                open: { [weak self] in self?.engine?.notificationOpen(id: $0) },
                dismissBanner: { [weak self] in self?.engine?.notificationDismissBanner() },
                markAllRead: { [weak self] in self?.engine?.notificationsMarkAllRead() },
                openSettings: { [weak self] in self?.engine?.notificationsOpenSettings() },
                closeSettings: { [weak self] in self?.engine?.notificationsCloseSettings() },
                setEnabled: { [weak self] in self?.engine?.notificationSetEnabled(category: $0, enabled: $1) }),
            remote: remoteIntents)
    }

    private let frames = RemoteFrames()

    private var remoteIntents: RemoteIntents {
        RemoteIntents(
            frames: frames,
            open: { [weak self] id in
                guard let self else { return }
                self.engine?.remoteOpen(systemId: id, sink: self.frames)
            },
            close: { [weak self] in self?.engine?.remoteClose() },
            submitPassword: { [weak self] in self?.engine?.remoteSubmitPassword(password: $0) },
            usePassword: { [weak self] in self?.engine?.remoteUsePassword() },
            pointer: { [weak self] in self?.engine?.remotePointer(pointer: $0) },
            text: { [weak self] in self?.engine?.remoteText(text: $0) },
            key: { [weak self] in self?.engine?.remoteKey(key: $0) },
            sendClipboard: { [weak self] in
                self?.engine?.remoteSendClipboard(text: UIPasteboard.general.string ?? "")
            },
            copyClipboard: { [weak self] in
                UIPasteboard.general.string = $0
                self?.engine?.remoteClipboardTaken()
            },
            clipboardTaken: { [weak self] in self?.engine?.remoteClipboardTaken() },
            dismissNote: { [weak self] in self?.engine?.remoteDismissNote() })
    }

    private var engine: Engine? { core?.engine() }

    func askForNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { allowed, _ in
            guard allowed else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func registerPushToken(_ token: String) {
        engine?.registerPushToken(token: token)
    }

    /// A tapped push, with what the server put next to its alert.
    func openPush(category: String, notificationId: Int64?) {
        if let notificationId { engine?.notificationOpen(id: notificationId) }
        tab = tabFor(notificationDestination(category: category), connected: view?.connection != nil)
    }
    private var lastBiometric: UInt64 = 0

    /// Runs the phone's own check. The core only asks for the value if this says yes.
    func confirmIdentityIfAsked(_ view: AppView) {
        guard let request = view.vault.biometric, request.id != lastBiometric else { return }
        lastBiometric = request.id
        let id = request.id
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
            engine?.biometricResult(id: id, confirmed: false)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: request.reason) { [weak self] ok, _ in
            Task { @MainActor in self?.engine?.biometricResult(id: id, confirmed: ok) }
        }
    }

    private var gitIntents: GitIntents {
        GitIntents(
            openDiff: { [weak self] in self?.engine?.openGitDiff(path: $0, group: $1) },
            closeDiff: { [weak self] in self?.engine?.closeGitDiff() },
            openBranches: { [weak self] in self?.engine?.openGitBranches() },
            closeBranches: { [weak self] in self?.engine?.closeGitBranches() },
            stage: { [weak self] in self?.engine?.gitStage(paths: $0) },
            unstage: { [weak self] in self?.engine?.gitUnstage(paths: $0) },
            discard: { [weak self] in self?.engine?.gitDiscard(path: $0, group: $1) },
            commit: { [weak self] in self?.engine?.gitCommit(message: $0, push: $1) },
            fetch: { [weak self] in self?.engine?.gitFetch() },
            pull: { [weak self] in self?.engine?.gitPull() },
            push: { [weak self] in self?.engine?.gitPush() },
            checkout: { [weak self] in self?.engine?.gitCheckout(name: $0) },
            createBranch: { [weak self] in self?.engine?.gitCreateBranch(name: $0) },
            deleteBranch: { [weak self] in self?.engine?.gitDeleteBranch(name: $0) },
            stashPush: { [weak self] in self?.engine?.gitStashPush(message: $0) },
            stashPop: { [weak self] in self?.engine?.gitStashPop(reference: $0) },
            stashDrop: { [weak self] in self?.engine?.gitStashDrop(reference: $0) },
            resolve: { [weak self] in self?.engine?.gitResolve(path: $0, pick: $1) },
            abort: { [weak self] in self?.engine?.gitAbort() })
    }

    func scene(_ phase: ScenePhase) {
        switch phase {
        case .active: core?.lifecycle(change: .foregrounded)
        case .background: core?.lifecycle(change: .backgrounded(graceMs: backgroundGraceMs))
        default: break
        }
    }

    private func signIn() {
        guard let core, let url = URL(string: core.beginSignIn(deviceName: UIDevice.current.model).url)
        else { return }
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.runovahq.app") {
            [weak self] callback, _ in
            guard let callback else { return }
            Task { @MainActor in self?.core?.finishSignIn(url: callback.absoluteString) }
        }
        session.presentationContextProvider = self
        browser = session
        session.start()
    }
}

extension AppModel: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}

/// Called on the core's own threads.
private final class Listener: ViewListener {
    weak var model: AppModel?

    init(model: AppModel) { self.model = model }

    func onView(view: AppView) {
        Task { @MainActor [weak model] in
            model?.view = view
            model?.confirmIdentityIfAsked(view)
        }
    }
}
