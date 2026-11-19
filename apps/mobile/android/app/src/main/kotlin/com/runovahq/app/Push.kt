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
import uniffi.runova_ffi.pushAccountLabel

private const val CHANNEL = "runova"
private const val IDENTITY_SEED = "identity-seed"
private const val ACCOUNTS = "accounts"

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

/**
 * The line for a push the app shows itself: a sealed one, or one tagged with its account, which
 * the server sends as data only so the app can say whose it is (E118). Null leaves it to the OS.
 */
fun pushLine(data: Map<String, String>, open: (category: String, sealed: String) -> String?): String? {
    if (data["sealed"] != null) return sealedPushLine(data, open)
    return if (data["account"] != null) data["fallback"] else null
}

/** What a tap on a push hands the app, so it opens the right thing for the right account. */
fun pushTapExtras(data: Map<String, String>): Map<String, String?> = mapOf(
    "category" to data["category"],
    "notificationId" to data["notificationId"],
    "itemId" to data["itemId"],
    "account" to data["account"],
)

/** Opens sealed and tagged notifications, which arrive with no text the OS would show by itself. */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val line = pushLine(message.data, ::open) ?: return
        // With the app on screen the inbox has already shown it.
        if (appOnScreen()) return
        show(line, message.data)
    }

    /** The account's email, while the phone holds more than one account. */
    private fun accountLabel(tag: String?): String? = runCatching {
        pushAccountLabel(AndroidSecureStore(this).get(ACCOUNTS), tag)
    }.getOrNull()

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
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        pushTapExtras(data).forEach { (key, value) -> open.putExtra(key, value) }
        val tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Runova")
            .setContentText(line)
            .setContentIntent(tap)
            .setAutoCancel(true)
        // Several accounts on the phone: say whose this is, and keep each account's together.
        accountLabel(data["account"])?.let { label -> builder.setSubText(label).setGroup("account:${data["account"]}") }
        manager.notify(id, builder.build())
    }
}
