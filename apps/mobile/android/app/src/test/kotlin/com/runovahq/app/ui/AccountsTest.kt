package com.runovahq.app.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
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
import uniffi.runova_ffi.AccountsView
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.ProfileView
import uniffi.runova_ffi.SystemView

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val home = AccountScreen(
    ProfileView("Sam", "sam@home.test", true),
    false,
    emptyList(),
    emptyList(),
    emptyList(),
    emptyList(),
    null,
    null,
)

private val desk = SystemView(5, "111222333", "Sam's desk", "windows", true, true, true)

private val oneAccount = AccountsView(listOf(homeAccount), false, null, null, emptyList())

/** Several accounts on the phone (E118): the header, the switcher, managing them, adding one. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class AccountsTest {
    @get:Rule val compose = createComposeRule()

    private var switched: Long? = null
    private var signedOut: Long? = null
    private var added = false
    private var cancelled = false
    private var all = false

    private val intents = AppIntents(
        accounts = AccountsIntents(
            add = { added = true },
            cancelAdd = { cancelled = true },
            switchTo = { switched = it },
            signOutOf = { signedOut = it },
            signOutAll = { all = true },
        ),
    )

    private fun show(view: AppView, tab: String = "account", dark: Boolean = true) {
        compose.setContent { RunovaTheme(dark = dark) { AppRoot(view, tab, {}, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theHeaderShowsTheAccountInUseAndOpensTheSwitcher() {
        show(appView(account = home, accounts = twoAccounts))
        snapshot("accounts-header")

        compose.onNodeWithText("sam@home.test").assertExists()
        compose.onNodeWithContentDescription("Accounts, 2 on this phone").performClick()
        snapshot("accounts-switcher")

        compose.onNodeWithText("Add another account").assertExists()
        compose.onNodeWithText("Manage accounts").assertExists()
        compose.onNodeWithContentDescription("Sam, sam@home.test, current account").assertExists()
    }

    @Test
    fun theSwitcherLooksRightInTheLightToo() {
        show(appView(account = home, accounts = twoAccounts), dark = false)
        compose.onNodeWithContentDescription("Accounts, 2 on this phone").performClick()
        snapshot("accounts-switcher-light")
    }

    @Test
    fun tappingAnotherAccountSwitchesToItAndClosesTheSheet() {
        show(appView(account = home, accounts = twoAccounts))
        compose.onNodeWithContentDescription("Accounts, 2 on this phone").performClick()

        compose.onNodeWithContentDescription("Switch to Sam Rivera, sam@work.test").performClick()

        assertEquals(11L, switched)
        compose.onNodeWithText("Add another account").assertDoesNotExist()
    }

    @Test
    fun theSheetAddsAnAccount() {
        show(appView(account = home, accounts = twoAccounts))
        compose.onNodeWithContentDescription("Accounts, 2 on this phone").performClick()

        compose.onNodeWithText("Add another account").performClick()

        assertTrue(added)
    }

    @Test
    fun withOneAccountTheHeaderOffersToAddAnother() {
        show(appView(account = home, accounts = oneAccount))

        compose.onNodeWithContentDescription("Accounts, 1 on this phone").performClick()
        compose.onNodeWithText("Add another account").performClick()

        assertTrue(added)
    }

    @Test
    fun addingShowsTheSignInScreenWithAWayBack() {
        show(appView(account = home, accounts = twoAccounts.copy(adding = true)))
        snapshot("accounts-adding")

        compose.onNodeWithText("Add an account").assertExists()
        compose.onNodeWithText("You'll stay signed in to sam@home.test.").assertExists()
        compose.onNodeWithText("Continue with Google").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()

        assertTrue(cancelled)
    }

    @Test
    fun switchingShowsWhoItIsSwitchingTo() {
        show(appView(account = home, accounts = twoAccounts.copy(switching = workAccount)))
        snapshot("accounts-switching")

        compose.onNodeWithText("Switching to Sam Rivera").assertExists()
        compose.onNodeWithText("sam@work.test").assertExists()
    }

    @Test
    fun theManageScreenSignsOutOfOneAccountOrAll() {
        show(appView(account = home, accounts = twoAccounts))
        compose.onNodeWithContentDescription("Accounts, 2 on this phone").performClick()
        compose.onNodeWithText("Manage accounts").performClick()
        snapshot("accounts-manage")

        compose.onNodeWithText("Used 2d ago").assertExists()
        compose.onNodeWithContentDescription("Sign out of sam@work.test").performClick()
        assertEquals(11L, signedOut)
        compose.onNodeWithContentDescription("Switch to Sam Rivera").performClick()
        assertEquals(11L, switched)
        compose.onNodeWithText("Sign out of all accounts").performClick()
        assertTrue(all)
    }

    @Test
    fun anAccountWhoseSessionEndedAsksToSignInAgainAndOffersTheOthers() {
        val ended = homeAccount.copy(active = false, needsSignIn = true)
        show(
            appView(
                auth = AuthState.SIGNED_OUT,
                accounts = AccountsView(listOf(workAccount, ended), false, null, ended, emptyList()),
            ),
        )
        snapshot("accounts-signed-out")

        compose.onNodeWithText("Your session for sam@home.test ended. Sign in again to keep using it.").assertExists()
        compose.onNodeWithContentDescription("Switch to Sam Rivera, sam@work.test").performClick()

        assertEquals(11L, switched)
    }

    @Test
    fun theSystemsScreenShowsTheAvatarOnlyWithMoreThanOneAccount() {
        show(appView(systems = listOf(desk), accounts = oneAccount), tab = "systems")
        compose.onAllNodesWithContentDescription("Switch account").assertCountEquals(0)
    }

    @Test
    fun theSystemsAvatarOpensTheSwitcher() {
        show(appView(systems = listOf(desk), accounts = twoAccounts), tab = "systems")
        snapshot("accounts-systems")

        compose.onNodeWithContentDescription("Switch account").performClick()

        compose.onNode(hasContentDescription("Switch to Sam Rivera, sam@work.test")).assertExists()
    }

    @Test
    fun whatTheCoreSaysAboutASwitchShowsOverTheTabs() {
        show(appView(systems = listOf(desk), accounts = twoAccounts, notice = "Now using sam@home.test."), tab = "systems")

        compose.onNodeWithText("Now using sam@home.test.").assertExists()
    }
}
