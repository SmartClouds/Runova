package com.runovahq.app.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
import uniffi.runova_ffi.ProfileView
import uniffi.runova_ffi.RecoveryPhraseItem
import uniffi.runova_ffi.RecoveryPhrasesScreen
import uniffi.runova_ffi.RevealedPhraseView

/** Recovery phrases on the phone (E108): the list, the words after the check, copy and save. */

@OptIn(ExperimentalRoborazziApi::class)
private val SCREENSHOTS = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f),
)

private val account = AccountScreen(
    ProfileView("Sam", "sam@example.com", true), false, emptyList(), emptyList(), emptyList(), emptyList(), null, null,
)

private val WORDS =
    "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"
        .split(" ")

private val item = RecoveryPhraseItem("p1", "Personal sync", "Synced data", "Saved 2d ago")
private val vaultItem = RecoveryPhraseItem("p2", "Vault: work laptop", "The Vault on a computer", "Saved just now")

private val shown = RevealedPhraseView(
    "p2",
    "Vault: work laptop",
    WORDS,
    "RUNOVA-PHRASE:1:vault:VmF1bHQ6IHdvcmsgbGFwdG9w:${WORDS.joinToString(" ")}",
    true,
    "Runova recovery phrase - Vault work laptop.txt",
)

private fun screen(
    items: List<RecoveryPhraseItem> = listOf(item, vaultItem),
    revealed: RevealedPhraseView? = null,
    confirmDelete: String? = null,
    notice: String? = null,
) = RecoveryPhrasesScreen(items, revealed, null, confirmDelete, notice, null)

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class RecoveryPhrasesTest {
    @get:Rule val compose = createComposeRule()

    private fun show(phrases: RecoveryPhrasesScreen, intents: PhraseIntents = PhraseIntents(), open: Boolean = true) {
        compose.setContent {
            RunovaTheme(dark = true) {
                AppRoot(appView(account = account, recoveryPhrases = phrases), "account", {}, AppIntents(phrases = intents))
            }
        }
        if (open) compose.onNodeWithText("Recovery phrases").performScrollTo().performClick()
    }

    private fun snapshot(name: String) {
        compose.onRoot().captureRoboImage("src/test/snapshots/$name.png", SCREENSHOTS)
    }

    @Test
    fun theAccountTabCountsThePhrases() {
        show(screen(), open = false)

        compose.onNodeWithText("Recovery phrases").performScrollTo().assertExists()
        compose.onNodeWithText("2").assertExists()
    }

    @Test
    fun theListNamesEachPhraseWithoutItsWordsAndAsksForTheCheckToShowOne() {
        var revealed: String? = null
        show(screen(notice = "Saved Personal sync."), PhraseIntents(reveal = { revealed = it }))

        compose.onNodeWithText("Saved Personal sync.").assertExists()
        compose.onNodeWithText("Synced data · Saved 2d ago").assertExists()
        compose.onNodeWithText("sausage", substring = true).assertDoesNotExist()
        snapshot("recovery_phrases_list")

        compose.onNodeWithText("Personal sync").performClick()
        assertEquals("p1", revealed)
    }

    @Test
    fun eachPhraseHasADeleteButtonNamedForIt() {
        var deleted: String? = null
        show(screen(), PhraseIntents(delete = { deleted = it }))

        compose.onNodeWithContentDescription("Delete Vault: work laptop").performClick()
        assertEquals("p2", deleted)
    }

    @Test
    fun anEmptyListSaysHowToAddOne() {
        show(screen(items = emptyList()))

        compose.onNodeWithText("No phrases yet").assertExists()
        compose.onNodeWithText("Scan a phrase").assertExists()
    }

    @Test
    fun theWordsAreNumberedAndCanBeCopiedSavedOrShownAsACode() {
        var copied: String? = null
        var saved: Pair<String, String>? = null
        var unlocked: String? = null
        show(
            screen(revealed = shown),
            PhraseIntents(
                copy = { copied = it },
                save = { name, text -> saved = name to text },
                unlockVault = { unlocked = it },
            ),
        )

        compose.onNodeWithContentDescription("Word 1, legal").assertExists()
        compose.onNodeWithContentDescription("Word 24, title").assertExists()
        snapshot("recovery_phrase_words")

        compose.onNodeWithText("Copy").performClick()
        assertEquals(WORDS.joinToString(" "), copied)

        compose.onNodeWithText("Save to a file").performClick()
        assertEquals("Runova recovery phrase - Vault work laptop.txt", saved?.first)
        assertTrue(saved?.second.orEmpty().contains(" 1. legal"))
        assertTrue(saved?.second.orEmpty().contains("24. title"))

        compose.onNodeWithText("Unlock the Vault on the computer").performScrollTo().performClick()
        assertEquals("p2", unlocked)

        compose.onNodeWithText("Show the QR code").performScrollTo().performClick()
        compose.onNodeWithContentDescription("QR code of the recovery phrase").assertExists()
        snapshot("recovery_phrase_qr")
    }

    @Test
    fun deletingAsksFirst() {
        var answer: Boolean? = null
        show(screen(confirmDelete = "p1"), PhraseIntents(deleteAnswer = { answer = it }))

        compose.onNodeWithText("Delete Personal sync?").assertExists()
        compose.onNodeWithText("Keep it").performClick()
        assertEquals(false, answer)
    }

    @Test
    fun theCodeDrawnHereReadsBackAsThePhrase() {
        val image = qrImage(shown.qrPayload, 256)
        assertEquals(256, image.width)
        val pixels = IntArray(256 * 256)
        image.readPixels(pixels)
        val source = com.google.zxing.RGBLuminanceSource(256, 256, pixels)
        val bitmap = com.google.zxing.BinaryBitmap(com.google.zxing.common.HybridBinarizer(source))
        assertEquals(shown.qrPayload, com.google.zxing.qrcode.QRCodeReader().decode(bitmap).text)
    }
}
