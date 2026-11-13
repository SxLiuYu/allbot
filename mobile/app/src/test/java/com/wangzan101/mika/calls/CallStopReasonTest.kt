package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 这通电话最后到底是「为什么」结束的。
 *
 * 通话结束的路子有很多:用户挂的、时长到上限、火山断线、音频积压、用户开口打断……
 * 但它们经常同时发生,而且谁先谁后不确定。这个类保证**只留第一条原因**,
 * 后面来的都不算——否则通话历史里写的可能是最后一个抵达的事件,而不是真正的原因。
 *
 * 唯一的例外是 refine:一个「超时」在真正确认挂断成功之后,可以改写成更准确的描述。
 * 只有它会动已经记下的值,而且只在预期值匹配时才改。
 */
class CallStopReasonTest {

    @Test fun theFirstReasonWins() {
        val r = CallStopReason()
        assertNull("一开始没有原因", r.value)
        assertTrue("第一条要能记下来", r.record("用户挂断"))
        assertEquals("用户挂断", r.value)
    }

    /** 后来的原因不能覆盖已经记下的那条,也不能声称自己记成功了。 */
    @Test fun laterReasonsAreIgnored() {
        val r = CallStopReason()
        r.record("用户挂断")
        assertFalse("第二条要被拒", r.record("时长上限"))
        assertEquals("原因不能被覆盖", "用户挂断", r.value)
    }

    /**
     * 同一条原因重复上报也要拒。实现里多个协程可能同时走到收尾,
     * 返回值被用来决定「这次是不是我负责收尾」,重复返回 true 会导致挂两次。
     */
    @Test fun recordingTheSameReasonTwiceIsStillRejected() {
        val r = CallStopReason()
        assertTrue(r.record("结束"))
        assertFalse("同样的话第二次不算功劳", r.record("结束"))
    }

    /** refine 只改自己认识的那个值,别的值一律不动。 */
    @Test fun refineOnlyRewritesTheExpectedReason() {
        val r = CallStopReason()
        r.record("等待超时")
        r.refine("等待超时", "时长达到上限,Android 已挂断")
        assertEquals("预期值要能被改写", "时长达到上限,Android 已挂断", r.value)
    }

    @Test fun refineLeavesOtherReasonsAlone() {
        val r = CallStopReason()
        r.record("用户挂断")
        r.refine("等待超时", "时长达到上限")
        assertEquals("不是预期值就不该动", "用户挂断", r.value)
    }

    /** 什么都还没记时,refine 不能凭空写进一个值。 */
    @Test fun refineOnAnEmptyReasonDoesNothing() {
        val r = CallStopReason()
        r.refine("等待超时", "时长达到上限")
        assertNull("没记过就不该有值", r.value)
    }

    /**
     * 真实顺序:先挂断(记「正在结束通话」),挂断成功后 refine 成更准确的描述。
     * 这是唯一会改值的路径,走一遍确认链路通。
     */
    @Test fun theFarewellEndingIsRefinedAfterTheHangupConfirms() {
        val r = CallStopReason()
        val ending = "通话已收尾，正在结束通话"
        assertTrue(r.record(ending))
        assertEquals(ending, r.value)
        r.refine(ending, "通话已收尾，Android 已挂断")
        assertEquals("确认挂断后改写成人话", "通话已收尾，Android 已挂断", r.value)
        // 改写之后仍然是终态,再来的原因进不去
        assertFalse(r.record("用户挂断"))
    }
}
