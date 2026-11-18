import XCTest

@testable import Runova

/// Files sent to the phone (E114): the question over any screen, and what came in.
final class ReceiveTests: XCTestCase {
    private var offer: IncomingOfferView {
        IncomingOfferView(
            id: "r1", from: "Sam's desk", person: "Sam", title: "Sam's desk wants to send you 3 files",
            sizeLabel: "3 files, 4.2 MB", note: "Slides for tomorrow",
            files: [
                OfferFileView(name: "deck.pdf", folder: nil, sizeLabel: "3.1 MB"),
                OfferFileView(name: "beach.jpg", folder: "Holiday", sizeLabel: "1.0 MB"),
            ],
            moreFiles: 0)
    }

    private var received: ReceivedBatchView {
        ReceivedBatchView(
            id: "r2", title: "From Sam's desk", status: "Received 1 file, 1.1 MB, verified", phase: .done,
            fileCount: 1, filesDone: 1, filesFailed: 0, totalBytes: 1_100_000, receivedBytes: 1_100_000,
            percent: 100, sizeLabel: "1 file, 1.1 MB", note: nil,
            files: [
                ReceivedFileView(
                    transferId: "f0", name: "report.pdf", folder: nil, sizeLabel: "1.1 MB", state: .done,
                    percent: 100, path: "/tmp/report.pdf", error: nil)
            ],
            moreFiles: 0, canCancel: false, canDismiss: true)
    }

    private func screen(offers: [IncomingOfferView] = [], batches: [ReceivedBatchView] = []) -> ReceiveScreen {
        ReceiveScreen(
            enabled: true, autoAccept: false, ready: true, offers: offers, batches: batches, active: 0,
            progressLabel: nil, progressPercent: 0)
    }

    @MainActor
    func testTheQuestionComesUpOverTheSystemsTab() throws {
        try renderSnapshot(fixtureView(receive: screen(offers: [offer])), "receive-offer")
    }

    @MainActor
    func testWhatCameInIsListedWithTheSettings() throws {
        var intents = AppIntents()
        intents.send.picks.open = true
        try renderSnapshot(fixtureView(receive: screen(batches: [received])), "receive-list", intents: intents)
    }
}
