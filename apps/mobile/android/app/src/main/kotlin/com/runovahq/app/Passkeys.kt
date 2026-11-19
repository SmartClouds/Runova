package com.runovahq.app

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException

/** What the platform's passkey prompt came back with (E115). */
sealed interface PasskeyResult {
    /** The WebAuthn answer as JSON, for the core to send. */
    data class Answered(val json: String) : PasskeyResult

    data object Cancelled : PasskeyResult

    /** The phone holds no passkey for Runova. */
    data object NoPasskey : PasskeyResult

    data class Failed(val reason: String) : PasskeyResult
}

/** Shows the platform's passkey prompt for the core's WebAuthn request options. */
fun interface PasskeyProvider {
    suspend fun get(optionsJson: String): PasskeyResult
}

/** Credential Manager: the phone's passkeys, and those in a password manager or on a security key. */
class CredentialManagerPasskeys(private val activity: Activity) : PasskeyProvider {
    override suspend fun get(optionsJson: String): PasskeyResult = try {
        val response = CredentialManager.create(activity).getCredential(
            activity,
            GetCredentialRequest(listOf(GetPublicKeyCredentialOption(optionsJson))),
        )
        when (val credential = response.credential) {
            is PublicKeyCredential -> PasskeyResult.Answered(credential.authenticationResponseJson)
            else -> PasskeyResult.Failed("not a passkey: ${credential.type}")
        }
    } catch (_: GetCredentialCancellationException) {
        PasskeyResult.Cancelled
    } catch (_: NoCredentialException) {
        PasskeyResult.NoPasskey
    } catch (e: GetCredentialException) {
        PasskeyResult.Failed(e.type)
    }
}

/**
 * Answers one passkey challenge the core put in the view: the prompt, then the answer back to the
 * core, or a cancel. The core says what went wrong; a platform failure (a provider that is not set
 * up, say) cancels quietly, as closing the prompt does.
 */
class PasskeyPrompt(
    private val provider: PasskeyProvider,
    private val finish: (challengeId: String, credentialJson: String) -> Unit,
    private val cancel: (noPasskey: Boolean) -> Unit,
) {
    suspend fun answer(challengeId: String, optionsJson: String) {
        when (val result = provider.get(optionsJson)) {
            is PasskeyResult.Answered -> finish(challengeId, result.json)
            PasskeyResult.NoPasskey -> cancel(true)
            PasskeyResult.Cancelled, is PasskeyResult.Failed -> cancel(false)
        }
    }
}
