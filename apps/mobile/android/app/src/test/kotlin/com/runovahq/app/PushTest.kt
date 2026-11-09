package com.runovahq.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushTest {
    private val sealed = mapOf("category" to "deploys", "sealed" to "abc", "fallback" to "New activity on your computer")

    @Test
    fun aNormalPushIsLeftToTheOs() {
        assertNull(sealedPushLine(mapOf("category" to "deploys")) { _, _ -> "opened" })
    }

    @Test
    fun aSealedPushShowsTheRealLine() {
        var asked: Pair<String, String>? = null
        val line = sealedPushLine(sealed) { category, text ->
            asked = category to text
            "Critical alert on prod"
        }

        assertEquals("Critical alert on prod", line)
        assertEquals("deploys" to "abc", asked)
    }

    @Test
    fun oneThatWontOpenFallsBackToTheGenericLine() {
        assertEquals("New activity on your computer", sealedPushLine(sealed) { _, _ -> null })
    }

    @Test
    fun oneWithNoCategoryCanNotBeOpened() {
        var opened = false
        val line = sealedPushLine(mapOf("sealed" to "abc", "fallback" to "Generic")) { _, _ ->
            opened = true
            "x"
        }

        assertEquals("Generic", line)
        assertEquals(false, opened)
    }
}
