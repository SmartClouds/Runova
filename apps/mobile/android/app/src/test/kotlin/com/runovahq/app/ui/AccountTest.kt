package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.runovahq.app.design.RunovaTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import uniffi.runova_ffi.AccountScreen
import uniffi.runova_ffi.EncryptionItemView
import uniffi.runova_ffi.EncryptionScreen
import uniffi.runova_ffi.ActivityView
import uniffi.runova_ffi.MyInvitationView
import uniffi.runova_ffi.ProfileView
import uniffi.runova_ffi.RoleOptionView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.SessionView
import uniffi.runova_ffi.StepUpView
import uniffi.runova_ffi.TeamDetailView
import uniffi.runova_ffi.TeamInvitationView
import uniffi.runova_ffi.TeamMemberView
import uniffi.runova_ffi.TeamView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val sessions = listOf(
    SessionView(4, "Pixel", "Runova app, android", true),
    SessionView(9, "Sam's desk", "Runova desktop app, windows", false),
)
private val teams = listOf(TeamView(3, "Acme", "Owner", "owner", 2u))
private val invitations = listOf(MyInvitationView(7, "Beta", "Member", "Lee"))
private val team = TeamDetailView(
    3,
    "Acme",
    "owner",
    true,
    listOf(
        TeamMemberView(1, "Sam", "Owner", false, emptyList()),
        TeamMemberView(2, "Lee", "Member", true, listOf(RoleOptionView("admin", "Admin"), RoleOptionView("viewer", "Viewer"))),
    ),
    listOf(TeamInvitationView(5, "new@example.com", "Member")),
)

private fun account(team: TeamDetailView? = null, stepUp: StepUpView? = null) = AccountScreen(
    ProfileView("Sam", "sam@example.com", true),
    false,
    sessions,
    listOf(ActivityView(1, "signed in", "Pixel")),
    teams,
    invitations,
    team,
    stepUp,
)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class AccountTest {
    @get:Rule val compose = createComposeRule()

    private fun show(screen: AccountScreen, intents: AccountIntents = AccountIntents(), app: AppIntents = AppIntents(account = intents)) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(appView(account = screen), "account", {}, app) } }
    }

    private fun showEncryption(screen: EncryptionScreen, intents: AccountIntents = AccountIntents()) {
        compose.setContent {
            RunovaTheme(dark = true) { AppRoot(appView(account = account(), encryption = screen), "account", {}, AppIntents(account = intents)) }
        }
    }

    private val footnote = "Your connection to the server uses TLS either way."
    private val notifications = EncryptionItemView("notifications", "Notifications", "Only your phone can read them.", false, true)
    private val cloud = EncryptionItemView("sync", "Cloud sync", "Every record.", true, true)

    @Test
    fun eachItemHasItsOwnSwitch() {
        var changed: Pair<String, Boolean>? = null
        showEncryption(
            EncryptionScreen(listOf(notifications, cloud), null, null, footnote),
            AccountIntents(setEncryption = { item, on -> changed = item to on }),
        )
        snapshot("encryption")

        compose.onNodeWithText(footnote).assertExists()
        compose.onNode(hasContentDescription("Notifications")).performClick()

        assertEquals("notifications" to true, changed)
    }

    @Test
    fun aSwitchThePlanDoesNotCoverCanNotBeTurnedOn() {
        var changed = false
        val locked = notifications.copy(canChange = false)
        showEncryption(
            EncryptionScreen(listOf(locked), "Included with Go, Pro and Ultra. You are on Free.", null, footnote),
            AccountIntents(setEncryption = { _, _ -> changed = true }),
        )

        compose.onNodeWithText("Included with Go, Pro and Ultra. You are on Free.").assertExists()
        compose.onNode(hasContentDescription("Notifications")).performClick()

        assertEquals(false, changed)
    }

    @Test
    fun aDowngradeIsExplained() {
        val warning = "Your plan no longer includes encryption, so Notifications went back to normal."
        showEncryption(EncryptionScreen(listOf(notifications), null, warning, footnote))

        compose.onNodeWithText(warning).assertExists()
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theAccountShowsWhoAndWhere() {
        show(account())

        compose.onNodeWithText("sam@example.com").assertExists()
        compose.onNodeWithText("This phone").assertExists()
        compose.onNodeWithText("Sam's desk").assertExists()
        compose.onNodeWithText("Acme").assertExists()
        snapshot("account")
    }

    @Test
    fun itRefreshesOnlyWhileOnShow() {
        val sections = mutableListOf<Section?>()
        show(account(), app = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.ACCOUNT), sections)
    }

    @Test
    fun anotherSessionCanBeEnded() {
        var ended = 0L
        show(account(), AccountIntents(endSession = { ended = it }))

        compose.onNode(hasContentDescription("End Sam's desk")).performClick()

        assertEquals(9L, ended)
    }

    @Test
    fun allOthersGoThroughStepUp() {
        var asked = false
        show(account(), AccountIntents(endOtherSessions = { asked = true }))

        compose.onNodeWithText("End all other sessions").performClick()

        assertTrue(asked)
    }

    @Test
    fun stepUpTakesAPasswordAndCanBeCancelled() {
        var sent: Pair<String?, String?>? = null
        var cancelled = false
        show(
            account(stepUp = StepUpView("End all other sessions?", "Enter your password.", "That password or code isn't right.")),
            AccountIntents(submitStepUp = { p, c -> sent = p to c }, cancelStepUp = { cancelled = true }),
        )

        compose.onNodeWithText("That password or code isn't right.").assertExists()
        snapshot("account-step-up")
        compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("pw")
        compose.onNodeWithText("Confirm").performClick()
        assertEquals("pw" to null, sent)
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(cancelled)
    }

    @Test
    fun anInvitationCanBeAcceptedOrDeclined() {
        var accepted = 0L
        var declined = 0L
        show(account(), AccountIntents(acceptInvitation = { accepted = it }, declineInvitation = { declined = it }))

        compose.onNodeWithText("Accept").performClick()
        compose.onNodeWithText("Decline").performClick()

        assertEquals(7L, accepted)
        assertEquals(7L, declined)
    }

    @Test
    fun aTeamOpens() {
        var opened = 0L
        show(account(), AccountIntents(openTeam = { opened = it }))

        compose.onNodeWithText("Acme").performClick()

        assertEquals(3L, opened)
    }

    @Test
    fun aManagerCanInviteAndRemove() {
        var invited = ""
        var removed = 0L
        show(account(team), AccountIntents(invite = { email, _ -> invited = email }, removeMember = { removed = it }))

        compose.onNode(hasSetTextAction()).performTextInput("kim@example.com")
        compose.onNodeWithText("Invite").performClick()
        compose.onNodeWithText("Lee").performClick()
        compose.onNode(hasContentDescription("Remove Lee")).performClick()

        assertEquals("kim@example.com", invited)
        assertEquals(2L, removed)
        snapshot("account-team")
    }

    @Test
    fun aRoleCanBeChangedFromTheMember() {
        var changed: Pair<Long, String>? = null
        show(account(team), AccountIntents(setMemberRole = { id, role -> changed = id to role }))

        compose.onNodeWithText("Lee").performClick()
        compose.onNodeWithText("Make Admin").performClick()

        assertEquals(2L to "admin", changed)
        snapshot("account-team-member")
    }

    @Test
    fun anOrdinaryMemberSeesNoManagingControls() {
        show(account(team.copy(canManage = false, invitations = emptyList())))

        compose.onNodeWithText("Invite").assertDoesNotExist()
        compose.onAllNodesWithText("Remove").assertCountEquals(0)
    }

    @Test
    fun signOutRuns() {
        var signedOut = false
        show(account(), app = AppIntents(signOut = { signedOut = true }))

        compose.onNodeWithText("Sign out").performClick()

        assertTrue(signedOut)
    }
}
