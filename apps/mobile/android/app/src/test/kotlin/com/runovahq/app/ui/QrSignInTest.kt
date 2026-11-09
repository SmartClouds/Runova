package com.runovahq.app.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.runovahq.app.design.RunovaTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.AuthState
import uniffi.runova_ffi.QrSignInView

private const val TEXT = "rq1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], qualifiers = "w390dp-h844dp-xxhdpi")
class QrSignInTest {
    @get:Rule val compose = createComposeRule()

    private fun show(view: AppView, intents: AppIntents = AppIntents()) {
        compose.setContent { RunovaTheme(dark = true) { AppRoot(view, "systems", {}, intents) } }
    }

    private fun signedOut(qr: QrSignInView? = null) = appView(AuthState.SIGNED_OUT, qrSignIn = qr)

    @Test
    fun aFrameWithACodeIsRead() {
        val size = 400
        val matrix = QRCodeWriter().encode(TEXT, BarcodeFormat.QR_CODE, size, size)
        val frame = ByteArray(size * size) { i -> if (matrix.get(i % size, i / size)) 0 else -1 }

        assertEquals(TEXT, readQrCode(frame, size, size, size))
    }

    @Test
    fun aFrameWithNoCodeIsNothing() {
        assertNull(readQrCode(ByteArray(160 * 160) { 90 }, 160, 160, 160))
    }

    @Test
    fun scanningOpensFromTheSignInScreenAndCancelGoesBack() {
        show(signedOut())

        compose.onNodeWithText("Scan QR code").performClick()
        compose.onNodeWithText("Scan to sign in").assertExists()

        compose.onNodeWithText("Cancel").performClick()
        compose.onNodeWithText("Scan QR code").assertExists()
    }

    @Test
    fun theDigitsShowAndCancelRunsTheIntent() {
        var cancelled = false
        show(signedOut(QrSignInView("0420")), AppIntents(cancelQrSignIn = { cancelled = true }))

        compose.onNodeWithText("0420").assertExists()
        compose.onNodeWithText("Cancel").performClick()

        assertTrue(cancelled)
    }

    @Test
    fun itSaysSoWhileTheCodeIsChecked() {
        show(signedOut(QrSignInView(null)))

        compose.onNodeWithText("Checking the code…").assertExists()
    }
}
