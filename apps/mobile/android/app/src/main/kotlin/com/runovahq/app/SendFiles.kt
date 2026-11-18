package com.runovahq.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import com.runovahq.app.ui.StagedFile
import uniffi.runova_ffi.PickedFiles
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** More than the core takes at once, so a huge folder stops being walked early. */
private const val MOST_FILES = 10_001

/**
 * The phone's picks, read for the core a piece at a time (E113). A file is opened on its first
 * read and closed when the core says it is done with it, so a pick of thousands never holds
 * thousands open.
 */
class PickedUris(private val resolver: ContentResolver) : PickedFiles {
    private val uris = ConcurrentHashMap<String, Uri>()
    private val open = ConcurrentHashMap<String, Pair<ParcelFileDescriptor, FileChannel>>()

    private fun stage(uri: Uri, path: String, size: Long): StagedFile {
        val handle = UUID.randomUUID().toString()
        uris[handle] = uri
        return StagedFile(handle, path, size)
    }

    /** Files from the document picker, the photo picker or a share, by their own names. */
    fun stageDocuments(picked: List<Uri>): List<StagedFile> = picked.mapNotNull { uri ->
        keep(uri)
        val (name, size) = describe(uri) ?: return@mapNotNull null
        stage(uri, name, size)
    }

    /** Everything under a picked folder, with the folder's own name first in every path. */
    fun stageFolder(tree: Uri): List<StagedFile> {
        keep(tree)
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = nameOf(DocumentsContract.buildDocumentUriUsingTree(tree, rootId)) ?: "Folder"
        val staged = mutableListOf<StagedFile>()
        val pending = ArrayDeque(listOf(rootId to rootName))
        while (pending.isNotEmpty() && staged.size < MOST_FILES) {
            val (folderId, folderPath) = pending.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, folderId)
            val columns = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
            )
            runCatching {
                resolver.query(children, columns, null, null, null)?.use { rows ->
                    while (rows.moveToNext() && staged.size < MOST_FILES) {
                        val id = rows.getString(0) ?: continue
                        val name = rows.getString(1) ?: continue
                        val path = "$folderPath/$name"
                        if (rows.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
                            pending.addLast(id to path)
                        } else {
                            val size = if (rows.isNull(3)) -1L else rows.getLong(3)
                            if (size >= 0) staged += stage(DocumentsContract.buildDocumentUriUsingTree(tree, id), path, size)
                        }
                    }
                }
            }
        }
        return staged
    }

    /** Keeps reading allowed while a send runs on after the picker has closed. */
    private fun keep(uri: Uri) {
        runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    private fun nameOf(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { rows ->
            if (rows.moveToFirst()) rows.getString(0) else null
        }
    }.getOrNull()

    private fun describe(uri: Uri): Pair<String, Long>? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { rows ->
            if (!rows.moveToFirst()) return@use null
            val name = rows.getString(0) ?: uri.lastPathSegment ?: "file"
            val size = if (rows.isNull(1)) statSize(uri) else rows.getLong(1)
            if (size < 0) null else name to size
        }
    }.getOrNull()

    private fun statSize(uri: Uri): Long =
        runCatching { resolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L }.getOrDefault(-1L)

    override fun read(handle: String, offset: ULong, length: UInt): ByteArray? = runCatching {
        val channel = channelFor(handle) ?: return null
        val buffer = ByteBuffer.allocate(length.toInt())
        var position = offset.toLong()
        while (buffer.hasRemaining()) {
            val read = channel.read(buffer, position)
            if (read < 0) break
            position += read
        }
        buffer.flip()
        ByteArray(buffer.remaining()).also { buffer.get(it) }
    }.getOrNull()

    private fun channelFor(handle: String): FileChannel? = synchronized(open) {
        open[handle]?.second ?: run {
            val uri = uris[handle] ?: return null
            val descriptor = resolver.openFileDescriptor(uri, "r") ?: return null
            val channel = FileInputStream(descriptor.fileDescriptor).channel
            open[handle] = descriptor to channel
            channel
        }
    }

    override fun close(handle: String) {
        open.remove(handle)?.let { (descriptor, channel) ->
            runCatching { channel.close() }
            runCatching { descriptor.close() }
        }
    }
}

private const val CHANNEL = "sending"
private const val NOTIFICATION = 4113
private const val LABEL = "label"
private const val PERCENT = "percent"

/**
 * Keeps the phone sending while Runova is in the background, with the progress in a notification.
 * Started while the app is on screen, as Android requires, and updated through the notification.
 */
class SendService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = notification(this, intent?.getStringExtra(LABEL) ?: "Sending files", intent?.getIntExtra(PERCENT, 0) ?: 0)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION, notification)
        }
        return START_NOT_STICKY
    }

    /** Android 15 ends a long data sync; the core's own retries carry on once the app is back. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    companion object {
        @Volatile private var running = false
        private var shown: Pair<String, Int>? = null

        /** Starts the service the first time, and moves its notification on after that. */
        fun show(context: Context, label: String, percent: Int) {
            if (shown == label to percent && running) return
            shown = label to percent
            if (running) {
                manager(context).notify(NOTIFICATION, notification(context, label, percent))
                return
            }
            runCatching {
                context.startForegroundService(
                    Intent(context, SendService::class.java).putExtra(LABEL, label).putExtra(PERCENT, percent),
                )
                running = true
            }
        }

        fun stop(context: Context) {
            if (!running) return
            running = false
            shown = null
            context.stopService(Intent(context, SendService::class.java))
        }

        private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

        private fun notification(context: Context, label: String, percent: Int): Notification {
            manager(context).createNotificationChannel(
                NotificationChannel(CHANNEL, "Sending files", NotificationManager.IMPORTANCE_LOW),
            )
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE,
            )
            return Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(label)
                .setContentText("It carries on while Runova is in the background.")
                .setProgress(100, percent.coerceIn(0, 100), false)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setContentIntent(open)
                .build()
        }
    }
}
