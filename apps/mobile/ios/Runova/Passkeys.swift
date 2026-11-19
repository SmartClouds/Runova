import AuthenticationServices
import UIKit

/// What the platform's passkey prompt came back with (E115).
enum PasskeyResult: Equatable {
    /// The WebAuthn answer as JSON, for the core to send.
    case answered(String)
    case cancelled
    /// The phone holds no passkey for Runova.
    case noPasskey
    case failed(String)
}

/// Shows the platform's passkey prompt for the core's WebAuthn request options.
@MainActor
protocol PasskeyProvider {
    func get(optionsJson: String) async -> PasskeyResult
}

/// Answers one passkey challenge the core put in the view: the prompt, then the answer back to
/// the core, or a cancel. A platform failure cancels quietly, as closing the prompt does.
@MainActor
struct PasskeyPrompt {
    let provider: PasskeyProvider
    let finish: (_ challengeId: String, _ credentialJson: String) -> Void
    let cancel: (_ noPasskey: Bool) -> Void

    func answer(challengeId: String, optionsJson: String) async {
        switch await provider.get(optionsJson: optionsJson) {
        case .answered(let json): finish(challengeId, json)
        case .noPasskey: cancel(true)
        case .cancelled, .failed: cancel(false)
        }
    }
}

/// The parts of `PublicKeyCredentialRequestOptions` AuthenticationServices takes.
struct PasskeyRequest: Equatable {
    let challenge: Data
    let relyingParty: String
    let allowedIds: [Data]

    init?(optionsJson: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(optionsJson.utf8)) as? [String: Any],
            let challenge = (object["challenge"] as? String).flatMap(base64UrlData),
            let relyingParty = object["rpId"] as? String
        else { return nil }
        self.challenge = challenge
        self.relyingParty = relyingParty
        allowedIds = (object["allowCredentials"] as? [[String: Any]] ?? [])
            .compactMap { ($0["id"] as? String).flatMap(base64UrlData) }
    }
}

func base64UrlData(_ text: String) -> Data? {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
}

func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// A passkey assertion as `PublicKeyCredential.toJSON()` writes it, which the server reads.
func assertionJson(
    credentialId: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userHandle: Data?
) -> String {
    let id = base64Url(credentialId)
    var response: [String: Any] = [
        "clientDataJSON": base64Url(clientDataJSON),
        "authenticatorData": base64Url(authenticatorData),
        "signature": base64Url(signature),
    ]
    response["userHandle"] = userHandle.map(base64Url) ?? NSNull()
    let object: [String: Any] = [
        "id": id, "rawId": id, "type": "public-key", "authenticatorAttachment": "platform",
        "clientExtensionResults": [String: Any](), "response": response,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

/// The phone's passkeys (iCloud Keychain or a password manager), and a nearby phone's by QR. Needs
/// `webcredentials:` for the site in the app's associated domains and the app in the site's
/// apple-app-site-association.
@MainActor
final class AuthenticationServicesPasskeys: NSObject, PasskeyProvider {
    private var waiting: CheckedContinuation<PasskeyResult, Never>?

    func get(optionsJson: String) async -> PasskeyResult {
        guard let request = PasskeyRequest(optionsJson: optionsJson) else { return .failed("unreadable options") }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.relyingParty)
        let assertion = provider.createCredentialAssertionRequest(challenge: request.challenge)
        assertion.userVerificationPreference = .required
        assertion.allowedCredentials = request.allowedIds.map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        let controller = ASAuthorizationController(authorizationRequests: [assertion])
        controller.delegate = self
        controller.presentationContextProvider = self
        return await withCheckedContinuation { continuation in
            waiting = continuation
            controller.performRequests()
        }
    }

    private func finish(_ result: PasskeyResult) {
        waiting?.resume(returning: result)
        waiting = nil
    }
}

extension AuthenticationServicesPasskeys: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        let result: PasskeyResult
        if let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            result = .answered(
                assertionJson(
                    credentialId: credential.credentialID, clientDataJSON: credential.rawClientDataJSON,
                    authenticatorData: credential.rawAuthenticatorData, signature: credential.signature,
                    userHandle: credential.userID))
        } else {
            result = .failed("not a passkey")
        }
        Task { @MainActor in self.finish(result) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let result: PasskeyResult
        switch (error as? ASAuthorizationError)?.code {
        case .canceled: result = .cancelled
        case .notInteractive: result = .noPasskey
        default: result = .failed(error.localizedDescription)
        }
        Task { @MainActor in self.finish(result) }
    }
}

extension AuthenticationServicesPasskeys: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
