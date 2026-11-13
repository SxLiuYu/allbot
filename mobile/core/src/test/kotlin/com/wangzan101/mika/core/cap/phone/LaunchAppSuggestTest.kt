package com.wangzan101.mika.core.cap.phone

import com.wangzan101.mika.core.action.ActionExecutor
import com.wangzan101.mika.core.action.ActionOutcome
import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.action.ActionRecorder
import com.wangzan101.mika.core.record.RunSink
import com.wangzan101.mika.core.guard.OperationGuards
import com.wangzan101.mika.core.action.Origin
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 包名猜错时把最像的几个候选给回去。真实运行里「打开时钟」有六次都是先 phone_list_apps 查一遍
 * 才拿到 com.google.android.deskclock:模型凭印象写的包名不存在,而 app_not_found 又什么都不说。
 * 这一条省下来的是一整轮请求(实测每次约 9-10k input token)。
 */
class LaunchAppSuggestTest {
    private class Apps(private val installed: List<Pair<String, String>>) : ScreenPort {
        override suspend fun snapshot() = ScreenSnapshot("p", "com.x", emptyList(), 1080, 2400)
        override suspend fun peek() = snapshot()
        override suspend fun screenshotPng() = byteArrayOf(1)
        override suspend fun tapRef(ref: String, snapshotId: String) = ActionResult.Ok()
        override suspend fun tapXY(x: Int, y: Int) = ActionResult.Ok()
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String) = ActionResult.Ok()
        override suspend fun clearText(ref: String?, snapshotId: String?) = ActionResult.Ok()
        override suspend fun scroll(ref: String?, snapshotId: String?, down: Boolean) = ActionResult.Ok()
        override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) = ActionResult.Ok()
        override suspend fun back() = ActionResult.Ok()
        override suspend fun pressKey(keyCode: Int) = ActionResult.Ok()
        // 不在表里的包名一律 app_not_found,和真机一致
        override suspend fun openApp(packageName: String, cold: Boolean) =
            if (installed.any { it.first == packageName }) ActionResult.Ok() else ActionResult.Failed("app_not_found")
        override suspend fun waitStable(timeoutMs: Long) = true
        override suspend fun listApps() = installed
    }

    private val installed = listOf(
        "com.google.android.deskclock" to "Clock",
        "com.google.android.calendar" to "Calendar",
        "com.android.settings" to "Settings",
        "com.android.chrome" to "Chrome",
    )

    private fun executor() = ActionExecutor(
        toolDispatcher(Apps(installed)), OperationGuards(), null,
        gate = {}, recorder = ActionRecorder(RunSink.NONE), autonomous = true,
    )

    private suspend fun launch(pkg: String): JsonObject {
        val out = executor().run(Part.ToolCall("c1", "phone_launch_app", """{"package":"$pkg"}"""), Origin.Model(1))
        assertTrue("$out", out is ActionOutcome.Ran)
        return (out as ActionOutcome.Ran).content
    }

    @Test fun wrongPackageSuggestsTheRealOne() = runBlocking {
        // 真实那次就是这么写的:com.android.deskclock(安卓原版),这台机器上是 com.google.android
        val r = launch("com.android.deskclock")
        assertEquals("app_not_found", r["error"]!!.jsonPrimitive.content)
        val candidates: JsonArray = r["candidates"]!!.jsonArray
        assertEquals("com.google.android.deskclock", candidates[0].jsonObject["package"]!!.jsonPrimitive.content)
        assertEquals("Clock", candidates[0].jsonObject["label"]!!.jsonPrimitive.content)
        // 说明里要能让模型直接照着改参数
        assertTrue(r["message"]!!.jsonPrimitive.content.contains("com.google.android.deskclock"))
        assertTrue(r["message"]!!.jsonPrimitive.content.contains("phone_launch_app"))
    }

    @Test fun partialPackageAlsoGetsACandidate() = runBlocking {
        val r = launch("com.android.chr")
        assertEquals("app_not_found", r["error"]!!.jsonPrimitive.content)
        val first = r["candidates"]!!.jsonArray[0].jsonObject["package"]!!.jsonPrimitive.content
        assertEquals("com.android.chrome", first)
    }

    @Test fun nothingSimilarKeepsThePlainError() = runBlocking {
        // 一个都像不出来时不硬塞候选:那时模型确实该去看整张 App 表
        val r = launch("org.unrelated.thing")
        assertEquals("app_not_found", r["error"]!!.jsonPrimitive.content)
        assertFalse(r.containsKey("candidates"))
    }

    @Test fun installedPackageStillOpens() = runBlocking {
        val r = launch("com.android.settings")
        assertFalse(r["error"]?.jsonPrimitive?.content == "app_not_found")
        assertFalse(r.containsKey("candidates"))
    }

    // --- 用 App 名字开,不再先查整张 App 表 ---

    @Test fun appNameOpensDirectly() = runBlocking {
        // 模型拿名字来开:唯一命中就直接开,不进 app_not_found
        for (name in listOf("Clock", "clock", "CLOCK")) {
            val r = launch(name)
            assertFalse(name, r["error"]?.jsonPrimitive?.content == "app_not_found")
            assertFalse(name, r.containsKey("candidates"))
        }
    }

    @Test fun appNameWithSpacesAndCaseIgnored() = runBlocking {
        val r = launch(" Chrome ")
        assertFalse(r["error"]?.jsonPrimitive?.content == "app_not_found")
    }

    @Test fun packageTailMatchesName() = runBlocking {
        // 「Deskclock」对上 com.google.android.deskclock 的末段:安卓包名末段就是 App 自己的名字
        val r = launch("deskclock")
        assertFalse(r["error"]?.jsonPrimitive?.content == "app_not_found")
    }

    @Test fun ambiguousNameGivesCandidates() = runBlocking {
        // 「o」两个都含(Clock、Chrome):不猜,把候选给回去
        val r = launch("o")
        assertTrue("实际返回: $r", r["candidates"] != null)
        val names = r["candidates"]!!.jsonArray.map { it.jsonObject["package"]!!.jsonPrimitive.content }
        assertTrue("$names", names.contains("com.android.chrome"))
        assertTrue(r["message"]!!.jsonPrimitive.content.contains("more than one"))
    }

    @Test fun unknownNameWithoutCandidates() = runBlocking {
        // 什么都不像:给一句去查表,不带候选
        val r = launch("zzzznothing")
        assertEquals("app_not_found", r["error"]!!.jsonPrimitive.content)
        assertFalse(r.containsKey("candidates"))
        assertTrue(r["message"]!!.jsonPrimitive.content.contains("phone_list_apps"))
    }

    @Test fun chineseAppNameWorks() = runBlocking {
        // 中文显示名是最常见的形态:计算器、时钟、设置
        val cn = listOf("com.miui.calculator" to "计算器", "com.google.android.deskclock" to "时钟")
        val ex = ActionExecutor(
            toolDispatcher(Apps(cn)), OperationGuards(), null,
            gate = {}, recorder = ActionRecorder(RunSink.NONE), autonomous = true,
        )
        val out = ex.run(Part.ToolCall("c1", "phone_launch_app", """{"package":"计算器"}"""), Origin.Model(1))
        assertTrue("$out", out is ActionOutcome.Ran)
        val r = (out as ActionOutcome.Ran).content
        assertFalse(r["error"]?.jsonPrimitive?.content == "app_not_found")
    }

    @Test fun tooShortNameNeverGuesses() = runBlocking {
        // 单个字母不做包含匹配:宁可回候选让模型挑,也不能凭一个字母就打开一个 App
        val r = launch("o")
        assertEquals("app_not_found", r["error"]!!.jsonPrimitive.content)
        assertTrue(r.containsKey("candidates"))
    }
}
