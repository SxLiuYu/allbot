package com.wangzan101.mika.core.tool

import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.UnseenField
import com.wangzan101.mika.core.uistate.Verification
import com.wangzan101.mika.core.uistate.VisibleTextLine
import com.wangzan101.mika.core.vision.JvmTestImageOps
import com.wangzan101.mika.core.vision.LocScreen
import com.wangzan101.mika.core.vision.VisionService
import com.wangzan101.mika.core.vision.says
import com.wangzan101.mika.core.vision.uiEl
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 树里读不到输入框时,全选可能没生效,粘贴就成了追加。真机上出现过同一条消息被粘两遍、
 * 工具却一直报 ok(verification=unknown),模型只好反复重试。这里钉住三道闸:
 * 输入框那一行已经连着两份时不再写;同一段字没确认过再写被拦;清空之后可以重写。
 */
class TypeDuplicateTest {
    private val msg = "今天中午12点提醒老婆早点去吃饭"

    private fun line(text: String, top: Int) = VisibleTextLine(text, listOf(0, top, 999, top + 60))

    private class PasteScreen(
        var visible: List<VisibleTextLine>?,
        private val after: List<VisibleTextLine>? = visible,
        private val inner: LocScreen = LocScreen(listOf(uiEl("@e1", "输入框", listOf(0, 100, 999, 160)))),
    ) : ScreenPort by inner {
        val calls = mutableListOf<String>()
        override suspend fun readVisibleText(): List<VisibleTextLine>? = visible
        override suspend fun typeAt(x: Int, y: Int, text: String): ActionResult {
            calls += "typeAt $x,$y $text"
            visible = after
            return ActionResult.Ok(changed = true, verification = Verification.UNKNOWN)
        }
        override suspend fun clearAt(x: Int, y: Int): ActionResult {
            calls += "clearAt $x,$y"
            visible = emptyList()
            return ActionResult.Ok(changed = true)
        }
    }

    private var seq = 0
    private fun call(name: String, args: String) = Part.ToolCall("t${++seq}", name, args)
    private fun d(s: ScreenPort) = toolDispatcher(s, vision = VisionService(says(), JvmTestImageOps))
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun adjacentCopiesAreDuplicatesButSeparatedOnesAreNot() {
        assertTrue(UnseenField.duplicated(listOf(line(msg, 840), line(msg, 920)), msg))
        // 聊天气泡里本来有这句话、中间隔着别的行时不算
        assertFalse(UnseenField.duplicated(listOf(line(msg, 840), line("上午11:13", 920), line(msg, 1000)), msg))
        assertFalse(UnseenField.duplicated(null, msg))
    }

    @Test fun alreadyDoubledTextIsNotPastedAgain() = runTest {
        val s = PasteScreen(listOf(line(msg, 840), line(msg, 920)))
        val r = d(s).execute(call("phone_type_text", """{"text":"$msg","x":500,"y":900}""")).content
        assertEquals("duplicate_text", r.s("error"))
        assertTrue(s.calls.isEmpty())
    }

    @Test fun pasteThatAppendsASecondCopyIsReported() = runTest {
        val s = PasteScreen(listOf(line(msg, 840)), after = listOf(line(msg, 840), line(msg, 920)))
        val r = d(s).execute(call("phone_type_text", """{"text":"$msg","x":500,"y":900}""")).content
        assertEquals("duplicate_text", r.s("error"))
        // 这一次确实写了,结果如实说写成了两份,不给模型「成功」的错觉
        assertEquals(1, s.calls.size)
        assertTrue(r.s("message").contains("Select all"))
    }

    @Test fun sameTextTwiceWithoutConfirmationIsBlocked() = runTest {
        val s = PasteScreen(listOf(line(msg, 840)), after = listOf(line(msg, 840)))
        val d = d(s)
        val first = d.execute(call("phone_type_text", """{"text":"$msg","x":500,"y":900}""")).content
        assertEquals("true", first.s("ok"))
        assertEquals("true", first.s("needsCheck"))
        // 读不回来、字还在:第二次原样写会被拦,不会再贴出一份
        val second = d.execute(call("phone_type_text", """{"text":"$msg","x":500,"y":900}""")).content
        assertEquals("unconfirmed_type", second.s("error"))
        assertEquals(1, s.calls.size)
    }

    @Test fun clearingLetsTheSameTextBeTypedAgain() = runTest {
        val s = PasteScreen(listOf(line(msg, 840)), after = listOf(line(msg, 840)))
        val d = d(s)
        d.execute(call("phone_type_text", """{"text":"$msg","x":500,"y":900}"""))
        val cleared = d.execute(call("phone_clear_text", """{"x":500,"y":900}""")).content
        assertEquals("true", cleared.s("ok"))
        val again = d.execute(call("phone_type_text", """{"text":"$msg","x":500,"y":900}""")).content
        assertEquals("true", again.s("ok"))
    }

    /** 有的框(网页画布里的搜索框)读不回自己的字,但字已经进去了。 */
    private class MismatchScreen(
        var visible: List<VisibleTextLine>?,
        private val after: List<VisibleTextLine>,
    ) : ScreenPort by LocScreen(listOf(uiEl("@e1", "搜索框", listOf(0, 100, 999, 160)))) {
        override suspend fun readVisibleText(): List<VisibleTextLine>? = visible
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String): ActionResult {
            visible = after
            return ActionResult.Ok(changed = true, verification = Verification.MISMATCH)
        }
    }

    @Test fun fieldThatReadsBackNothingButShowsTheTextIsNotReportedAsFailed() = runTest {
        val s = MismatchScreen(listOf(line("搜索", 120)), listOf(line("醋焖排骨做法", 120)))
        val d = d(s)
        d.execute(call("phone_observe", "{}"))
        val r = d.execute(call("phone_type_text", """{"text":"醋焖排骨做法","ref":"@e1","snapshotId":"s"}""")).content
        assertEquals("true", r.s("ok"))
        // 报「没核对上」而不是「没写进去」:后者会让模型再写一遍,叠成两份
        assertEquals("unknown", r.s("verification"))
        assertEquals("true", r.s("needsCheck"))
    }

    @Test fun fieldThatShowsNothingIsStillReportedAsNotApplied() = runTest {
        val s = MismatchScreen(listOf(line("搜索", 120)), listOf(line("搜索", 120)))
        val d = d(s)
        d.execute(call("phone_observe", "{}"))
        val r = d.execute(call("phone_type_text", """{"text":"醋焖排骨做法","ref":"@e1","snapshotId":"s"}""")).content
        assertEquals("action_not_applied", r.s("error"))
    }
}
