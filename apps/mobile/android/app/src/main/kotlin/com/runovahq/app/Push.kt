package com.runovahq.app

import android.app.ActivityManager
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import uniffi.runova_ffi.notificationSecret
import uniffi.runova_ffi.openSealedNotification

private const val CHANNEL = "runova"
private const val IDENTITY_SEED = "identity-seed"

/** Does nothing until the app is built with a Firebase project. */
fun ensureFirebase(context: Context) {
    if (BuildConfig.FIREBASE_API_KEY.isEmpty()) return
    if (FirebaseApp.getApps(context).isNotEmpty()) return
    FirebaseApp.initializeApp(
        context,
        FirebaseOptions.Builder()
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .build(),
    )
}

/** A push can wake the app with no screen open, so Firebase is set up before any screen is. */
class RunovaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ensureFirebase(this)
    }
}

/**
 * The line for a sealed push. Null means this isn't one, and the OS has dealt with it. When a sealed
 * one won't open, the generic line that came with it is shown instead.
 */
fun sealedPushLine(data: Map<String, String>, open: (category: String, sealed: String) -> String?): String? {
    val sealed = data["sealed"] ?: return null
    val category = data["category"] ?: return data["fallback"]
    return open(category, sealed) ?: data["fallback"]
}

/** Opens sealed notifications, which arrive with no text the OS could show by itself. */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val line = sealedPushLine(message.data, ::open) ?: return
        // With the app on screen the inbox has already shown it.
        if (appOnScreen()) return
        show(line, message.data)
    }

    private fun open(category: String, sealed: String): String? = runCatching {
        val seed = AndroidSecureStore(this).get(IDENTITY_SEED) ?: return null
        val secret = notificationSecret(seed) ?: return null
        openSealedNotification(secret, category, sealed)
    }.getOrNull()

    private fun appOnScreen(): Boolean {
        val state = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(state)
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private fun show(line: String, data: Map<String, String>) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_HIGH))
        val id = data["notificationId"]?.toLongOrNull()?.hashCode() ?: line.hashCode()
        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("category", data["category"])
            .putExtra("notificationId", data["notificationId"])
        val tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            id,
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Runova")
                .setContentText(line)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build(),
        )
    }
}
