import SwiftUI

@main
struct RunovaApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Root(model: model)
                .onAppear { model.start() }
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
