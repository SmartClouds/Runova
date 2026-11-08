package com.runovahq.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.atomic.AtomicBoolean
import uniffi.runova_ffi.RemoteFrameSink

/** Bigger than any screen a computer should report. */
private const val LARGEST_SIDE = 8192

/**
 * What the core draws into: one bitmap the size of the computer's screen, with each JPEG tile
 * decoded into a reused bitmap and painted onto it. Tiles come one at a time on the core's frame
 * thread. Compose reads [bitmap] and [revision] on the main thread and redraws.
 */
class RemoteFrames : RemoteFrameSink {
    private val main = Handler(Looper.getMainLooper())
    private val redrawQueued = AtomicBoolean(false)
    private val lock = Any()
    private var target: Bitmap? = null
    private var canvas: Canvas? = null
    private var scratch: Bitmap? = null
    private val decodeOptions = BitmapFactory.Options().apply {
        inMutable = true
        inPreferredConfig = Bitmap.Config.ARGB_8888
    }

    var bitmap by mutableStateOf<Bitmap?>(null)
        private set
    var revision by mutableIntStateOf(0)
        private set

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == main.looper) block() else main.post(block)
    }

    private fun redraw() {
        if (redrawQueued.compareAndSet(false, true)) {
            main.post {
                redrawQueued.set(false)
                revision++
            }
        }
    }

    override fun onScreenSize(width: UInt, height: UInt) {
        val w = width.toInt().coerceIn(1, LARGEST_SIDE)
        val h = height.toInt().coerceIn(1, LARGEST_SIDE)
        val next = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        synchronized(lock) {
            target = next
            canvas = Canvas(next)
        }
        onMain {
            bitmap = next
            revision++
        }
    }

    override fun onTile(x: UShort, y: UShort, w: UShort, h: UShort, jpeg: ByteArray) {
        val decoded = decode(jpeg) ?: return
        scratch = decoded
        synchronized(lock) {
            canvas?.drawBitmap(decoded, x.toFloat(), y.toFloat(), null)
        }
        redraw()
    }

    /** Decodes into the last tile's bitmap, falling back to a new one if it does not fit. */
    private fun decode(jpeg: ByteArray): Bitmap? {
        decodeOptions.inBitmap = scratch
        return try {
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, decodeOptions)
        } catch (error: IllegalArgumentException) {
            decodeOptions.inBitmap = null
            try {
                BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, decodeOptions)
            } catch (again: IllegalArgumentException) {
                null
            }
        }
    }

    /** The core is done with this sink, so everything drawn can be let go. */
    override fun onStopped() {
        synchronized(lock) {
            target = null
            canvas = null
        }
        scratch = null
        decodeOptions.inBitmap = null
        onMain { bitmap = null }
    }

    /** Puts a picture on show, for screenshots and previews of the screen. */
    fun showForPreview(picture: Bitmap) {
        bitmap = picture
        revision++
    }
}
