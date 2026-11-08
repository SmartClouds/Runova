import SwiftUI
import XCTest

@testable import Runova

/// The same fixtures and file names as `RemoteTest.kt`, for the comparison with Android.
@MainActor
final class RemoteTests: XCTestCase {
    private func remote(_ phase: RemotePhase, error: String? = nil, canUsePassword: Bool = false) -> RemoteView {
        RemoteView(
            systemId: 1, systemName: "Sam's desk", phase: phase, error: error, canUsePassword: canUsePassword,
            agent: false, width: 1280, height: 720, direct: false, safetyCode: "483921", clipboard: nil, note: nil)
    }

    func testRemoteConnecting() throws {
        try renderSnapshot(fixtureView(remote: remote(.requesting)), "remote-connecting")
    }

    func testRemoteWaiting() throws {
        try renderSnapshot(fixtureView(remote: remote(.waitingForApproval, canUsePassword: true)), "remote-waiting")
    }

    func testRemotePassword() throws {
        try renderSnapshot(
            fixtureView(remote: remote(.needsPassword, error: "That password is not the one for this computer.")),
            "remote-password")
    }

    func testRemoteFailed() throws {
        try renderSnapshot(
            fixtureView(remote: remote(.failed, error: "The connection to this computer ended.")), "remote-failed")
    }

    func testRemoteLive() throws {
        try renderSnapshot(fixtureView(remote: remote(.live)), "remote-live")
    }

    func testFitContentKeepsTheScreensProportions() {
        let rect = fitContent(
            boxWidth: 400, boxHeight: 800, screenWidth: 1600, screenHeight: 900, zoom: 1, panX: 0, panY: 0)
        XCTAssertEqual(rect, ContentRect(left: 0, top: 287.5, width: 400, height: 225))
    }

    func testAPointIsNormalizedToTheScreen() {
        let rect = ContentRect(left: 0, top: 287.5, width: 400, height: 225)
        let middle = rect.normalized(CGPoint(x: 200, y: 400))
        XCTAssertEqual(middle.x, 0.5, accuracy: 0.0001)
        XCTAssertEqual(middle.y, 0.5, accuracy: 0.0001)
        let outside = rect.normalized(CGPoint(x: -5, y: 900))
        XCTAssertEqual(outside.x, 0)
        XCTAssertEqual(outside.y, 1)
    }
}
