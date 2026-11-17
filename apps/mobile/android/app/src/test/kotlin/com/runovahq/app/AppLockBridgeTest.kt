package com.runovahq.app

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import uniffi.runova_ffi.AppView
import uniffi.runova_ffi.CoreConfig
import uniffi.runova_ffi.PasscodeKind
import uniffi.runova_ffi.PasscodeStep
import uniffi.runova_ffi.RunovaCore
import uniffi.runova_ffi.SecureStore
import uniffi.runova_ffi.ViewListener

/** The app lock through the generated bindings, against the real core. Signed out, so no network. */
class AppLockBridgeTest {
    private class MemoryStore : SecureStore {
        val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun set(key: String, value: String) { values[key] = value }
        override fun remove(key: String) { values.remove(key) }
    }

    private class Views : ViewListener {
        val seen = CopyOnWriteArrayList<AppView>()
        override fun onView(view: AppView) { seen += view }

        fun until(label: String, check: (AppView) -> Boolean): AppView {
            repeat(1000) {
                seen.lastOrNull()?.takeIf(check)?.let { return it }
                Thread.sleep(10)
            }
            fail("timed out waiting for $label; last view: ${seen.lastOrNull()?.lock}")
            error("unreachable")
        }
    }

    private fun start(store: MemoryStore, views: Views) =
        RunovaCore(CoreConfig("https://runovahq.test", "android", "1.0.0"), store, views)

    @Test
    fun aPasscodeSetThroughTheBindingsLocksTheNextStart() {
        val store = MemoryStore()
        val views = Views()
        val core = start(store, views)
        val engine = core.engine()

        engine.passcodeOpen()
        engine.passcodeStart(PasscodeKind.PIN4)
        "2468".forEach { engine.passcodeKey((it - '0').toUByte()) }
        views.until("the second entry") { it.passcode.step == PasscodeStep.CONFIRM }
        "2468".forEach { engine.passcodeKey((it - '0').toUByte()) }
        val on = views.until("the lock on") { it.passcode.step == PasscodeStep.ON }

        assertTrue(on.lock.enabled)
        assertFalse(on.lock.locked)
        val saved = store.values["app-lock"] ?: error("nothing saved")
        assertTrue(saved.contains("scrypt$"))
        assertFalse(saved.contains("\"2468\""))

        val again = Views()
        val restarted = start(store, again).engine()
        val first = again.until("the first view") { true }
        assertTrue(first.lock.locked)
        assertEquals(4, first.lock.entry.length.toInt())

        "2468".forEach { restarted.lockKey((it - '0').toUByte()) }
        again.until("unlocked") { !it.lock.locked }
    }
}
