package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 简单拨号到结构化任务的映射。
 *
 * 规则是刻意的：用户写的整句原样进 `goal`，不拆 questions/constraints。拆错的代价是
 * 漏掉「不要预订」这类限制，比多给模型一点文字严重得多。
 */
class CallSimpleDialTest {

    @Test
    fun requestBecomesGoalVerbatim() {
        val text = "问周五晚上有没有两个人的位置，记下价格，不要替我预订。"
        val brief = CallSimpleDial.brief(text)
        assertEquals(text, brief?.goal)
        assertEquals("不该凭空生成必问事项", emptyList<String>(), brief?.questions)
        assertEquals("", brief?.context)
        assertEquals("", brief?.constraints)
    }

    @Test
    fun surroundingWhitespaceIsTrimmed() {
        assertEquals("问一下价格", CallSimpleDial.brief("  \n 问一下价格 \t ")?.goal)
    }

    @Test
    fun blankRequestMeansNoTask() {
        // 空要求 = 只按号码打，不附带本次任务；不能伪造一个空 goal。
        assertNull(CallSimpleDial.brief(""))
        assertNull(CallSimpleDial.brief("   \n\t "))
    }

    @Test
    fun tooLongRequestIsRejected() {
        val atLimit = "字".repeat(CallSimpleDial.MAX_REQUEST_CHARS)
        val overLimit = "字".repeat(CallSimpleDial.MAX_REQUEST_CHARS + 1)
        assertEquals(atLimit, CallSimpleDial.brief(atLimit)?.goal)
        assertNull("超长要求要拒，不能截断后偷偷拨出去", CallSimpleDial.brief(overLimit))
    }

    @Test
    fun canDialRequiresValidNumber() {
        assertTrue(CallSimpleDial.canDial("13800138000", ""))
        assertTrue(CallSimpleDial.canDial("+86 138 0013 8000", "问一下"))
        assertFalse("紧急号码不能拨", CallSimpleDial.canDial("110", ""))
        assertFalse("短号不能拨", CallSimpleDial.canDial("10086", ""))
        assertFalse(CallSimpleDial.canDial(null, ""))
        assertFalse(CallSimpleDial.canDial("", ""))
    }

    @Test
    fun canDialRejectsOverlongRequest() {
        val over = "字".repeat(CallSimpleDial.MAX_REQUEST_CHARS + 1)
        assertFalse(CallSimpleDial.canDial("13800138000", over))
    }
}
