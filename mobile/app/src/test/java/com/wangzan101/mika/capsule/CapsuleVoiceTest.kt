package com.wangzan101.mika.capsule

import androidx.compose.ui.geometry.Rect
import com.wangzan101.mika.cap.phone.a11y.HoldGesture
import com.wangzan101.mika.i18n.ChineseTexts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** 胶囊长按说话:松开时手指落在哪个圆上、长按和拖动怎么分、发出后胶囊上闪的那句。 */
class CapsuleVoiceTest {
    @get:Rule val texts = ChineseTexts()

    private val cancel = Rect(100f, 200f, 162f, 262f)
    private val edit = Rect(300f, 200f, 362f, 262f)

    @Test fun insideCancelCircleIsCancel() {
        assertEquals(CapsuleVoice.Drop.Cancel, CapsuleVoice.drop(130f, 230f, cancel, edit, slopPx = 14))
    }

    @Test fun justOutsideCancelCircleStillCancels() {
        // 圆外 10px,外扩 14px 以内
        assertEquals(CapsuleVoice.Drop.Cancel, CapsuleVoice.drop(90f, 230f, cancel, edit, slopPx = 14))
        assertEquals(CapsuleVoice.Drop.Cancel, CapsuleVoice.drop(130f, 272f, cancel, edit, slopPx = 14))
    }

    @Test fun farFromBothCirclesIsSend() {
        assertEquals(CapsuleVoice.Drop.Send, CapsuleVoice.drop(230f, 900f, cancel, edit, slopPx = 14))
        // 两个圆中间、都不够近
        assertEquals(CapsuleVoice.Drop.Send, CapsuleVoice.drop(231f, 230f, cancel, edit, slopPx = 14))
    }

    @Test fun insideEditCircleIsEdit() {
        assertEquals(CapsuleVoice.Drop.Edit, CapsuleVoice.drop(330f, 230f, cancel, edit, slopPx = 14))
    }

    @Test fun circlesNotLaidOutYetMeanSend() {
        // 面板还没排好版(圆的位置还没报上来)时不会误判成取消
        assertEquals(CapsuleVoice.Drop.Send, CapsuleVoice.drop(0f, 0f, Rect.Zero, Rect.Zero, slopPx = 14))
    }

    @Test fun smallMoveThenTimeoutIsHold() {
        val g = HoldGesture(slopPx = 8f)
        assertEquals(HoldGesture.Kind.Tap, g.down())
        assertEquals(HoldGesture.Kind.Tap, g.move(5f))
        assertEquals(HoldGesture.Kind.Hold, g.timeout())
        // 长按以后再怎么移都还是长按,不变成拖
        assertEquals(HoldGesture.Kind.Hold, g.move(200f))
    }

    @Test fun movedPastSlopFirstIsDragAndNeverHold() {
        val g = HoldGesture(slopPx = 8f)
        g.down()
        assertEquals(HoldGesture.Kind.Drag, g.move(20f))
        assertEquals(HoldGesture.Kind.Drag, g.timeout())
        assertEquals(HoldGesture.Kind.Drag, g.move(2f))
    }

    @Test fun newDownStartsOver() {
        val g = HoldGesture(slopPx = 8f)
        g.down()
        g.move(20f)
        assertEquals(HoldGesture.Kind.Tap, g.down())
        assertEquals(HoldGesture.Kind.Hold, g.timeout())
    }

    @Test fun sentNoteSaysWhatHappenedWithTheFirstWords() {
        assertEquals("已插话：要下午三点以后的，二等座…", CapsuleVoice.sent(CardInputKind.Steer, "要下午三点以后的，二等座靠窗"))
        assertEquals("已回答：明天上午", CapsuleVoice.sent(CardInputKind.Answer, "明天上午"))
        assertEquals("已发出：查一下天气", CapsuleVoice.sent(CardInputKind.Continue, "查一下天气"))
        assertEquals("已发出：查一下天气", CapsuleVoice.sent(CardInputKind.Start, "查一下天气"))
    }

    @Test fun stopWordsInterruptOnlyWhenTheWholeLineIsIt() {
        assertTrue(isStopWord("停"))
        assertTrue(isStopWord("  停下  "))
        assertTrue(isStopWord("Cancel"))
        assertTrue(isStopWord("STOP"))
        // 正常指令里带「停」不算打断
        assertTrue(!isStopWord("帮我停车缴费"))
        assertTrue(!isStopWord("查一下取消订单的入口"))
        assertTrue(!isStopWord(""))
    }
}
