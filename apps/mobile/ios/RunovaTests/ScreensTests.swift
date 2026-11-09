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
        fixtureView(
            auth: auth, systems: list ?? systems, connection: connection, projects: projects, error: error)
    }

    private func connection(_ phase: ConnectionPhase, error: String? = nil) -> ConnectionView {
        let connected = phase == .connected
        return ConnectionView(
            systemId: 1, systemName: "Sam's desk", phase: phase, safetyCode: connected ? "483921" : nil,
            direct: connected ? true : nil, error: error)
    }

    private func render(_ view: AppView, _ name: String, dark: Bool = true) throws {
        try renderSnapshot(view, name, dark: dark)
    }

    func testSignIn() throws { try render(view(auth: .signedOut, systems: []), "sign-in") }

    func testIntro() throws {
        try render(fixtureView(auth: .signedOut, showIntro: true), "intro-computers")
    }

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
