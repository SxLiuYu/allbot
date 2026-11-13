package com.wangzan101.mika.core.uistate

import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.tool.FakeScreen
import com.wangzan101.mika.core.visual.FrameGrid
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 开缓存后,同一帧上连续读屏只认一次;画面变了就重新认。 */
class OcrCacheTest {
    private class Screen(var text: String) : ScreenPort by FakeScreen() {
        var ocrReads = 0
        var stableCalls = 0
        override suspend fun snapshot() = ScreenSnapshot("p1", "com.example", emptyList(), 1080, 2400)
        override suspend fun peek() = snapshot()
        override suspend fun readVisibleText(): List<VisibleTextLine> {
            ocrReads++
            return listOf(VisibleTextLine(text, listOf(200, 150, 500, 190)))
        }
        override suspend fun frameGrid() = FrameGrid(2, 2, IntArray(4) { text.hashCode() and 0xff })
        override suspend fun waitStable(timeoutMs: Long): Boolean { stableCalls++; return true }
    }

    private fun words(r: kotlinx.serialization.json.JsonObject) =
        r["visibleText"]!!.jsonArray.map { it.jsonObject["text"]!!.jsonPrimitive.content }

    private suspend fun read(tools: com.wangzan101.mika.core.tool.ToolDispatcher) =
        tools.executeRead(Part.ToolCall("o", "phone_observe", "{}")).content

    @Test fun sameFrameReusesOcrAcrossReads() = runTest {
        val s = Screen("张三")
        val tools = toolDispatcher(s, cacheOcr = true, inlineSettleMs = 0)
        val first = read(tools)
        val second = read(tools)
        assertEquals(listOf("张三"), words(first))
        assertEquals(listOf("张三"), words(second))
        assertEquals(1, s.ocrReads)
    }

    @Test fun changedFrameRecognizesAgain() = runTest {
        val s = Screen("张三")
        val tools = toolDispatcher(s, cacheOcr = true, inlineSettleMs = 0)
        read(tools)
        s.text = "今天见"
        val later = read(tools)
        assertEquals(listOf("今天见"), words(later))
        assertEquals(2, s.ocrReads)
    }

    @Test fun disabledCacheKeepsReadingEveryTime() = runTest {
        val s = Screen("张三")
        val tools = toolDispatcher(s, cacheOcr = false, inlineSettleMs = 0)
        read(tools)
        read(tools)
        assertEquals(2, s.ocrReads)
    }

    @Test fun zeroSettleSkipsWaitStable() = runTest {
        val s = Screen("张三")
        val tools = toolDispatcher(s, inlineScreen = true, inlineSettleMs = 0, cacheOcr = true)
        tools.execute(Part.ToolCall("b", "phone_back", "{}"), com.wangzan101.mika.core.tool.ActionPass(), 1)
        assertTrue(s.stableCalls == 0)
    }
}
