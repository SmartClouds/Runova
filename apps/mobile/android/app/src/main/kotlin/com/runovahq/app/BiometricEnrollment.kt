package com.runovahq.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import uniffi.runova_ffi.BiometricKind

private const val KEYSTORE = "AndroidKeyStore"
private const val KEY = "runova-biometric-enrollment"
private const val PREFS = "runova-biometric"
private const val ENROLLMENT = "enrollment"

/** What the app lock is told about the phone's own check. */
data class BiometricCapability(val kind: BiometricKind, val name: String, val enrollment: String?)

/**
 * Reports whether the phone has a strong biometric, and a token that changes when a finger or face
 * is added. The token comes from a Keystore key that Android throws away on a new enrollment, so the
 * app lock can stop trusting biometrics until the passcode is entered again.
 */
object BiometricEnrollment {
    fun capability(context: Context): BiometricCapability {
        val ready = BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
        if (!ready) return BiometricCapability(BiometricKind.NONE, "", null)
        val features = context.packageManager
        val faceOnly = Build.VERSION.SDK_INT >= 29 &&
            features.hasSystemFeature(PackageManager.FEATURE_FACE) &&
            !features.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
        val kind = if (faceOnly) BiometricKind.FACE else BiometricKind.FINGERPRINT
        val name = if (faceOnly) "Face unlock" else "Fingerprint"
        return BiometricCapability(kind, name, enrollment(context))
    }

    private fun enrollment(context: Context): String? = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val keys = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val key = keys.getKey(KEY, null) as SecretKey?
        val saved = prefs.getString(ENROLLMENT, null)
        if (key != null && saved != null && stillValid(key)) {
            saved
        } else {
            // First run, or the key went with a new enrollment: start a new one.
            keys.deleteEntry(KEY)
            newKey()
            UUID.randomUUID().toString().also { prefs.edit().putString(ENROLLMENT, it).apply() }
        }
    } catch (_: Exception) {
        // A phone whose Keystore can't do this still unlocks; it just can't tell enrollments apart.
        null
    }

    private fun stillValid(key: SecretKey): Boolean = try {
        Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.ENCRYPT_MODE, key)
        true
    } catch (_: KeyPermanentlyInvalidatedException) {
        false
    }

    private fun newKey() {
        val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
    }
}
