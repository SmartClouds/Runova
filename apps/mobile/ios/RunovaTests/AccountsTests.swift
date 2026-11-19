import SwiftUI
import XCTest

@testable import Runova

/// One account on the phone (E118). The same fixtures as `Fixtures.kt` on Android.
func accountItem(
    id: Int64, name: String, email: String, initials: String, tone: UInt8 = 0, active: Bool = false,
    needsSignIn: Bool = false, lastUsed: String? = nil
) -> AccountItem {
    AccountItem(
        id: id, name: name, email: email, initials: initials, tone: tone, active: active, needsSignIn: needsSignIn,
        lastUsed: lastUsed ?? (active ? "In use" : "Used 2d ago"))
}

let workAccount = accountItem(id: 11, name: "Sam Rivera", email: "sam@work.test", initials: "SR", tone: 5)
let homeAccount = accountItem(id: 22, name: "Sam", email: "sam@home.test", initials: "S", tone: 4, active: true)

/// A phone with one account, which is how every screen test before E118 ran.
let noAccounts = AccountsView(items: [], adding: false, switching: nil, reauth: nil, pushLabels: [])

private let bothLabels = [
    PushLabelView(tag: "work-tag-123", label: "sam@work.test"),
    PushLabelView(tag: "home-tag-456", label: "sam@home.test"),
]

/// The work and the home account, with home in use, and what changes on top of that.
func twoAccounts(adding: Bool = false, switching: AccountItem? = nil) -> AccountsView {
    AccountsView(
        items: [workAccount, homeAccount], adding: adding, switching: switching, reauth: nil, pushLabels: bothLabels)
}

/// Several accounts on the phone (E118): the header, the switcher, managing them, adding one. The
/// same states and file names as `AccountsTest.kt`.
@MainActor
final class AccountsTests: XCTestCase {
    private let home = AccountScreen(
        profile: ProfileView(name: "Sam", email: "sam@home.test", twoFactor: true), loading: false, sessions: [],
        activity: [], teams: [], invitations: [], team: nil, stepUp: nil)

    private let desk = SystemView(
        id: 5, remoteId: "111222333", name: "Sam's desk", platform: "windows", online: true, own: true,
        canManage: true)

    private let oneAccount = AccountsView(
        items: [homeAccount], adding: false, switching: nil, reauth: nil, pushLabels: [])

    /// Draws something over the app at a phone's size, as `renderSnapshot` does for the app alone.
    private func renderOver<Overlay: View>(
        _ view: AppView, _ name: String, tab: String = "account", dark: Bool = true,
        @ViewBuilder overlay: () -> Overlay
    ) throws {
        let drawn = overlay()
        let root = RunovaTheme(dark: dark) {
            ZStack {
                AppRoot(view: view, tab: .constant(tab), intents: AppIntents())
                drawn
            }
            .environment(\.runovaMotion, false)
        }
        let controller = UIHostingController(rootView: root.ignoresSafeArea())
        let bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
        let window = UIWindow(frame: bounds)
        window.rootViewController = controller
        window.isHidden = false
        controller.view.frame = bounds
        controller.view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            controller.view.drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        let folder = ProcessInfo.processInfo.environment["SNAPSHOT_OUTPUT"] ?? NSTemporaryDirectory()
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try XCTUnwrap(image.pngData())
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }

    func testTheHeaderShowsTheAccountInUseAndOpensTheSwitcher() throws {
        try renderSnapshot(fixtureView(account: home, accounts: twoAccounts()), "accounts-header", tab: "account")

        XCTAssertEqual(twoAccounts().current?.email, "sam@home.test")
        XCTAssertEqual(accountsHeaderLabel(twoAccounts()), "Accounts, 2 on this phone")
        XCTAssertEqual(accountRowLabel(homeAccount, active: true), "Sam, sam@home.test, current account")
    }

    func testTheSwitcherDrawsInTheDarkAndTheLight() throws {
        for (name, dark) in [("accounts-switcher", true), ("accounts-switcher-light", false)] {
            try renderOver(fixtureView(account: home, accounts: twoAccounts()), name, dark: dark) {
                AccountSwitcherSheet(accounts: twoAccounts(), intents: AccountsIntents(), onManage: {}, onClose: {})
            }
        }
    }

    func testAnotherAccountInTheListOffersToSwitchToIt() {
        XCTAssertEqual(accountRowLabel(workAccount, active: false), "Switch to Sam Rivera, sam@work.test")
    }

    func testWithOneAccountTheHeaderStillCountsIt() {
        XCTAssertEqual(accountsHeaderLabel(oneAccount), "Accounts, 1 on this phone")
        XCTAssertEqual(accountsHeaderLabel(noAccounts), "Accounts, 1 on this phone")
    }

    func testAddingShowsTheSignInScreenWithAWayBack() throws {
        try renderSnapshot(
            fixtureView(account: home, accounts: twoAccounts(adding: true)), "accounts-adding", tab: "account")

        XCTAssertEqual(addingLine(twoAccounts(adding: true)), "You'll stay signed in to sam@home.test.")
    }

    func testSwitchingShowsWhoItIsSwitchingTo() throws {
        try renderSnapshot(
            fixtureView(account: home, accounts: twoAccounts(switching: workAccount)), "accounts-switching",
            tab: "account")
    }

    func testTheManageScreenDraws() throws {
        try renderOver(fixtureView(account: home, accounts: twoAccounts()), "accounts-manage") {
            ManageAccountsScreen(accounts: twoAccounts(), intents: AccountsIntents(), onBack: {})
                // Covers the tabs drawn behind it, as the app does when it opens this screen.
                .background(RunovaTokens.dark.card.ignoresSafeArea())
        }
    }

    func testAnAccountWhoseSessionEndedAsksToSignInAgainAndOffersTheOthers() throws {
        let ended = accountItem(id: 22, name: "Sam", email: "sam@home.test", initials: "S", tone: 4, needsSignIn: true)
        let accounts = AccountsView(
            items: [workAccount, ended], adding: false, switching: nil, reauth: ended, pushLabels: [])
        try renderSnapshot(fixtureView(auth: .signedOut, accounts: accounts), "accounts-signed-out")

        XCTAssertEqual(
            addingLine(accounts), "Your session for sam@home.test ended. Sign in again to keep using it.")
        XCTAssertEqual(signedOutOthers(accounts).map(\.id), [11])
    }

    func testTheSystemsAvatarShowsWithMoreThanOneAccount() throws {
        try renderSnapshot(fixtureView(systems: [desk], accounts: twoAccounts()), "accounts-systems")
    }

    func testWhatTheCoreSaysAboutASwitchShowsOverTheTabs() throws {
        try renderSnapshot(
            fixtureView(systems: [desk], notice: "Now using sam@home.test.", accounts: twoAccounts()),
            "accounts-notice")
    }

    func testWithSeveralAccountsSigningOutIsOfTheOneInUse() {
        var signedOut: Int64?
        var plain = false
        var intents = AppIntents()
        intents.signOut = { plain = true }
        intents.accounts.signOutOf = { signedOut = $0 }

        let several = signOutButton(twoAccounts(), intents: intents)
        XCTAssertEqual(several.text, "Sign out of sam@home.test")
        several.action()
        XCTAssertEqual(signedOut, 22)
        XCTAssertFalse(plain)

        let single = signOutButton(oneAccount, intents: intents)
        XCTAssertEqual(single.text, "Sign out")
        single.action()
        XCTAssertTrue(plain)
    }

    func testThePushLabelsAreAMapTheExtensionCanRead() {
        let labels = pushLabelMap(bothLabels)

        XCTAssertEqual(labels, ["work-tag-123": "sam@work.test", "home-tag-456": "sam@home.test"])
        XCTAssertEqual(PushAccountLabels.decode(PushAccountLabels.encode(labels)), labels)
        XCTAssertEqual(PushAccountLabels.decode(nil), [:])
        XCTAssertEqual(PushAccountLabels.decode("not json"), [:])
    }
}
