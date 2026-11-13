package com.wangzan101.mika.core.tool

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 模型常常只给 ref 不给 snapshotId。那个值就在最近一次读屏里，
 * 补上比回一条 "snapshotId: required" 让它重试一轮省事。
 * 但只该在 ref 看起来像编号时补；别的写法仍然报错，免得把笔误吞掉。
 */
class ArgsSnapshotFallbackTest {
    private val tool = ToolDef("phone_tap", "tap", mapOf(
        "ref" to str("ref"),
        "snapshotId" to str("snapshotId"),
    ))

    private fun args(json: String): Args =
        Args(tool, Json.parseToJsonElement(json) as JsonObject)

    @Test fun fillsSnapshotIdWhenOnlyRefIsGiven() {
        val r = args("""{"ref":"@e3"}""").ref(knownSnapshot = "p2")
        assertEquals("@e3" to "p2", r)
    }

    @Test fun keepsTheSnapshotIdTheModelGave() {
        val r = args("""{"ref":"@e3","snapshotId":"p9"}""").ref(knownSnapshot = "p2")
        assertEquals("@e3" to "p9", r)
    }

    @Test fun stillFailsWhenThereIsNoKnownScreen() {
        val e = runCatching { args("""{"ref":"@e3"}""").ref(knownSnapshot = null) }.exceptionOrNull()
        assertEquals("snapshotId: required when ref is given", e?.message)
    }

    @Test fun doesNotSwallowAtypo() {
        // "e3" 少了 @：补 snapshotId 也救不了，照旧报错，别让它带着坏 ref 往下走
        val e = runCatching { args("""{"ref":"e3"}""").ref(knownSnapshot = "p2") }.exceptionOrNull()
        assert(e is ArgError)
    }

    @Test fun snapshotIdAloneStillRequiresRef() {
        val e = runCatching { args("""{"snapshotId":"p2"}""").ref(knownSnapshot = "p2") }.exceptionOrNull()
        assertEquals("ref: required when snapshotId is given", e?.message)
    }

    @Test fun noRefNoSnapshotIsNotAnError() {
        assertNull(args("""{}""").ref(knownSnapshot = "p2"))
    }
}
