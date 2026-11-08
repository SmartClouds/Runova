package com.runovahq.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.runova_ffi.CoreException
import uniffi.runova_ffi.DeviceDetails
import uniffi.runova_ffi.beginPhoneSignIn
import uniffi.runova_ffi.coreVersion
import uniffi.runova_ffi.finishBrowserCallback

/** Kotlin calling the real Rust core through the generated bindings. */
class CoreBridgeTest {
    private val device = DeviceDetails(
        deviceId = "4b2c0c0e-1111-4222-8333-944444444444",
        name = "Runova app",
        platform = "android",
        appVersion = "1.0.0",
    )

    @Test
    fun theCoreAnswersWithItsVersion() {
        assertTrue(coreVersion().isNotEmpty())
    }

    @Test
    fun aSignInLinkComesBackAsATypedRecord() {
        val link = beginPhoneSignIn("https://runovahq.com", device)

        assertTrue(link.url.contains("client_id=runova-mobile"))
        assertEquals(43, link.verifier.length)
    }

    @Test
    fun aTypedErrorCrossesTheBridge() {
        val declined = "com.runovahq.app:/auth/callback?error=access_denied&state=s-12345678"

        assertThrows(CoreException.SignInDeclined::class.java) {
            finishBrowserCallback(declined, "s-12345678")
        }
    }
}
