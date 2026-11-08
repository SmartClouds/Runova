import SwiftUI
import UserNotifications

@main
struct RunovaApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Root(model: model)
                .onAppear {
                    push.model = model
                    model.start()
                    model.askForNotifications()
                }
                .onChange(of: phase) { model.scene($0) }
                .overlay {
                    // iOS has no way to refuse a screenshot, but the app switcher can show this instead.
                    if phase != .active && model.view?.vault.onShow == true {
                        RunovaTokens.dark.background.ignoresSafeArea()
                    }
                }
        }
    }
}

/// Where iOS delivers the push token and any push the user taps.
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in self.model?.registerPushToken(token) }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if let category = info["category"] as? String {
            let id = (info["notificationId"] as? String).flatMap(Int64.init) ?? (info["notificationId"] as? Int64)
            Task { @MainActor in self.model?.openPush(category: category, notificationId: id) }
        }
        completionHandler()
    }
}

private struct Root: View {
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        RunovaTheme(dark: scheme == .dark) {
            if let view = model.view {
                AppRoot(view: view, tab: $model.tab, intents: model.intents)
            } else {
                StartingScreen()
            }
        }
    }
}
