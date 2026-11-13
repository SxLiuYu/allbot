package com.wangzan101.mika.calls

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 下行音频的环形缓冲区。
 *
 * 云端的音频包大小不固定,这个队列负责把它们排成固定的 20ms 块写给通话管道。
 * 它是纯粹的内存搬运,但写错的方式都很安静:
 * - 环形回绕算错 → 声音在特定位置错位,听起来像杂音;
 * - 容量算错 → 要么丢音频(对方听不全),要么延迟一直累积(变成对不上话);
 * - 丢帧计数算错 → 队列认为还有数据,实际已经空转。
 *
 * 这些在真机上只表现为「接得通但听不清」,而 audio_verified 就是为了筛掉这种情况。
 * 所以先在纯逻辑层把边界钉住。
 */
class CallPlaybackQueueTest {

    /** 一拍 = 24kHz * 2 字节 / 50 = 960 字节,20 毫秒。 */
    private val writeBytes = CallPlaybackQueue.WRITE_BYTES
    private val perSecond = VolcRealtimeClient.OUTPUT_SAMPLE_RATE * 2

    private fun bytes(n: Int, seed: Int = 0) = ByteArray(n) { (it + seed).toByte() }

    /**
     * 把队列抽干。
     *
     * take() 在队列空时会挂住等信号(这是实现的设计,写协程靠它休眠),
     * 所以每抽一次都加超时:抽不到就说明空了,不是测试卡死。
     */
    private fun drain(q: CallPlaybackQueue, limit: Int = 1000): ByteArray = runBlocking {
        val out = ArrayList<Byte>()
        val buf = ByteArray(writeBytes)
        var guard = 0
        while (guard++ < limit) {
            val block = withTimeoutOrNull(1_000) { q.take(buf) } ?: break
            out.addAll(buf.take(block.byteCount))
            q.release(block)
        }
        out.toByteArray()
    }

    // ---- 基本搬运 ----

    @Test fun whatGoesInComesOutInOrder() {
        val q = CallPlaybackQueue()
        val data = bytes(writeBytes * 3)
        assertNotNull(q.offer(data))
        assertArrayEquals("有序且一段不少", data, drain(q))
        q.close()
    }

    /** 包比一拍小:要攒起来,不能每次都写半拍。 */
    @Test fun smallPacketsAreReassembledIntoWholeBlocks() {
        val q = CallPlaybackQueue()
        val half = bytes(writeBytes / 2)
        q.offer(half)
        q.offer(half.copyOf())
        val out = drain(q)
        assertEquals("两个半拍应该合成一拍", writeBytes, out.size)
        assertEquals("内容不能被拼错", half[0], out[0])
        assertEquals("第二段接在后面", half[1], out[writeBytes / 2 + 1])
        q.close()
    }

    /** 包比一拍大:要切成多拍,顺序不变。 */
    @Test fun largePacketsAreSplitButKeepOrder() {
        val q = CallPlaybackQueue()
        val big = bytes(writeBytes * 4)
        q.offer(big)
        assertArrayEquals("切成 4 拍后仍逐字节相同", big, drain(q))
        q.close()
    }

    // ---- 环形回绕 ----

    /**
     * 写到缓冲区末尾再折回开头。这是最容易写错的地方:
     * 回绕时如果少搬一段或多搬一段,后面所有音频都错位。
     *
     * 用一个不能被容量整除的写入序列,强迫发生回绕。
     */
    @Test fun wrappingPastTheEndKeepsBytesIntact() {
        val q = CallPlaybackQueue(capacityBytes = 4_096)
        // 先写到接近末尾,再写一次跨过末尾
        val first = bytes(3_600, seed = 1)
        assertEquals(3_600, q.offer(first))
        assertArrayEquals(first, drain(q))

        // 现在头指针在 3600,下一次写入会跨过 4096
        val second = bytes(1_200, seed = 7)
        assertNotNull("跨末尾的写入不该被拒", q.offer(second))
        assertArrayEquals("回绕后内容仍然逐字节正确", second, drain(q))
        q.close()
    }

    /** 连续多轮回绕,确认头指针不会越界也不会卡住。 */
    @Test fun repeatedWrapsStayCorrect() {
        val q = CallPlaybackQueue(capacityBytes = 4_096)
        repeat(6) { round ->
            val data = bytes(1_500, seed = round * 37)
            assertNotNull("第 ${round + 1} 轮放不下", q.offer(data))
            assertArrayEquals("第 ${round + 1} 轮内容错了", data, drain(q))
        }
        q.close()
    }

    // ---- 容量与背压 ----

    @Test fun capacityIsBoundedAtEightSeconds() {
        assertEquals(perSecond * 8, CallPlaybackQueue.MAX_PENDING_BYTES)
    }

    @Test fun aPacketThatDoesNotFitIsRejectedRatherThanDropped() {
        val q = CallPlaybackQueue(capacityBytes = 1_024)
        assertEquals("刚好装满可以", 1_024, q.offer(bytes(1_024)))
        assertNull("再放一个必须被拒(返回 null 让调用方去中断播放)", q.offer(bytes(2)))
        q.close()
    }

    /** 已经交出去但那块还没写回时,占用的空间也要算进去。 */
    @Test fun theInFlightBlockCountsAgainstCapacity() {
        val q = CallPlaybackQueue(capacityBytes = writeBytes * 2)
        assertEquals("两拍刚好装满", writeBytes * 2, q.offer(bytes(writeBytes * 2)))
        val block = runBlocking { q.take(ByteArray(writeBytes)) }
        assertNotNull(block)
        assertNull("一拍在飞、一拍待写,已经满了,再放必须被拒", q.offer(bytes(2)))
        q.release(block!!)
        assertNotNull("回收之后又能放了", q.offer(bytes(2)))
        q.close()
    }

    /** 奇数字节不是合法 s16le,不能进队列——否则后面每一拍都错半个采样。 */
    @Test fun oddByteCountsAreRejected() {
        val q = CallPlaybackQueue()
        assertNull("奇数字节会让整条流错位", q.offer(bytes(3)))
        q.close()
    }

    @Test fun anEmptyPacketOccupiesNothing() {
        val q = CallPlaybackQueue()
        assertEquals(0, q.offer(ByteArray(0)))
        q.close()
    }

    // ---- 作废与关闭 ----

    /**
     * 用户开口时要立刻清空待播音频。作废之后,正在写的那块必须被认出来是旧的,
     * 否则那段旧音频还会被写进管道,听起来就是 AI 抢话。
     */
    @Test fun invalidateMakesTheInFlightBlockStale() {
        val q = CallPlaybackQueue()
        q.offer(bytes(writeBytes * 2))
        val block = runBlocking { q.take(ByteArray(writeBytes)) }
        assertNotNull(block)
        assertTrue("作废前是当前块", q.isCurrent(block!!))

        q.invalidate()
        assertFalse("作废后必须认得出这是旧块", q.isCurrent(block))
        // 作废不发信号,正在 take 的协程要等管道关闭才醒;这里直接 close 收尾。
        q.close()
        assertNull("作废后队列应该是空的", runBlocking { q.take(ByteArray(writeBytes)) })
    }

    @Test fun invalidateDropsEverythingPending() {
        val q = CallPlaybackQueue()
        q.offer(bytes(writeBytes * 3))
        q.invalidate()
        // 注意:invalidate 不发信号,所以「等一个空队列」的 take 会一直挂着——
        // 真实代码里作废之后紧跟着关管道把阻塞的写唤醒,单独调 invalidate 不会。
        // 这里用 close 结束等待,断言的是「什么都不剩」而不是「take 立刻返回」。
        q.close()
        assertNull("作废就该清空", runBlocking { q.take(ByteArray(writeBytes)) })
    }

    @Test fun closeEndsTheWriterLoop() {
        val q = CallPlaybackQueue()
        q.offer(bytes(writeBytes))
        q.close()
        assertNull("关闭后 take 返回 null,写协程才知道该退出", runBlocking { q.take(ByteArray(writeBytes)) })
        assertNull("关闭后不再接受新数据", q.offer(bytes(4)))
    }

    @Test fun closingTwiceIsHarmless() {
        val q = CallPlaybackQueue()
        q.close()
        q.close()
    }

    @Test fun aZeroOrOddCapacityIsRefusedAtConstruction() {
        for (bad in listOf(0, 1, 1_001)) {
            var threw = false
            try { CallPlaybackQueue(capacityBytes = bad) } catch (_: IllegalArgumentException) { threw = true }
            assertTrue("容量 $bad 应该被拒", threw)
        }
    }

    @Test fun takeNeedsAnEvenSizedBuffer() {
        val q = CallPlaybackQueue()
        var threw = false
        try { runBlocking { q.take(ByteArray(3)) } } catch (_: IllegalArgumentException) { threw = true }
        assertTrue("奇数缓冲会让每拍错半字节", threw)
        q.close()
    }

    // ---- 出声判定 ----

    /**
     * 「这通电话真的出过声吗」是 audio_verified 的核心问题。
     * 有开场白时,光有下行不算——还要有上行,证明对方的声音真的进来了。
     */
    @Test fun audioCountsAsStartedOnlyWhenBothDirectionsMoved() {
        assertTrue("有开场白的通话,上下行都要有", callAudioHasStarted("你好", 100, 100))
        assertFalse("只有下行:对方可能根本没听到", callAudioHasStarted("你好", 100, 0))
        assertFalse("只有上行:AI 一句话没说", callAudioHasStarted("你好", 0, 100))
        assertFalse("都没有", callAudioHasStarted("你好", 0, 0))
    }

    /** 没配开场白时,下行一有声音就算。 */
    @Test fun withoutAGreetingDownstreamAloneCounts() {
        assertTrue(callAudioHasStarted("", 1, 0))
        assertTrue(callAudioHasStarted("   ", 1, 0))
        assertFalse(callAudioHasStarted("", 0, 0))
    }
}
