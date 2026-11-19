package com.runovahq.app

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/** What Google's own sign-in sheet came back with (E117). */
sealed interface GoogleResult {
    /** The ID token, for the core to send. */
    data class Token(val idToken: String) : GoogleResult

    data object Cancelled : GoogleResult

    data class Failed(val reason: String) : GoogleResult
}

/** Shows Google's sheet for the core's nonce, signing in as the website's web client. */
fun interface GoogleIdProvider {
    suspend fun get(nonce: String, clientId: String?): GoogleResult
}

/** Credential Manager's Sign in with Google: the Google accounts on the phone. */
class CredentialManagerGoogle(private val activity: Activity) : GoogleIdProvider {
    override suspend fun get(nonce: String, clientId: String?): GoogleResult {
        if (clientId == null) return GoogleResult.Failed("no Google client")
        return try {
            val option = GetSignInWithGoogleOption.Builder(clientId).setNonce(nonce).build()
            val response = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest(listOf(option)))
            val credential = response.credential
            if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                GoogleResult.Token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } else {
                GoogleResult.Failed("not a Google credential: ${credential.type}")
            }
        } catch (_: GetCredentialCancellationException) {
            GoogleResult.Cancelled
        } catch (e: GetCredentialException) {
            GoogleResult.Failed(e.type)
        }
    }
}

/**
 * Answers one nonce the core put in the view: Google's sheet, then the token back to the core, or
 * a cancel. A platform failure (no Google account on the phone, say) cancels quietly.
 */
class GooglePrompt(
    private val provider: GoogleIdProvider,
    private val finish: (nonce: String, idToken: String) -> Unit,
    private val cancel: () -> Unit,
) {
    suspend fun answer(nonce: String, clientId: String?) {
        when (val result = provider.get(nonce, clientId)) {
            is GoogleResult.Token -> finish(nonce, result.idToken)
            GoogleResult.Cancelled, is GoogleResult.Failed -> cancel()
        }
    }
}
