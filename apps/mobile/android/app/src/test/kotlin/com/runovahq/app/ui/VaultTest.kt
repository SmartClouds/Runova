package com.runovahq.app.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
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
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.ConnectionPhase
import uniffi.runova_ffi.ConnectionView
import uniffi.runova_ffi.RevealedSecretView
import uniffi.runova_ffi.Section
import uniffi.runova_ffi.VaultEntryView
import uniffi.runova_ffi.VaultLockState
import uniffi.runova_ffi.VaultScreen
import uniffi.runova_ffi.VaultSecretField

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val connected = ConnectionView(1, "Sam's desk", ConnectionPhase.CONNECTED, null, true, null)
private val entry = VaultEntryView(
    "e1",
    "GitHub",
    "sam",
    true,
    true,
    listOf(VaultSecretField("password", "Password", false), VaultSecretField("f1", "PIN", true)),
)

private fun vault(
    state: VaultLockState = VaultLockState.UNLOCKED,
    entries: List<VaultEntryView> = listOf(entry),
    open: String? = null,
    revealed: RevealedSecretView? = null,
    unlockError: String? = null,
) = VaultScreen(state, false, true, unlockError, entries, open, null, revealed)

private fun view(screen: VaultScreen) = appView(connection = connected, vault = screen)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class VaultTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, vault: VaultIntents = VaultIntents(), intents: AppIntents = AppIntents(vault = vault), tab: String = "vault", onTab: (String) -> Unit = {}) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, tab, onTab, intents) } }
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun moreLeadsToTheVault() {
        var tab = ""
        show(view(vault()), tab = "more", onTab = { tab = it })

        compose.onNodeWithText("Vault").performClick()

        assertEquals("vault", tab)
        snapshot("more")
    }

    @Test
    fun itRefreshesOnlyWhileOnShow() {
        val sections = mutableListOf<Section?>()
        show(view(vault()), intents = AppIntents(openSection = { sections += it }))

        compose.waitForIdle()

        assertEquals(listOf<Section?>(Section.VAULT), sections)
    }

    @Test
    fun aLockedVaultAsksForItsPassword() {
        var sent = ""
        show(view(vault(VaultLockState.LOCKED, emptyList())), VaultIntents(unlock = { sent = it }))

        compose.onNode(hasSetTextAction()).performTextInput("secret")
        compose.onNodeWithText("Unlock").performClick()

        assertEquals("secret", sent)
        snapshot("vault-locked")
    }

    @Test
    fun aWrongPasswordIsExplained() {
        show(view(vault(VaultLockState.LOCKED, emptyList(), unlockError = "That password isn't right.")))

        compose.onNodeWithText("That password isn't right.").assertExists()
    }

    @Test
    fun aVaultNotSetUpSaysSo() {
        show(view(vault(VaultLockState.UNINITIALIZED, emptyList())))

        compose.onNodeWithText("No vault on this computer").assertExists()
    }

    @Test
    fun entriesAreListedAndOpen() {
        var opened = ""
        show(view(vault()), VaultIntents(openEntry = { opened = it }))

        compose.onNodeWithText("GitHub").performClick()

        assertEquals("e1", opened)
        snapshot("vault")
    }

    @Test
    fun theVaultCanBeLockedFromThePhone() {
        var locked = false
        show(view(vault()), VaultIntents(lock = { locked = true }))

        compose.onNodeWithText("Lock").performClick()

        assertTrue(locked)
    }

    @Test
    fun aSecretIsHiddenUntilAskedFor() {
        var asked: Pair<String, Boolean>? = null
        show(view(vault(open = "e1")), VaultIntents(requestReveal = { key, custom -> asked = key to custom }))

        compose.onNodeWithText("Password").assertExists()
        compose.onNodeWithText("hunter2").assertDoesNotExist()
        compose.onNode(hasContentDescription("Reveal PIN")).performClick()

        assertEquals("f1" to true, asked)
        snapshot("vault-entry")
    }

    @Test
    fun aRevealedSecretCanBeHidden() {
        var hidden = false
        show(
            view(vault(open = "e1", revealed = RevealedSecretView("Password", "hunter2"))),
            VaultIntents(hide = { hidden = true }),
        )

        compose.onNodeWithText("hunter2").assertExists()
        compose.onNodeWithText("Hide").performClick()

        assertTrue(hidden)
    }

    @Test
    fun anEntryCanBeEditedWithoutTouchingItsPassword() {
        var saved: List<String?> = emptyList()
        show(
            view(vault(open = "e1")),
            VaultIntents(save = { id, title, username, password -> saved = listOf(id, title, username, password) }),
        )

        compose.onNodeWithText("Edit").performClick()
        compose.onNodeWithText("Save").performClick()

        assertEquals(listOf("e1", "GitHub", "sam", null), saved)
    }

    @Test
    fun anEntryCanBeDeleted() {
        var removed = ""
        show(view(vault(open = "e1")), VaultIntents(remove = { removed = it }))

        compose.onNodeWithText("Delete").performClick()

        assertEquals("e1", removed)
    }
}
