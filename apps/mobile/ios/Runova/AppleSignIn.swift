import AuthenticationServices
import UIKit

/// What the Sign in with Apple sheet came back with (E117).
enum AppleSignInResult: Equatable {
    /// The identity token and authorization code for the core to send, and the person's name, which
    /// Apple gives only the first time.
    case signedIn(identityToken: String, authorizationCode: String?, name: String?)
    case cancelled
    case failed(String)
}

/// Shows the Sign in with Apple sheet, with the core's nonce in the request.
@MainActor
protocol AppleSignInProvider {
    func signIn(nonce: String) async -> AppleSignInResult
}

/// Answers one nonce the core put in the view: the sheet, then the token back to the core, or a
/// cancel. A platform failure cancels quietly, as closing the sheet does.
@MainActor
struct AppleSignInPrompt {
    let provider: AppleSignInProvider
    let finish: (_ nonce: String, _ identityToken: String, _ authorizationCode: String?, _ name: String?) -> Void
    let cancel: () -> Void

    func answer(nonce: String) async {
        switch await provider.signIn(nonce: nonce) {
        case .signedIn(let token, let code, let name): finish(nonce, token, code, name)
        case .cancelled, .failed: cancel()
        }
    }
}

/// "First Last" from the name Apple gives the first time, or nil when it gave none.
func appleDisplayName(_ components: PersonNameComponents?) -> String? {
    guard let components else { return nil }
    let name = [components.givenName, components.familyName]
        .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    return name.isEmpty ? nil : name
}

/// Sign in with Apple through AuthenticationServices. Needs the Sign in with Apple capability
/// (`com.apple.developer.applesignin`) on the app.
@MainActor
final class AuthenticationServicesAppleSignIn: NSObject, AppleSignInProvider {
    private var waiting: CheckedContinuation<AppleSignInResult, Never>?

    func signIn(nonce: String) async -> AppleSignInResult {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return await withCheckedContinuation { continuation in
            waiting = continuation
            controller.performRequests()
        }
    }

    private func finish(_ result: AppleSignInResult) {
        waiting?.resume(returning: result)
        waiting = nil
    }
}

extension AuthenticationServicesAppleSignIn: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        let result: AppleSignInResult
        if let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let token = credential.identityToken.map({ String(decoding: $0, as: UTF8.self) })
        {
            result = .signedIn(
                identityToken: token,
                authorizationCode: credential.authorizationCode.map { String(decoding: $0, as: UTF8.self) },
                name: appleDisplayName(credential.fullName))
        } else {
            result = .failed("no identity token")
        }
        Task { @MainActor in self.finish(result) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let result: AppleSignInResult =
            (error as? ASAuthorizationError)?.code == .canceled ? .cancelled : .failed(error.localizedDescription)
        Task { @MainActor in self.finish(result) }
    }
}

extension AuthenticationServicesAppleSignIn: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
