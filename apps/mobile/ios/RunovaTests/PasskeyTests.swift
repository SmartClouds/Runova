import XCTest

@testable import Runova

/// Signing in with a passkey (E115): reading the core's options, writing the platform's answer as
/// WebAuthn JSON, and handing it to the core.
@MainActor
final class PasskeyTests: XCTestCase {
    private let options = #"{"challenge":"AQID","rpId":"runovahq.com","allowCredentials":[{"type":"public-key","id":"-_8B"}]}"#

    func testTheOptionsGiveTheChallengeRelyingPartyAndAllowedPasskeys() throws {
        let request = try XCTUnwrap(PasskeyRequest(optionsJson: options))

        XCTAssertEqual(request.challenge, Data([1, 2, 3]))
        XCTAssertEqual(request.relyingParty, "runovahq.com")
        XCTAssertEqual(request.allowedIds, [Data([0xfb, 0xff, 0x01])])
    }

    func testOptionsWithNoChallengeAreNothing() {
        XCTAssertNil(PasskeyRequest(optionsJson: #"{"rpId":"runovahq.com"}"#))
    }

    func testTheAnswerIsWrittenAsPublicKeyCredentialToJSON() throws {
        let json = assertionJson(
            credentialId: Data([0xfb, 0xff, 0x01]), clientDataJSON: Data([1, 2]), authenticatorData: Data([3]),
            signature: Data([4, 5]), userHandle: Data([0x34, 0x32]))

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["id"] as? String, "-_8B")
        XCTAssertEqual(object["rawId"] as? String, "-_8B")
        XCTAssertEqual(object["type"] as? String, "public-key")
        let response = try XCTUnwrap(object["response"] as? [String: Any])
        XCTAssertEqual(response["clientDataJSON"] as? String, "AQI")
        XCTAssertEqual(response["authenticatorData"] as? String, "Aw")
        XCTAssertEqual(response["signature"] as? String, "BAU")
        XCTAssertEqual(response["userHandle"] as? String, "NDI")
    }

    func testAnAnswerGoesToTheCoreWithItsChallenge() async {
        var calls: [String] = []
        let prompt = PasskeyPrompt(
            provider: FakePasskeys(result: .answered("{\"id\":\"AQI\"}")),
            finish: { id, answer in calls.append("finish \(id) \(answer)") },
            cancel: { calls.append("cancel \($0)") })

        await prompt.answer(challengeId: "challenge-1", optionsJson: options)

        XCTAssertEqual(calls, ["finish challenge-1 {\"id\":\"AQI\"}"])
    }

    func testClosingThePromptOrAFailureCancelsQuietly() async {
        for result in [PasskeyResult.cancelled, .failed("no association")] {
            var calls: [String] = []
            let prompt = PasskeyPrompt(
                provider: FakePasskeys(result: result), finish: { _, _ in calls.append("finish") },
                cancel: { calls.append("cancel \($0)") })

            await prompt.answer(challengeId: "challenge-1", optionsJson: options)

            XCTAssertEqual(calls, ["cancel false"])
        }
    }

    func testNoPasskeyOnThePhoneCancelsSoTheCoreCanExplain() async {
        var calls: [String] = []
        let prompt = PasskeyPrompt(
            provider: FakePasskeys(result: .noPasskey), finish: { _, _ in calls.append("finish") },
            cancel: { calls.append("cancel \($0)") })

        await prompt.answer(challengeId: "challenge-1", optionsJson: options)

        XCTAssertEqual(calls, ["cancel true"])
    }

    func testTheSignInScreenOffersAPasskey() throws {
        try renderSnapshot(fixtureView(auth: .signedOut), "sign-in-passkey")
        try renderSnapshot(
            fixtureView(auth: .signedOut, passkeySignIn: PasskeySignInView(challengeId: "", optionsJson: nil)),
            "sign-in-passkey-waiting")
    }
}

private struct FakePasskeys: PasskeyProvider {
    let result: PasskeyResult

    func get(optionsJson: String) async -> PasskeyResult { result }
}
