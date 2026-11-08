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
