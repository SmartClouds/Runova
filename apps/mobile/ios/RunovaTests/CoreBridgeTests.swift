import XCTest
@testable import Runova

/// Swift calling the real Rust core through the generated bindings.
final class CoreBridgeTests: XCTestCase {
    private let device = DeviceDetails(
        deviceId: "4b2c0c0e-1111-4222-8333-944444444444",
        name: "Runova app",
        platform: "ios",
        appVersion: "1.0.0"
    )

    func testTheCoreAnswersWithItsVersion() {
        XCTAssertFalse(coreVersion().isEmpty)
    }

    func testASignInLinkComesBackAsATypedRecord() {
        let link = beginPhoneSignIn(site: "https://runovahq.com", device: device)

        XCTAssertTrue(link.url.contains("client_id=runova-mobile"))
        XCTAssertEqual(link.verifier.count, 43)
    }

    func testATypedErrorCrossesTheBridge() {
        let declined = "com.runovahq.app:/auth/callback?error=access_denied&state=s-12345678"

        XCTAssertThrowsError(try finishBrowserCallback(url: declined, expectedState: "s-12345678")) { error in
            XCTAssertEqual(error as? CoreError, .SignInDeclined)
        }
    }
}
