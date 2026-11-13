package com.wangzan101.mika.calls

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通话记录的存与取。`CallHistory.Storage` 是个接口,所以这里注入内存实现,
 * 不需要 Android 运行时就能验:容量上限、去重、覆盖顺序、写失败时不丢内存里的数据。
 *
 * 隐私边界也在这层:号码和转录确实会存(用户要回看),但 `toString()` 不吐内容——
 * 日志里打一行 `CallRecord` 不该把通话内容带出去。
 */
class CallHistoryTest {

    private class MemStore(var records: List<CallRecord> = emptyList()) : CallHistory.Storage {
        var failWrites = false
        var reads = 0
        override fun read(): List<CallRecord> { reads++; return records }
        override fun write(records: List<CallRecord>): Boolean {
            if (failWrites) return false
            this.records = records
            return true
        }
    }

    private fun record(id: String, number: String? = "13800138000", startedAt: Long = 1_000L) = CallRecord(
        id = id, number = number, direction = CallDirection.INCOMING,
        startedAtMs = startedAt, endedAtMs = startedAt + 60_000, result = "通话已收尾",
        transcript = listOf(CallTranscriptLine("caller", "你好,我找一下张先生")),
    )

    @Test fun aSavedCallComesBack() = runBlocking {
        val store = MemStore()
        val h = CallHistory(store)
        assertEquals(CallHistory.Result.SAVED, h.append(record("c1")))
        assertEquals(1, h.state.value.size)
        assertEquals("c1", store.records.single().id)
        assertEquals("13800138000", store.records.single().number)
    }

    /** 最新的排最前面,再打开时顺序不变。 */
    @Test fun newCallsGoToTheFrontAndSurviveAReload() = runBlocking {
        val store = MemStore()
        CallHistory(store).apply { append(record("a", startedAt = 1)); append(record("b", startedAt = 2)) }
        // 新的实例从同一份存储读
        val reopened = CallHistory(store)
        reopened.load()
        assertEquals(listOf("b", "a"), reopened.state.value.map { it.id })
    }

    /** 同一条重复 append 不该出现两份。 */
    @Test fun theSameIdIsNotStoredTwice() = runBlocking {
        val store = MemStore()
        val h = CallHistory(store)
        h.append(record("x"))
        h.append(record("x").copy(result = "改过"))
        assertEquals(1, h.state.value.size)
        assertEquals("改过", h.state.value.single().result)
    }

    /** 超过上限就丢最旧的:记录不能无界增长。 */
    @Test fun theHistoryIsBoundedAtFifty() = runBlocking {
        val store = MemStore()
        val h = CallHistory(store)
        repeat(CallHistory.MAX_CALLS + 5) { i -> h.append(record("c$i", startedAt = i.toLong())) }
        assertEquals(CallHistory.MAX_CALLS, h.state.value.size)
        assertEquals(CallHistory.MAX_CALLS, store.records.size)
        // 保留的是最新的那批
        assertTrue(h.state.value.any { it.id == "c${CallHistory.MAX_CALLS + 4}" })
        assertFalse(h.state.value.any { it.id == "c0" })
    }

    /**
     * 写盘失败时:返回 WRITE_FAILED、上报 writeFailed,
     * 但**内存里这一通要留着**——用户已经在看这通电话了,不能因为存储坏了就让它消失。
     */
    @Test fun aFailedWriteKeepsTheCallVisibleInMemory() = runBlocking {
        val store = MemStore().apply { failWrites = true }
        val h = CallHistory(store)
        assertEquals(CallHistory.Result.WRITE_FAILED, h.append(record("c1")))
        assertEquals("内存里要有一份", 1, h.state.value.size)
        assertTrue("要能看出存盘失败", h.writeFailed.value)
        assertTrue("存储里不该有", store.records.isEmpty())
    }

    /** 读失败时不能把存储当空表覆盖掉——那样用户的历史就没了。 */
    @Test fun anUnreadableHistoryIsNotOverwritten() = runBlocking {
        val store = object : CallHistory.Storage {
            var written: List<CallRecord>? = null
            override fun read(): List<CallRecord> = error("corrupt")
            override fun write(records: List<CallRecord>): Boolean { written = records; return true }
        }
        val h = CallHistory(store)
        assertEquals(CallHistory.Result.WRITE_FAILED, h.append(record("new")))
        assertNull("读不出来时不能写", store.written)
        assertEquals("本进程这一通仍要在", 1, h.state.value.size)
        assertTrue(h.writeFailed.value)
    }

    @Test fun handledAndDeleteWorkById() = runBlocking {
        val store = MemStore()
        val h = CallHistory(store)
        h.append(record("a")); h.append(record("b"))
        assertEquals(CallHistory.Result.SAVED, h.setHandled("a", true))
        assertTrue(h.state.value.single { it.id == "a" }.handled)
        assertEquals(CallHistory.Result.SAVED, h.delete("a"))
        assertEquals(listOf("b"), h.state.value.map { it.id })
        // 不存在的 id
        assertEquals(CallHistory.Result.NOT_FOUND, h.delete("nope"))
        assertEquals(CallHistory.Result.NOT_FOUND, h.setHandled("nope", true))
    }

    @Test fun clearRemovesEverything() = runBlocking {
        val store = MemStore()
        val h = CallHistory(store)
        h.append(record("a"))
        assertEquals(CallHistory.Result.SAVED, h.clear())
        assertTrue(h.state.value.isEmpty())
        assertTrue(store.records.isEmpty())
    }

    /**
     * 日志里打一行 CallRecord 不该带出通话内容。
     * 号码、转录都在对象里(用户要回看),但 toString 只给方向与结局。
     */
    @Test fun toStringNeverLeaksTheNumberOrTheWords() {
        val r = record("c1").copy(transcript = listOf(CallTranscriptLine("caller", "我的身份证号是123456")))
        val s = r.toString()
        s.contains("13800138000").let { assertFalse("toString 带出了号码: $s", it) }
        s.contains("身份证号").let { assertFalse("toString 带出了转录: $s", it) }
        // 每行也只给角色
        val line = r.transcript.single().toString()
        assertFalse("转录行带出了内容: $line", line.contains("身份证号"))
        assertTrue(line.contains("caller"))
    }

    /**
     * 音频报告只能是数字:它会被复制到剪贴板发给别人排查问题。
     * 号码、语音、凭据一个都不能进去。
     */
    @Test fun theAudioReportIsNumbersOnly() {
        val report = CallAudioReport(
            speechStarts = 3, completeTranscripts = 2,
            lastObservedTurn = CallAudioReport.Turn.REPLY_AUDIO_RECEIVED,
            receivedAudioBytes = 48_000, pipeWrittenBytes = 47_000, deviceAcceptedBytes = 46_000,
            inputFramesAccepted = 120, inputSignalFrames = 40,
        )
        val s = report.supportSummary()
        // 数字都在
        for (k in listOf("speech_starts=3", "complete_transcripts=2", "reply_bytes=48000",
                         "pipe_bytes=47000", "device_bytes=46000",
                         "input_frames_total=120", "input_frames_rms_gt_200_total=40")) {
            assertTrue("摘要缺 $k: $s", s.contains(k))
        }
        // 没量到的写 unknown,不能写 0
        assertTrue(s, s.contains("android_silenced_max_ms=unknown"))
        // 文本里不该出现任何非 ASCII / 可疑内容
        assertTrue("摘要里有非 ASCII: $s", s.all { it.code < 128 })
    }

    @Test fun anUnknownDeviceAcceptanceStaysUnknownNotZero() {
        val r = CallAudioReport(1, 1, CallAudioReport.Turn.SPEECH_DETECTED, 0, 0, null)
        assertNull("没量到就是 null", r.deviceAcceptedBytes)
        assertTrue(r.supportSummary().contains("device_bytes=unknown"))
        assertNotNull(r.supportSummary())
    }
}
