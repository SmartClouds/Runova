import XCTest

@testable import Runova

/// Continue with Apple through the phone's own sheet (E117): the nonce goes in, the token, code
/// and first-time name come back to the core, and a closed sheet cancels.
@MainActor
final class ProviderSignInTests: XCTestCase {
    func testTheSheetsAnswerGoesToTheCoreWithItsNonce() async {
        var calls: [String] = []
        let fake = FakeAppleSignIn(
            result: .signedIn(identityToken: "eyJ", authorizationCode: "code-1", name: "Sam Apple"))
        let prompt = AppleSignInPrompt(
            provider: fake,
            finish: { nonce, token, code, name in calls.append("finish \(nonce) \(token) \(code ?? "-") \(name ?? "-")") },
            cancel: { calls.append("cancel") })

        await prompt.answer(nonce: "nonce-1")

        XCTAssertEqual(fake.nonces, ["nonce-1"])
        XCTAssertEqual(calls, ["finish nonce-1 eyJ code-1 Sam Apple"])
    }

    func testClosingTheSheetOrAFailureCancels() async {
        for result in [AppleSignInResult.cancelled, .failed("not set up")] {
            var calls: [String] = []
            let prompt = AppleSignInPrompt(
                provider: FakeAppleSignIn(result: result), finish: { _, _, _, _ in calls.append("finish") },
                cancel: { calls.append("cancel") })

            await prompt.answer(nonce: "nonce-1")

            XCTAssertEqual(calls, ["cancel"])
        }
    }

    func testTheNameIsTheGivenAndFamilyNameOrNothing() {
        var full = PersonNameComponents()
        full.givenName = "Sam"
        full.familyName = "Apple"
        var empty = PersonNameComponents()
        empty.givenName = " "

        XCTAssertEqual(appleDisplayName(full), "Sam Apple")
        XCTAssertNil(appleDisplayName(empty))
        XCTAssertNil(appleDisplayName(nil))
    }

    func testTheViewCarriesTheSheetAndTheBrowserHint() {
        let view = appView(
            auth: .signedOut, providerSignIn: ProviderSignInView(provider: "apple", nonce: "nonce-1", clientId: nil),
            continueInBrowser: "google")

        XCTAssertEqual(view.providerSignIn?.nonce, "nonce-1")
        XCTAssertEqual(view.continueInBrowser, "google")
    }
}

@MainActor
final class FakeAppleSignIn: AppleSignInProvider {
    let result: AppleSignInResult
    private(set) var nonces: [String] = []

    init(result: AppleSignInResult) { self.result = result }

    func signIn(nonce: String) async -> AppleSignInResult {
        nonces.append(nonce)
        return result
    }
}
