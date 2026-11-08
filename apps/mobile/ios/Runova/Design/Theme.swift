import SwiftUI
import UIKit

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = RunovaTokens.dark
}

extension EnvironmentValues {
    var palette: RunovaPalette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// A variable font at one weight. SwiftUI's own weight modifier does not reach a variable axis.
private func variable(name: String, size: CGFloat, weight: CGFloat) -> UIFont {
    let tag = 0x7767_6874  // 'wght'
    let descriptor = UIFontDescriptor(fontAttributes: [
        .name: name,
        kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [tag: weight],
    ])
    return UIFont(descriptor: descriptor, size: size)
}

struct RunovaTextStyle {
    let size: CGFloat
    let lineHeight: CGFloat
    let weight: CGFloat
    var tracking: CGFloat = -0.011
    var fontName = "Inter-Regular"

    var uiFont: UIFont { variable(name: fontName, size: size, weight: weight) }
    var font: Font { Font(uiFont) }
}

/// The desktop's type scale, the same as `Theme.kt`.
enum RunovaType {
    static let heading = RunovaTextStyle(size: 18, lineHeight: 24, weight: 600)
    static let title = RunovaTextStyle(size: 15, lineHeight: 20, weight: 600)
    static let body = RunovaTextStyle(size: 14, lineHeight: 20, weight: 400)
    static let label = RunovaTextStyle(size: 13, lineHeight: 18, weight: 500)
    static let small = RunovaTextStyle(size: 12, lineHeight: 16, weight: 400)
    static let caption = RunovaTextStyle(size: 11, lineHeight: 14, weight: 500)
    static let mono = RunovaTextStyle(
        size: 13, lineHeight: 17.5, weight: 400, tracking: 0, fontName: "JetBrainsMono-Regular")
}

enum RunovaShape {
    static let lg = RunovaTokens.radius
    static let md = RunovaTokens.radius - 2
    static let sm = RunovaTokens.radius - 4
    static let island = RunovaTokens.radius + 4
}

struct RunovaTheme<Content: View>: View {
    let dark: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .environment(\.palette, dark ? RunovaTokens.dark : RunovaTokens.light)
            .environment(\.colorScheme, dark ? .dark : .light)
    }
}
