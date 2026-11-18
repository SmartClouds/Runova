import CoreImage
import XCTest

@testable import Runova

/// Recovery phrases on the phone (E108): the saved file, the QR code drawn here, and the screens.
final class RecoveryPhrasesTests: XCTestCase {
    private let words =
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
        .split(separator: " ").map(String.init)

    private var shown: RevealedPhraseView {
        RevealedPhraseView(
            id: "p2", label: "Vault: work laptop", words: words,
            qrPayload: "RUNOVA-PHRASE:1:vault:VmF1bHQ6IHdvcmsgbGFwdG9w:" + words.joined(separator: " "),
            canUnlockVault: true, fileName: "Runova recovery phrase - Vault work laptop.txt")
    }

    private func screen(revealed: RevealedPhraseView? = nil) -> RecoveryPhrasesScreen {
        RecoveryPhrasesScreen(
            items: [
                RecoveryPhraseItem(id: "p1", label: "Personal sync", opens: "Synced data", saved: "Saved 2d ago"),
                RecoveryPhraseItem(
                    id: "p2", label: "Vault: work laptop", opens: "The Vault on a computer", saved: "Saved just now"),
            ],
            revealed: revealed, biometric: nil, confirmDelete: nil, notice: "Saved Personal sync.", error: nil)
    }

    func testTheSavedFileNumbersTheWordsInRowsOfFour() {
        let text = phraseFileText(shown)

        XCTAssertTrue(text.hasPrefix("Runova recovery phrase\n"))
        XCTAssertTrue(text.contains(" 1. legal    2. winner    3. thank    4. year"))
        XCTAssertTrue(text.contains("24. title"))
        XCTAssertTrue(text.contains("Anyone who has these words"))
    }

    func testTheCodeDrawnHereReadsBackAsThePhrase() throws {
        let image = try XCTUnwrap(qrImage(shown.qrPayload))
        let detector = try XCTUnwrap(
            CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let found = detector.features(in: try XCTUnwrap(CIImage(image: image))).compactMap {
            ($0 as? CIQRCodeFeature)?.messageString
        }
        XCTAssertEqual(found, [shown.qrPayload])
    }

    @MainActor
    func testTheAccountRowDraws() throws {
        try renderSnapshot(appView(recoveryPhrases: screen()), "recovery_phrases_account", tab: "account")
    }
}
