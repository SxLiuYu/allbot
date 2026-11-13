package com.wangzan101.mika.core.action

import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.record.RunSink
import com.wangzan101.mika.core.tool.ScreenTimings
import com.wangzan101.mika.core.tool.Verb
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

/** 屏幕层耗时(读屏、OCR、截图、等稳定)跟着工具结果进运行记录,拆账时不用再猜。 */
class ActionRecorderTimingsTest {
    private val events = mutableListOf<RunEvent>()
    private val recorder = ActionRecorder(object : RunSink { override fun event(e: RunEvent) { events += e } }, { 1_000L })

    private fun record(timings: ScreenTimings, waitMs: Long = 0) =
        recorder.result(2, "phone_observe", Verb.Observe, buildJsonObject { put("ok", true) }, JsonObject(emptyMap()), null, null, 900,
            "model", "c1", waitMs = waitMs, timings = timings)

    private fun last() = events.last() as RunEvent.ToolResult

    @Test fun screenTimingsAreRecordedNextToTheTotal() {
        record(ScreenTimings(readMs = 120, ocrMs = 1_800, shotMs = 90, settleMs = 1_500))
        val e = last()
        assertEquals(900L, e.durationMs)
        assertEquals(120L, e.readMs)
        assertEquals(1_800L, e.ocrMs)
        assertEquals(90L, e.shotMs)
        assertEquals(1_500L, e.settleMs)
    }

    @Test fun notTouchingTheScreenLeavesThemAtZero() {
        record(ScreenTimings.NONE)
        val e = last()
        assertEquals(0L, e.readMs)
        assertEquals(0L, e.ocrMs)
        assertEquals(0L, e.shotMs)
        assertEquals(0L, e.settleMs)
    }

    @Test fun stagesAddUpWhenSeveralReadsShareOneCall() {
        val sum = ScreenTimings(readMs = 10, ocrMs = 20) + ScreenTimings(readMs = 5, shotMs = 7)
        assertEquals(ScreenTimings(readMs = 15, ocrMs = 20, shotMs = 7), sum)
        assertEquals(42L, sum.totalMs)
    }
}
