import AuthenticationServices
import Security
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
            loadProcesses: { [weak self] in self?.core?.loadTerminalProcesses(sessionId: $0) })
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
        Task { @MainActor [weak model] in model?.view = view }
    }
}
