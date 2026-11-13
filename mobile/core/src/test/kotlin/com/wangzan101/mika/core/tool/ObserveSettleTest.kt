package com.wangzan101.mika.core.tool

import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.UiElement
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wangzan101.mika.core.assembly.toolDispatcher

/**
 * 刚打开、刚换页时第一屏常常还读不到东西。这时 observe 就地等界面安静再读一次,
 * 而不是把空屏交回去让模型自己 wait 再 observe(实测那样每处多两轮)。
 */
private class SlowScreen(private vararg val screens: Pair<Boolean, List<String>>) : ScreenPort by FakeScreen() {
    /** 每次 snapshot 用下一份;true 表示这一屏读不到窗口。 */
    var reads = 0
    val waits = mutableListOf<Long>()

    private fun build(i: Int): ScreenSnapshot {
        val (noWindow, names) = screens[minOf(i, screens.size - 1)]
        return ScreenSnapshot("p${i + 1}", if (noWindow) null else "com.x",
            names.mapIndexed { n, name ->
                UiElement("@e${n + 1}", "button", name, 500, 100, listOf(0, 0, 10, 10), null, true, true, false)
            }, 1080, 2400, hasWindow = !noWindow, unreadableApp = if (noWindow) "com.x" else null)
    }

    override suspend fun snapshot(): ScreenSnapshot = build(reads++)
    override suspend fun peek(): ScreenSnapshot = build(maxOf(0, reads - 1))
    override suspend fun screenshotPng(): ByteArray? = null
    override suspend fun waitStable(timeoutMs: Long): Boolean { waits += timeoutMs; return true }
}

class ObserveSettleTest {
    private fun call(name: String) = Part.ToolCall("c1", name, "{}")

    /** 第一屏读不到窗口、第二屏有了:observe 自己等到并读到,结果直接可读。 */
    @Test fun emptyFirstReadSettlesAndReadsAgain() = runTest {
        val s = SlowScreen(true to emptyList(), false to listOf("设置", "WLAN"))
        val o = toolDispatcher(s).execute(call("phone_observe")).content
        assertEquals(1, s.waits.size)
        assertEquals(2, s.reads)
        assertEquals(2, (o["elements"] as JsonArray).size)
        assertEquals("p2", o["snapshotId"]!!.jsonPrimitive.content)
    }

    /** 第一屏就读到东西:不等,省掉这 2.5 秒。 */
    @Test fun readableFirstReadDoesNotWait() = runTest {
        val s = SlowScreen(false to listOf("设置", "WLAN"))
        val o = toolDispatcher(s).execute(call("phone_observe")).content
        assertTrue(s.waits.isEmpty())
        assertEquals(1, s.reads)
        assertEquals("p1", o["snapshotId"]!!.jsonPrimitive.content)
    }

    /** 等了还是空:只等一次,不反复等。 */
    @Test fun stillEmptyAfterSettlingWaitsOnlyOnce() = runTest {
        val s = SlowScreen(true to emptyList(), true to emptyList())
        toolDispatcher(s).execute(call("phone_observe"))
        assertEquals(1, s.waits.size)
        assertEquals(2, s.reads)
    }

    /** 受保护页面不等:等也不会变得可读。 */
    @Test fun protectedScreenDoesNotWait() = runTest {
        val s = SlowScreen(false to listOf("设置"))
        val guarded = object : ScreenPort by s {
            override suspend fun snapshot() = ScreenSnapshot("g1", "com.x", emptyList(), 1080, 2400, protected = true)
        }
        toolDispatcher(guarded).execute(call("phone_observe"))
        assertTrue(s.waits.isEmpty())
    }
}
