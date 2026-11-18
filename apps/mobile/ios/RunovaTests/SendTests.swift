import XCTest

@testable import Runova

/// Sending files from the phone (E113): how picks are grouped and named, and the screens drawn.
final class SendTests: XCTestCase {
    private let desk = SendTargetView(
        systemId: 5, name: "Sam's desk", platform: "windows", own: true, online: true, canReceive: true, reason: nil)
    private let laptop = SendTargetView(
        systemId: 6, name: "Travel laptop", platform: "macos", own: true, online: false, canReceive: false,
        reason: "Offline")

    private var sending: SendBatchView {
        SendBatchView(
            batchId: "b1", systemId: 5, title: "To Sam's desk", status: "Sending 2 of 3, 18 MB/s, about 1 min left",
            phase: .sending, fileCount: 3, filesDone: 1, filesFailed: 0, totalBytes: 7_000_000, sentBytes: 3_100_000,
            percent: 44, sizeLabel: "3 files, 6.7 MB", note: "For the trip",
            files: [
                SendFileView(
                    transferId: "t1", name: "IMG_2041.jpg", folder: "Holiday", sizeLabel: "2.4 MB", state: .done,
                    percent: 100, error: nil)
            ],
            moreFiles: 0, canCancel: true, canRetry: false, canDismiss: false)
    }

    private func staged(_ paths: String...) -> [StagedFile] {
        paths.enumerated().map { StagedFile(handle: "h\($0.offset)", path: $0.element, size: 1_200_000) }
    }

    func testAPickedFolderIsOneRowAndLooseFilesStandAlone() {
        let groups = stagedGroups(staged("report.pdf", "Holiday/beach.jpg", "Holiday/Day 2/pier.jpg", "notes.txt"))

        XCTAssertEqual(groups.map(\.title), ["report.pdf", "Holiday", "notes.txt"])
        XCTAssertEqual(groups[1].files.count, 2)
        XCTAssertTrue(groups[1].folder)
        XCTAssertFalse(groups[0].folder)
    }

    func testEachFileLeadsWithATileForWhatItIs() {
        XCTAssertEqual(sendKind("IMG_1.HEIC").icon, RunovaIcons.image)
        XCTAssertEqual(sendKind("clip.mov").icon, RunovaIcons.video)
        XCTAssertEqual(sendKind("report.pdf").icon, RunovaIcons.logs)
        XCTAssertEqual(sendKind("archive.zip").icon, RunovaIcons.stash)
        XCTAssertEqual(sendKind("LICENSE").icon, RunovaIcons.file)
    }

    func testTheButtonSaysWhatGoesWhere() {
        XCTAssertEqual(sendButtonLabel(count: 0, computer: "Sam's desk"), "Send")
        XCTAssertEqual(sendButtonLabel(count: 3, computer: "Sam's desk"), "Send 3 files to Sam's desk")
    }

    func testPicksAreNotStagedTwice() {
        let picks = SendPicks()
        picks.add(staged("a.jpg", "b.jpg"))
        picks.add(staged("a.jpg"))

        XCTAssertEqual(picks.files.count, 2)
        picks.remove(["h0"])
        XCTAssertEqual(picks.files.map(\.path), ["b.jpg"])
    }

    @MainActor
    func testTheSendScreenDraws() throws {
        var intents = AppIntents()
        intents.send.picks.open = true
        let screen = SendScreen(
            targets: [desk, laptop], batches: [sending], error: nil, active: 1,
            progressLabel: "Sending to Sam's desk, 44%", progressPercent: 44)
        try renderSnapshot(fixtureView(send: screen), "send-progress", intents: intents)
    }

    @MainActor
    func testTheSystemsTabShowsASendGoing() throws {
        let screen = SendScreen(
            targets: [desk], batches: [sending], error: nil, active: 1, progressLabel: "Sending to Sam's desk, 44%",
            progressPercent: 44)
        try renderSnapshot(fixtureView(send: screen), "send-systems")
    }
}
