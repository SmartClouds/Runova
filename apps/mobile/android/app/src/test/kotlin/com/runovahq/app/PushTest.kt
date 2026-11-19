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

    // E118: a push tagged with its account comes as data only, so the app shows it and can say whose it is.
    private val tagged = mapOf("category" to "monitors", "account" to "work-tag-123", "fallback" to "Monitor down: api", "notificationId" to "42")

    @Test
    fun aTaggedPushShowsTheLineItCameWith() {
        assertEquals("Monitor down: api", pushLine(tagged) { _, _ -> "never" })
    }

    @Test
    fun aTaggedSealedPushStillOpens() {
        assertEquals("Critical alert on prod", pushLine(sealed + ("account" to "work-tag-123")) { _, _ -> "Critical alert on prod" })
    }

    @Test
    fun anUntaggedPlainPushIsStillLeftToTheOs() {
        assertNull(pushLine(mapOf("category" to "deploys")) { _, _ -> "opened" })
    }

    @Test
    fun theTapCarriesTheAccountSoTheAppCanSwitchToIt() {
        val extras = pushTapExtras(tagged)

        assertEquals("work-tag-123", extras["account"])
        assertEquals("monitors", extras["category"])
        assertEquals("42", extras["notificationId"])
    }
}
