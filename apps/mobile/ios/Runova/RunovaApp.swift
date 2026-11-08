import SwiftUI

@main
struct RunovaApp: App {
    @Environment(\.colorScheme) private var scheme

    var body: some Scene {
        WindowGroup {
            RunovaTheme(dark: scheme == .dark) { KitGallery() }
        }
    }
}
