import SwiftUI
import XCTest

@testable import Runova

/// Renders the same screens as `KitTest.kt`, at the same size, for the comparison with Android.
@MainActor
final class KitSnapshotTests: XCTestCase {
    private func render(_ name: String, dark: Bool) throws {
        let controller = UIHostingController(
            rootView: RunovaTheme(dark: dark) { KitGallery() }.ignoresSafeArea())
        let bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
        let window = UIWindow(frame: bounds)
        window.rootViewController = controller
        window.isHidden = false
        controller.view.frame = bounds
        controller.view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            controller.view.drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        let data = try XCTUnwrap(image.pngData())

        let folder = ProcessInfo.processInfo.environment["SNAPSHOT_OUTPUT"]
            ?? NSTemporaryDirectory()
        try FileManager.default.createDirectory(
            atPath: folder, withIntermediateDirectories: true)
        try data.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        add(XCTAttachment(image: image))
    }

    func testGalleryDark() throws { try render("kit-dark", dark: true) }

    func testGalleryLight() throws { try render("kit-light", dark: false) }

    func testBundledFontsAreRegistered() {
        XCTAssertNotNil(UIFont(name: "Inter-Regular", size: 14))
        XCTAssertNotNil(UIFont(name: "JetBrainsMono-Regular", size: 13))
        XCTAssertNotNil(UIFont(name: "FontAwesome7Free-Solid", size: 16))
    }

    func testPalettesAreTheDesktops() {
        XCTAssertEqual(UIColor(RunovaTokens.dark.primary).cgColor.components?.prefix(3).map { Int(($0 * 255).rounded()) }, [0, 230, 115])
        XCTAssertEqual(UIColor(RunovaTokens.light.primary).cgColor.components?.prefix(3).map { Int(($0 * 255).rounded()) }, [0, 117, 59])
    }
}
