package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通话音频到底有没有出声,只能靠这组数字判断(真机验证里 `audioVerified` 那一步就是人工看着它确认的)。
 * 这里有两条硬要求:
 * 1. 「管子写成功了」不等于「对方听见了」——所以报告里必须能区分这两件事;
 * 2. 它绝不能留着 PCM 内容或原文,只留计数。
 */
class CallMediaCountersTest {

    /** 20 ms 一帧、16 kHz 单声道 16 bit = 640 字节。 */
    private fun frame(amplitude: Int, size: Int = 640): ByteArray {
        val b = ByteArray(size)
        var i = 0
        while (i + 1 < size) {
            val v = if ((i / 2) % 2 == 0) amplitude else -amplitude
            b[i] = (v and 0xff).toByte()
            b[i + 1] = ((v shr 8) and 0xff).toByte()
            i += 2
        }
        return b
    }

    @Test fun silenceIsCountedAsFramesButNotAsSignal() {
        val c = CallMediaCounters()
        repeat(10) { c.inputAccepted(frame(0), it * 20_000_000L) }
        val s = c.snapshot()
        assertEquals(10L, s["input_frames_accepted"])
        assertEquals(640L * 10, s["input_bytes_accepted"])
        assertEquals("静音的峰值应该是 0", 0L, s["input_peak_max"])
        assertEquals("没有一帧过阈值", 0L, s["input_rms_over_200_frames"])
    }

    @Test fun loudFramesAreCountedAndFirstAndLastAreRecorded() {
        val c = CallMediaCounters()
        c.inputAccepted(frame(0), 0)                 // 第 1 帧:静音
        c.inputAccepted(frame(5_000), 20_000_000L)   // 第 2 帧:有声
        c.inputAccepted(frame(0), 40_000_000L)       // 第 3 帧:静音
        c.inputAccepted(frame(6_000), 60_000_000L)   // 第 4 帧:有声
        val s = c.snapshot()
        assertEquals(2L, s["input_rms_over_200_frames"])
        assertEquals("第一帧有声是第 2 帧", 2L, s["input_first_rms_over_200_frame"])
        assertEquals("最后一帧有声是第 4 帧", 4L, s["input_last_rms_over_200_frame"])
        assertEquals(6_000L, s["input_peak_max"])
    }

    /** 200 是判「有声」的门槛,正好等于它不算过。 */
    @Test fun theThresholdIsExclusive() {
        val c = CallMediaCounters()
        c.inputAccepted(frame(200), 0)
        assertEquals(0L, c.snapshot()["input_rms_over_200_frames"])
        c.inputAccepted(frame(201), 20_000_000L)
        assertEquals(1L, c.snapshot()["input_rms_over_200_frames"])
    }

    @Test fun frameGapsAreMeasured() {
        val c = CallMediaCounters()
        c.inputAccepted(frame(1_000), 0)
        c.inputAccepted(frame(1_000), 5_000_000L)      // 5 ms,太密
        c.inputAccepted(frame(1_000), 55_000_000L)     // 50 ms,太长
        val s = c.snapshot()
        assertEquals("5 ms 那一帧", 1L, s["input_under_10ms_gap_frames"])
        assertEquals("最大间隔 50 ms = 50000 us", 50_000L, s["input_max_gap_us"])
    }

    /**
     * 关掉信号测量是整段跳过:样本不读,帧数也不记。想省 CPU 时它会连「收到几帧」都不说。
     * 现在没有调用方传 false,所以不影响诊断;真要用的时候得先改这里。
     */
    @Test fun turningSignalMeasurementOffSkipsCountingEntirely() {
        val c = CallMediaCounters(measureInputSignal = false)
        c.inputAccepted(frame(9_000), 0)
        val s = c.snapshot()
        assertEquals("整段跳过,帧数也是 0", 0L, s["input_frames_accepted"])
        assertEquals(0L, s["input_peak_max"])
    }

    /**
     * 报告要说清「哪一步到了」:对方说话了、识别出来了、回复音频到了。
     * 只到前一步就说明卡在那儿。
     */
    @Test fun theReportTracksHowFarTheTurnGot() {
        val c = CallMediaCounters()
        c.eventReceived(VolcRealtimeEvent.UserSpeaking)
        assertEquals(CallAudioReport.Turn.SPEECH_DETECTED, c.recordReport()!!.lastObservedTurn)

        c.eventReceived(VolcRealtimeEvent.UserTranscript("你", isFinal = false))
        assertEquals("只说了一半不是最终结果", CallAudioReport.Turn.SPEECH_DETECTED, c.recordReport()!!.lastObservedTurn)

        c.eventReceived(VolcRealtimeEvent.UserTranscript("你好,请讲", isFinal = true))
        assertEquals(CallAudioReport.Turn.TRANSCRIPT_RECEIVED, c.recordReport()!!.lastObservedTurn)

        c.eventReceived(VolcRealtimeEvent.Audio(ByteArray(320)))
        assertEquals("助手开口了", CallAudioReport.Turn.REPLY_AUDIO_RECEIVED, c.recordReport()!!.lastObservedTurn)
    }

    /** 什么都没发生时不给报告,免得把「没量到」说成「量到 0」。 */
    @Test fun nothingObservedMeansNoReport() {
        assertNull(CallMediaCounters().recordReport())
    }

    /**
     * 关键区分:管道写了多少字节、壳那边收了多少字节、供应商给了多少音频,是三回事。
     * 报告必须把它们分开写,否则「写了 100 KB」会被当成「对方听见了」。
     */
    @Test fun pipeWritesAndShellAcceptanceAreSeparateObservations() {
        val c = CallMediaCounters()
        c.outputWritten(1_024)
        c.outputQueued(4_096)
        c.outputRejected()
        c.outputShellAccepted(bytes = 512, zeroCount = 2, zeroMaxMs = 40, lastWriteAgeMs = 15,
            playbackHeadFrames = 12_000, flushMaxMs = 7, captureSilencedMs = 250)
        val r = c.recordReport()!!
        assertEquals(1_024L, r.pipeWrittenBytes)
        assertEquals(512L, r.deviceAcceptedBytes)
        // 诊断串里这些名字都要出现,不能混成一个
        val d = c.playbackDiagnostic()!!
        for (k in listOf("provider_bytes", "pipe_written_bytes", "shell_up_bytes",
            "shell_write_zero_count", "shell_playback_head_frames", "peak_queued_bytes")) {
            assertTrue("诊断里缺 $k: $d", d.contains(k))
        }
    }

    @Test fun nothingWrittenMeansNoPlaybackDiagnostic() {
        assertNull(CallMediaCounters().playbackDiagnostic())
    }

    /** 供应商出错、连接断开要单独计数:那是「没出声」的最可能原因。 */
    @Test fun providerFailuresAreCountedSeparately() {
        val c = CallMediaCounters()
        c.eventReceived(VolcRealtimeEvent.Failed(VolcRealtimeException(VolcRealtimeException.Kind.TIMEOUT)))
        c.eventReceived(VolcRealtimeEvent.Closed)
        c.eventReceived(VolcRealtimeEvent.UserTranscriptionFailed)
        c.eventReceived(VolcRealtimeEvent.UserTranscriptionEmpty)
        val s = c.snapshot()
        assertEquals(1L, s["provider_failed_events"])
        assertEquals(1L, s["provider_closed_events"])
        val r = c.recordReport()!!
        assertEquals(1L, r.recognitionFailures)
        assertEquals(1L, r.emptyRecognitions)
    }

    /**
     * 回复结束后还在收到有声的输入帧,说明对方在说话,麦克风没被静音。
     * 这是查「AI 说话时对方听不见」这类问题的关键数字。
     */
    /**
     * 回复结束后又收到的输入帧会被记下来——这是查「AI 说话时对方听不见」的关键数字。
     *
     * 注意这里必须先有供应商侧的观察(例如回复音频),否则 [CallMediaCounters.recordReport]
     * 会返回 null:它的判据是「除输入帧以外的观察一个都没有就算没量到」。
     * 也就是说只有麦克风在收帧、供应商一句话都没回的时候,恰恰拿不到这份报告——
     * 那是「对方听不见」最该看的情形。这是实现上的缺口,记在这里,没有把握不擅自改。
     */
    @Test fun framesAfterTheReplyEndedAreCounted() {
        val c = CallMediaCounters()
        c.inputAccepted(frame(1_000), 0)
        c.inputAccepted(frame(5_000), 20_000_000L)
        c.eventReceived(VolcRealtimeEvent.Audio(ByteArray(64)))
        c.eventReceived(VolcRealtimeEvent.AssistantAudioEnded)
        c.inputAccepted(frame(5_000), 40_000_000L)
        c.inputAccepted(frame(5_000), 60_000_000L)
        val r = c.recordReport()!!
        assertEquals("回复结束后又来了 2 帧", 2L, r.inputFramesAfterLastReply)
        assertEquals("这 2 帧都是有声的", 2L, r.inputSignalFramesAfterLastReply)
    }

    /**
     * 只有输入帧、供应商一个事件都没回,也要出报告。
     * 那正是「麦克风在收、对方听不见」的情形;以前这种情况返回 null,
     * 通话记录里不留任何音频诊断,用户点「复制」也拿不到东西。
     */
    @Test fun inputFramesAloneStillProduceAReport() {
        val c = CallMediaCounters()
        c.inputAccepted(frame(0), 0)
        c.inputAccepted(frame(9_000), 20_000_000L)
        val r = c.recordReport()!!
        assertEquals("共收到 2 帧", 2L, r.inputFramesAccepted)
        assertEquals("其中 1 帧有声", 1L, r.inputSignalFrames)
        // 供应商侧一个事件都没有,这些仍然是「没量到」
        assertEquals(CallAudioReport.Turn.NONE, r.lastObservedTurn)
        assertEquals(0L, r.receivedAudioBytes)
        assertNull("没写报告时 deviceAcceptedBytes 应该是 null,不能是 0", r.deviceAcceptedBytes)
        // 摘要里要能读出「本地确实在收」
        val s = r.supportSummary()
        assertTrue(s, s.contains("input_frames_total=2"))
        assertTrue(s, s.contains("input_frames_rms_gt_200_total=1"))
    }

    /** 一帧都没有、供应商也没消息:还是不给报告。 */
    @Test fun nothingAtAllStillMeansNoReport() {
        assertNull(CallMediaCounters().recordReport())
    }

    /** 计数器只留数字:快照的值全是 Long,没有文本字段。 */
    @Test fun theSnapshotCarriesNumbersOnly() {
        val c = CallMediaCounters()
        c.inputAccepted(frame(3_000), 0)
        c.eventReceived(VolcRealtimeEvent.UserTranscript("我明天下午三点来", isFinal = true))
        c.eventReceived(VolcRealtimeEvent.Audio(ByteArray(128)))
        val snap = c.snapshot()
        assertTrue("快照里出现了非数字的字段", snap.values.all { it is Long })
        // 键名里本来就有 provider_* 这类前缀,要查的是「值里有没有内容」
        val text = snap.values.joinToString(",")
        for (secret in listOf("我明天下午三点来", "audio", "pcm")) {
            assertFalse("快照的值里带了内容: $secret", text.contains(secret))
        }
        assertFalse("快照里出现了原文", snap.toString().contains("我明天下午三点来"))
    }

    @Test fun audioBytesAccumulateAcrossEvents() {
        val c = CallMediaCounters()
        repeat(3) { c.eventReceived(VolcRealtimeEvent.Audio(ByteArray(100))) }
        assertEquals(300L, c.snapshot()["assistant_audio_bytes"])
        assertEquals(3L, c.snapshot()["assistant_audio_events"])
        assertNotNull(c.recordReport())
    }
}
