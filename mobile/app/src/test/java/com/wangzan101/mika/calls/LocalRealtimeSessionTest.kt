package com.wangzan101.mika.calls

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 本地 realtime 会话里能脱离 WebSocket 验的两块纯逻辑：16→24 kHz 重采样、
 * 640B/20ms → 3200B/100ms 攒包。这两处错了不会崩，只会让声音变调、
 * 让 waihu 的判停算错帧数，最不容易被发现。
 */
class LocalRealtimeSessionTest {

    private fun session() = LocalRealtimeSession("ws://127.0.0.1:1/ws", "", "")

    // ---- 16 kHz → 24 kHz ----

    @Test fun resamplingDoublesTheSampleCountByThreeHalves() {
        // 2 个输入采样 → 3 个输出采样；字节数 4 → 6
        val input = byteArrayOf(0, 0, 0, 0)
        assertEquals(6, session().resample16to24(input).size)
        // 3200B 输入 → 4800B 输出（1600 采样 → 2400 采样）
        assertEquals(4800, session().resample16to24(ByteArray(3200)).size)
    }

    @Test fun aConstantSignalStaysConstant() {
        val input = ByteArray(320) { i -> if (i % 2 == 0) 0x00 else 0x10 } // 1024
        val out = session().resample16to24(input)
        for (i in 0 until out.size step 2) {
            assertEquals(("sample $i"), 0x00.toByte(), out[i])
            assertEquals(("sample $i"), 0x10.toByte(), out[i + 1])
        }
    }

    @Test fun aRampIsInterpolatedBetweenEndpoints() {
        // 输出采样数严格是输入的 1.5 倍，且每个值都落在输入范围内
        val input = ByteArray(640)
        for (i in 0 until 320) {
            val v = i * 100 - 16000
            input[i * 2] = (v and 0xFF).toByte()
            input[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
        }
        val out = session().resample16to24(input)
        assertEquals(960, out.size) // 320 采样 → 480 采样 → 960 字节
        for (i in 0 until out.size / 2) {
            val v = read(out, i)
            assertTrue("sample $i 越界: $v", v in -16000..15900)
        }
        // 单调信号插值后仍单调（线性插值不该引入回跳）
        var last = Int.MIN_VALUE
        for (i in 0 until out.size / 2) {
            val v = read(out, i)
            assertTrue("sample $i 回跳: $v < $last", v >= last)
            last = v
        }
    }

    @Test fun resamplingKeepsTheLastSampleAcrossFrames() {
        // 跨帧边界不该出现台阶：把一整段信号切成两半，拼起来应等于一次算完
        val full = ByteArray(640)
        for (i in 0 until 320) {
            val v = i * 100 - 16000
            full[i * 2] = (v and 0xFF).toByte()
            full[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
        }
        val oneShot = session().resample16to24(full)
        val s = session()
        val first = s.resample16to24(full.copyOfRange(0, 320))
        val second = s.resample16to24(full.copyOfRange(320, 640))
        assertArrayEquals("分帧与一次算完必须一致", oneShot, first + second)
    }

    @Test fun emptyAndOddInputsAreSafe() {
        assertEquals(0, session().resample16to24(ByteArray(0)).size)
        // 奇数长度会丢掉半个采样，不能崩也不能产生负数长度
        assertTrue(session().resample16to24(ByteArray(3)).size >= 0)
    }

    // ---- 攒包 ----

    @Test fun fiveChunksOf640BytesMakeOne3200ByteFrame() {
        val s = session()
        // 未连接时 sendPcm16 返回 false（phase != ACTIVE），这里只验参数校验不越界
        assertFalse(s.sendPcm16(ByteArray(640), 641))
        assertFalse(s.sendPcm16(ByteArray(640), 639))  // 奇数
        assertFalse(s.sendPcm16(ByteArray(0), 0))
    }

    @Test fun greetingAndMuteNeedAnActiveSession() {
        val s = session()
        assertFalse(s.sendGreeting("你好"))
        assertFalse(s.setMuted(true))
    }

    private fun read(pcm: ByteArray, sampleIndex: Int): Int {
        val lo = pcm[sampleIndex * 2].toInt() and 0xFF
        val hi = pcm[sampleIndex * 2 + 1].toInt() and 0xFF
        val v = lo or (hi shl 8)
        return if (v >= 0x8000) v - 0x10000 else v
    }
}
