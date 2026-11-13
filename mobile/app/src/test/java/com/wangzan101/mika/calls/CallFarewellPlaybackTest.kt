package com.wangzan101.mika.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 挂断的时机。
 *
 * AI 说完「再见」之后不能马上挂电话——声音还在管道里，挂了对方就听不到最后一句。
 * 但也不能一直不挂。这一层管的就是「确认那句再见真的放完了没有」。
 *
 * 判断错的两个方向:
 * - 放完没确认就挂 → 对方听到半句断掉;
 * - 永远认为没放完 → 电话挂不掉,一直耗到通话上限。
 */
class CallFarewellPlaybackTest {

    private fun playbackWithCallerTurn(text: String = "那先这样吧", complete: Boolean = true) =
        CallFarewellPlayback().apply { callerFinal(text, complete) }

    /** 必须「这轮对方说完了」才可能产生收尾,半句不行。 */
    @Test fun anIncompleteCallerTurnIsNotEligible() {
        val p = playbackWithCallerTurn("那先", complete = false)
        p.audioStarted(); p.audio(1_000); p.audioEnded(); p.assistantFinal("那就先这样吧")
        assertNull("对方话还没说完就想着挂", p.takeFence())
    }

    @Test fun aBlankCallerTurnIsNotEligible() {
        val p = playbackWithCallerTurn("   ", complete = true)
        p.audioStarted(); p.audio(1_000); p.audioEnded(); p.assistantFinal("那就先这样吧")
        assertNull(p.takeFence())
    }

    /** 正常路径:对方说完 → AI 回了一句收尾 → 音频放完 → 可以挂了。 */
    @Test fun aCompleteTurnPlusClosingProducesAFence() {
        // 用明确的告别词:「那先这样吧」属于 CLOSING_CONTEXT,不算 explicit
        val p = playbackWithCallerTurn("再见")
        p.audioStarted()
        p.audio(2_400)
        p.audioEnded()
        p.assistantFinal("好的,那就先这样")
        val fence = p.takeFence()
        assertNotNull("该挂的时候没给闸门", fence)
        assertTrue("这句是对方明确的告别", fence!!.explicit)
        assertTrue("数据字节应该是偶数且不为 0", fence.dataBytes > 0 && fence.dataBytes % 2 == 0L)
    }

    /** AI 那句不是收尾(还在办事),就不该挂。 */
    @Test fun aNonClosingAssistantLineCancelsTheCandidate() {
        val p = playbackWithCallerTurn("那先这样吧")
        p.audioStarted(); p.audio(1_000); p.audioEnded()
        p.assistantFinal("那还需要我帮您问别的吗")
        assertNull("还在办事就挂电话", p.takeFence())
    }

    /** 没有音频(只出了文字):不算说过再见,不能挂。 */
    @Test fun textWithoutAudioDoesNotCount() {
        val p = playbackWithCallerTurn("那先这样吧")
        p.audioStarted()          // 没有任何 audio() 字节
        p.audioEnded()
        p.assistantFinal("那就先这样吧")
        assertNull("没真出声就挂", p.takeFence())
    }

    /** 收尾之前的那段音频不算:必须是 AI 开口之后才产生的字节。 */
    @Test fun audioBeforeTheReplyDoesNotCount() {
        val p = CallFarewellPlayback()
        p.audio(5_000)            // 上一轮的音频
        p.callerFinal("那先这样吧", true)
        p.audioStarted()          // 这一轮从 5000 开始
        p.audioEnded()            // 没有新增字节
        p.assistantFinal("那就先这样吧")
        assertNull("只有上一轮的音频,本轮没出声", p.takeFence())
    }

    /** 取出一次之后要清掉,避免同一通电话挂两次。 */
    @Test fun aFenceIsTakenOnlyOnce() {
        val p = playbackWithCallerTurn()
        p.audioStarted(); p.audio(1_000); p.audioEnded(); p.assistantFinal("那就先这样吧")
        assertNotNull(p.takeFence())
        assertNull("同一个收尾不该挂两次", p.takeFence())
    }

    /** flush 之后 epoch 变了,旧的候选作废。 */
    @Test fun aFlushInvalidatesTheCandidate() {
        val p = playbackWithCallerTurn()
        p.audioStarted(); p.audio(1_000); p.audioEnded(); p.assistantFinal("那就先这样吧")
        p.afterPairedFlush()
        assertNull("flush 之后旧候选要作废", p.takeFence())
        assertFalse("flush 之后计数归零", p.hasPlaybackSinceFlush)
    }

    /**
     * 已经开过一次口之后又来一次 audioStarted:候选被取消,这一轮不再可能收尾。
     * 实现就是这么定的(`audioStarted` 里 responseStartBytes 非空就 cancelCandidate)。
     * 记下来,免得以后有人以为「重开一次会重新计时」。
     */
    @Test fun aSecondAudioStartCancelsTheCandidate() {
        val p = playbackWithCallerTurn()
        p.audioStarted()
        p.audio(500)
        p.audioStarted()
        p.audio(300)
        p.audioEnded()
        p.assistantFinal("那就先这样吧")
        assertNull("重开一次开口,本轮不再收尾", p.takeFence())
    }

    // ---- 闸门本身 ----

    private val fence = CallFarewellFence(epoch = 4, dataBytes = 1_000, explicit = true)

    @Test fun theFenceNeedsTheWholeChainToLineUp() {
        fun ok(playedEpoch: Long = 4, accepted: Long = 1_000, prime: Long = 480, played: Long = 980,
               fresh: Boolean = true, routed: Boolean = true) =
            fence.reached(playedEpoch, accepted, prime, played, fresh, routed)

        assertTrue("正常放完", ok())
        assertFalse("epoch 对不上(中间 flush 过)", ok(playedEpoch = 2))
        assertFalse("实际接收的字节数不同", ok(accepted = 900))
        assertFalse("不是新一轮的数据", ok(fresh = false))
        assertFalse("路由不对,声音没走到通话通道", ok(routed = false))
        assertFalse("还没开始放前置静音", ok(prime = 0))
        assertFalse("播放帧数还没到前置静音", ok(played = 400))
        // 前置静音之后要放满 dataBytes/2 帧(16 bit 一帧两字节)
        assertFalse("只放了一半", ok(played = 480 + 250))
        assertTrue("刚好放满", ok(played = 480 + 500))
    }

    /** 数据字节是 0 或奇数:不是合法 PCM 长度,不能拿来判「放完了」。 */
    @Test fun aFenceWithBadByteCountIsNeverReached() {
        val zero = CallFarewellFence(1, 0, true)
        assertFalse(zero.reached(1, 0, 480, 9_999, fresh = true, routed = true))
        val odd = CallFarewellFence(1, 1_001, true)
        assertFalse("奇数字节不是合法 s16le", odd.reached(1, 1_001, 480, 9_999, fresh = true, routed = true))
    }
}
