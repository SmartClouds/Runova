import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `ScreensTest.kt`, for the comparison with Android.
@MainActor
final class ScreensTests: XCTestCase {
    private func system(_ id: Int64, _ name: String, online: Bool = true, canManage: Bool = true) -> SystemView {
        SystemView(
            id: id, remoteId: "111222333", name: name, platform: "windows", online: online, own: true,
            canManage: canManage)
    }

    private var systems: [SystemView] {
        [system(1, "Sam's desk"), system(2, "Build server", online: false), system(3, "Office PC", canManage: false)]
    }

    private func view(
        auth: AuthState = .signedIn, systems list: [SystemView]? = nil, connection: ConnectionView? = nil,
        projects: [ProjectView] = [], error: String? = nil
    ) -> AppView {
        AppView(
            auth: auth, hubConnected: true, systems: list ?? systems, systemsLoading: false,
            connection: connection, projects: projects, projectsLoading: false, error: error)
    }

    private func connection(_ phase: ConnectionPhase, error: String? = nil) -> ConnectionView {
        let connected = phase == .connected
        return ConnectionView(
            systemId: 1, systemName: "Sam's desk", phase: phase, safetyCode: connected ? "483921" : nil,
            direct: connected ? true : nil, error: error)
    }

    private func render(_ view: AppView, _ name: String, dark: Bool = true) throws {
        let root = RunovaTheme(dark: dark) {
            AppRoot(view: view, tab: .constant("systems"), intents: AppIntents())
        }
        let controller = UIHostingController(rootView: root.ignoresSafeArea())
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
        let folder = ProcessInfo.processInfo.environment["SNAPSHOT_OUTPUT"] ?? NSTemporaryDirectory()
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData())
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }

    func testSignIn() throws { try render(view(auth: .signedOut, systems: []), "sign-in") }

    func testSystemsDark() throws { try render(view(), "systems-dark") }

    func testSystemsLight() throws { try render(view(), "systems-light", dark: false) }

    func testWaitingForApproval() throws {
        try render(view(connection: connection(.waitingForApproval)), "waiting-for-approval")
    }

    func testConnectionFailed() throws {
        try render(view(connection: connection(.failed, error: "This computer is offline.")), "connection-failed")
    }

    func testProjects() throws {
        let project = ProjectView(
            id: "p1", name: "Website", tags: ["web", "astro"], pinned: true, hasRepository: true,
            iconBgColor: nil, iconColor: nil)
        try render(view(connection: connection(.connected), projects: [project]), "projects")
    }

    func testKeychainRoundTrip() {
        let store = KeychainStore()
        store.remove(key: "test-key")

        store.set(key: "test-key", value: "one")
        store.set(key: "test-key", value: "two")

        XCTAssertEqual(store.get(key: "test-key"), "two")
        store.remove(key: "test-key")
        XCTAssertNil(store.get(key: "test-key"))
    }
}
