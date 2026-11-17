import SwiftUI
import XCTest

@testable import Runova

/// The keypad as the core sends it. The same fixtures as `Fixtures.kt` on Android.
func lockEntry(
    kind: PasscodeKind = .pin4, filled: UInt8 = 0, title: String = "Enter your passcode", error: String? = nil,
    shake: UInt64 = 0, waitSeconds: UInt32 = 0
) -> PasscodeEntryView {
    let length: UInt8 = kind == .pin4 ? 4 : kind == .pin6 ? 6 : 0
    return PasscodeEntryView(
        kind: kind, length: length, filled: filled, title: title, error: error, shake: shake, busy: false,
        waitSeconds: waitSeconds)
}

let noLock = LockScreen(
    enabled: false, locked: false, entry: lockEntry(), biometricLabel: nil, biometricKind: .none, biometric: nil,
    confirmForgot: false)

func lockedScreen(
    entry: PasscodeEntryView = lockEntry(), biometricLabel: String? = nil, biometricKind: BiometricKind = .none,
    confirmForgot: Bool = false
) -> LockScreen {
    LockScreen(
        enabled: true, locked: true, entry: entry, biometricLabel: biometricLabel, biometricKind: biometricKind,
        biometric: nil, confirmForgot: confirmForgot)
}

private let autoLockLabels: [(AutoLock, String)] = [
    (.immediately, "Right away"), (.oneMinute, "After 1 minute"), (.fiveMinutes, "After 5 minutes"),
    (.oneHour, "After 1 hour"), (.fiveHours, "After 5 hours"),
]

func passcodeScreen(
    open: Bool = true, step: PasscodeStep = .off, entry: PasscodeEntryView = lockEntry(title: ""),
    autoLock: AutoLock = .oneMinute, biometricLabel: String? = nil, biometricKind: BiometricKind = .none,
    biometricOn: Bool = false
) -> PasscodeSettingsScreen {
    PasscodeSettingsScreen(
        open: open, step: step, entry: entry, autoLock: autoLock,
        autoLockLabel: autoLockLabels.first { $0.0 == autoLock }!.1,
        autoLockChoices: autoLockLabels.map { AutoLockChoice(value: $0.0, label: $0.1) },
        biometricLabel: biometricLabel, biometricKind: biometricKind, biometricOn: biometricOn)
}

let noPasscode = passcodeScreen(open: false)

/// The same states and file names as `LockScreenTest.kt` and `PasscodeSettingsTest.kt`.
@MainActor
final class LockTests: XCTestCase {
    private let account = AccountScreen(
        profile: ProfileView(name: "Sam", email: "sam@example.com", twoFactor: true), loading: false, sessions: [],
        activity: [], teams: [], invitations: [], team: nil, stepUp: nil)

    private func render(
        lock: LockScreen = noLock, passcode: PasscodeSettingsScreen = noPasscode, _ name: String, dark: Bool = true
    ) throws {
        try renderSnapshot(
            fixtureView(account: account, lock: lock, passcode: passcode), name, tab: "account", dark: dark)
    }

    func testLockPin() throws { try render(lock: lockedScreen(entry: lockEntry(filled: 2)), "lock-pin") }

    func testLockSixDigitsLight() throws {
        try render(lock: lockedScreen(entry: lockEntry(kind: .pin6, filled: 4)), "lock-pin6-light", dark: false)
    }

    func testLockBiometric() throws {
        try render(lock: lockedScreen(biometricLabel: "Face ID", biometricKind: .face), "lock-biometric")
    }

    func testLockWait() throws {
        try render(
            lock: lockedScreen(entry: lockEntry(error: "Try again in 0:28", shake: 5, waitSeconds: 28)), "lock-wait")
    }

    func testLockPassword() throws {
        try render(
            lock: lockedScreen(entry: lockEntry(kind: .password, title: "Enter your password")), "lock-password")
    }

    func testLockForgot() throws { try render(lock: lockedScreen(confirmForgot: true), "lock-forgot") }

    func testPasscodeOff() throws { try render(passcode: passcodeScreen(step: .off), "passcode-off") }

    func testPasscodeChoose() throws {
        try render(
            passcode: passcodeScreen(step: .choose, entry: lockEntry(filled: 1, title: "Choose a passcode")),
            "passcode-choose")
    }

    func testPasscodeOn() throws {
        let on = LockScreen(
            enabled: true, locked: false, entry: lockEntry(), biometricLabel: nil, biometricKind: .none,
            biometric: nil, confirmForgot: false)
        try render(
            lock: on,
            passcode: passcodeScreen(
                step: .on, entry: lockEntry(kind: .pin6, title: ""), biometricLabel: "Face ID", biometricKind: .face),
            "passcode-on")
        try render(lock: on, passcode: passcodeScreen(step: .on), "passcode-on-light", dark: false)
    }

    func testTheAccountTabHasASecurityRow() throws { try render("account-security") }
}

/// The app lock through the generated bindings, against the real core. Signed out, so no network.
final class AppLockBridgeTests: XCTestCase {
    private final class MemoryStore: SecureStore, @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: String] = [:]
        func get(key: String) -> String? { lock.withLock { values[key] } }
        func set(key: String, value: String) { lock.withLock { values[key] = value } }
        func remove(key: String) { lock.withLock { _ = values.removeValue(forKey: key) } }
    }

    private final class Views: ViewListener, @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [AppView] = []
        var first: AppView? { lock.withLock { seen.first } }
        func onView(view: AppView) { lock.withLock { seen.append(view) } }

        func until(_ label: String, _ check: (AppView) -> Bool) throws -> AppView {
            for _ in 0..<1000 {
                if let last = lock.withLock({ seen.last }), check(last) { return last }
                Thread.sleep(forTimeInterval: 0.01)
            }
            XCTFail("timed out waiting for \(label)")
            throw CancellationError()
        }
    }

    private func start(_ store: MemoryStore, _ views: Views) throws -> RunovaCore {
        try RunovaCore(
            config: CoreConfig(site: "https://runovahq.test", platform: "ios", appVersion: "1.0.0"),
            secure: store, listener: views)
    }

    func testAPasscodeSetThroughTheBindingsLocksTheNextStart() throws {
        let store = MemoryStore()
        let views = Views()
        let core = try start(store, views)
        let engine = core.engine()

        engine.passcodeOpen()
        engine.passcodeStart(kind: .pin4)
        for digit: UInt8 in [2, 4, 6, 8] { engine.passcodeKey(digit: digit) }
        _ = try views.until("the second entry") { $0.passcode.step == .confirm }
        for digit: UInt8 in [2, 4, 6, 8] { engine.passcodeKey(digit: digit) }
        let on = try views.until("the lock on") { $0.passcode.step == .on }

        XCTAssertTrue(on.lock.enabled)
        XCTAssertFalse(on.lock.locked)
        let saved = try XCTUnwrap(store.get(key: "app-lock"))
        XCTAssertTrue(saved.contains("scrypt$"))
        XCTAssertFalse(saved.contains("\"2468\""))

        let again = Views()
        let restarted = try start(store, again)
        _ = try again.until("the first view") { _ in true }
        let first = try XCTUnwrap(again.first)
        XCTAssertTrue(first.lock.locked)
        XCTAssertEqual(first.lock.entry.length, 4)

        for digit: UInt8 in [2, 4, 6, 8] { restarted.engine().lockKey(digit: digit) }
        _ = try again.until("unlocked") { !$0.lock.locked }
        _ = core
    }
}
