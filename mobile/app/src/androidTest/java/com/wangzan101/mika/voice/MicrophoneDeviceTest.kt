package com.wangzan101.mika.voice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wangzan101.mika.MikaApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import kotlin.math.sqrt

/** 真机录音链路:只读麦克风电平和 PCM,不播放任何声音。 */
@RunWith(AndroidJUnit4::class)
class MicrophoneDeviceTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val context get() = inst.targetContext
    private var originalSpeechChoice: SpeechChoice? = null

    @Before fun grantMicAndShowApp() {
        inst.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
        inst.uiAutomation.grantRuntimePermission(inst.context.packageName, Manifest.permission.RECORD_AUDIO)
        assertEquals(
            "RECORD_AUDIO was not granted to ${context.packageName}",
            PackageManager.PERMISSION_GRANTED,
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO),
        )
        // 安卓 14 起后台录音受限,把 App 拉到前台再测,贴近用户在输入框按住说话。
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent().setClassName(context, "com.wangzan101.mika.ui.MainActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        context.startActivity(intent)
        inst.waitForIdleSync()
        Thread.sleep(800)
    }

    @After fun restoreSpeechChoice() {
        originalSpeechChoice?.let { SpeechSettings.get(context).set(it) }
    }

    @Test fun audioRecordStartsAndReadsSilentPcm() {
        val minBuf = AudioRecord.getMinBufferSize(Wav.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        assertTrue("minBufferSize=$minBuf", minBuf > 0)
        val rec = AudioRecord(
            MediaRecorder.AudioSource.MIC, Wav.RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 4,
        )
        try {
            assertEquals("AudioRecord.state=${rec.state}", AudioRecord.STATE_INITIALIZED, rec.state)
            rec.startRecording()
            assertEquals("AudioRecord.recordingState=${rec.recordingState}", AudioRecord.RECORDSTATE_RECORDING, rec.recordingState)
            val buf = ShortArray(Wav.RATE / 5)
            val n = rec.read(buf, 0, buf.size)
            println("MIC_TEST AudioRecord minBuf=$minBuf state=${rec.state} recordingState=${rec.recordingState} read=$n")
            Log.i("MicDeviceTest", "AudioRecord minBuf=$minBuf state=${rec.state} recordingState=${rec.recordingState} read=$n")
            assertTrue("AudioRecord.read returned $n", n > 0)
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }
    }

    @SuppressLint("MissingPermission") // 由 grantMicAndShowApp 授予并检查
    @Test fun pcmRecorderStartsAndReturnsSamples() {
        val rec = PcmRecorder(maxMs = 2_000)
        val started = rec.start()
        Thread.sleep(700)
        val level = rec.level.value
        val pcm = rec.stop()
        val rms = if (pcm.isEmpty()) 0.0 else sqrt(pcm.sumOf { val v = it.toDouble(); v * v } / pcm.size)
        println("MIC_TEST PcmRecorder started=$started samples=${pcm.size} level=$level rms=$rms")
        Log.i("MicDeviceTest", "PcmRecorder started=$started samples=${pcm.size} level=$level rms=$rms")
        assertTrue("PcmRecorder.start returned false", started)
        assertTrue("PcmRecorder returned ${pcm.size} samples", pcm.size >= Wav.RATE / 10)
    }

    @Test fun voiceInputStartsSystemSpeechWithoutPlayback() {
        val app = context.applicationContext as? MikaApp
        assertNotNull("applicationContext is ${context.applicationContext::class.java.name}, not MikaApp", app)
        val settings = app!!.speech
        originalSpeechChoice = settings.choice.value
        // 自动/自带识别都会清掉之前「系统识别不响应」的记号,免得旧状态影响这次。
        settings.set(SpeechChoice.Auto)
        val spec = app.voice.spec()
        println("MIC_TEST VoiceInput spec=$spec")
        Log.i("MicDeviceTest", "VoiceInput spec=$spec")
        if (spec is SpeechEngineSpec.Unavailable) fail("VoiceInput.spec is unavailable: ${spec.why}")

        val session = app.voice.start("zh-CN")
        val events = Collections.synchronizedList(mutableListOf<SpeechEvent>())
        val collector = CoroutineScope(Dispatchers.Default).launch {
            session.events.collect { events.add(it) }
        }
        try {
            // 只按 1.5 秒,不播放提示音;松开后等识别服务收尾。
            Thread.sleep(1_500)
            session.release()
            runBlocking {
                withTimeoutOrNull(6_000) {
                    while (collector.isActive && events.none { it is SpeechEvent.Failed || it is SpeechEvent.Final }) delay(50)
                }
            }
        } finally {
            session.cancel()
            collector.cancel()
        }
        val snapshot = events.toList()
        println("MIC_TEST SpeechSession events=${snapshot.joinToString { it.describe() }}")
        Log.i("MicDeviceTest", "SpeechSession events=${snapshot.joinToString { it.describe() }}")
        assertTrue("SpeechSession emitted no events", snapshot.isNotEmpty())
        snapshot.filterIsInstance<SpeechEvent.Failed>().firstOrNull()?.let {
            fail("SpeechSession failed: ${it.why}; events=${snapshot.joinToString { e -> e.describe() }}")
        }
        assertTrue(
            "SpeechSession had no microphone callback: ${snapshot.joinToString { it.describe() }}",
            snapshot.any { it is SpeechEvent.Level || it is SpeechEvent.Partial || it is SpeechEvent.Final },
        )
    }

    private fun SpeechEvent.describe(): String = when (this) {
        is SpeechEvent.Level -> "Level($value)"
        is SpeechEvent.Partial -> "Partial($stable,$tail)"
        SpeechEvent.Converting -> "Converting"
        is SpeechEvent.Final -> "Final($text)"
        is SpeechEvent.Failed -> "Failed($why)"
    }
}
