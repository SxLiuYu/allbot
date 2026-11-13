package com.wangzan101.mika.calls

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * 火山实时语音的两种凭据形态和帧协议。
 *
 * 这两块决定「连不上」还是「连上了但没声音」:
 * - 凭据形态填错,握手就 401,根本不会有音频;
 * - 帧解析放宽一点点,坏帧会被当成音频送进播放,听起来是杂音或者干脆不出声。
 *
 * 真机上验 `audioVerified` 之前,这些必须先在纯逻辑层钉住。
 */
class VolcRealtimeProtocolTest {

    // ---- 凭据 ----

    @Test fun aLoneApiKeyIsAValidCredential() {
        val c = VolcRealtimeCredentials(apiKey = "sk-abc123")
        assertTrue(c.valid)
    }

    /** 旧版要 App ID + Access Key 一起,只给一个不算。 */
    @Test fun theLegacyPairNeedsBothHalves() {
        assertTrue(VolcRealtimeCredentials(appId = "app1", accessKey = "key1").valid)
        assertFalse("只有 App ID", VolcRealtimeCredentials(appId = "app1").valid)
        assertFalse("只有 Access Key", VolcRealtimeCredentials(accessKey = "key1").valid)
    }

    @Test fun anEmptyCredentialIsNotValid() {
        assertFalse(VolcRealtimeCredentials().valid)
        assertFalse(VolcRealtimeCredentials(apiKey = "   ").valid)
    }

    /**
     * 凭据要原样放进 HTTP 头,所以只能是可见 ASCII。
     * 换行和空格会让整个请求头坏掉,或者被截断成另一个值——这种必须提前拦住。
     */
    @Test fun headerUnsafeCharactersAreRejected() {
        for (bad in listOf("abc def", "abc\ndef", "abc\rdef", "abc\tdef", "键值", "abc\u0000")) {
            assertFalse("不该通过: [${bad.replace("\n", "\\n")}]", VolcRealtimeCredentials(apiKey = bad).valid)
        }
        // 可见 ASCII 的边界:! (33) 和 ~ (126) 都算
        assertTrue(VolcRealtimeCredentials(apiKey = "!").valid)
        assertTrue(VolcRealtimeCredentials(apiKey = "~").valid)
    }

    @Test fun anOverlongCredentialIsRejected() {
        assertTrue(VolcRealtimeCredentials(apiKey = "x".repeat(1024)).valid)
        assertFalse(VolcRealtimeCredentials(apiKey = "x".repeat(1025)).valid)
    }

    // ---- 发出去的帧 ----

    @Test fun theSessionCreateCarriesBothFormats() {
        val msg = VolcRealtimeProtocol.create("e1", VolcRealtimeConfig(systemPrompt = "规则", speaker = "zh_male_x"))
        val o = Json.parseToJsonElement(msg).jsonObject
        assertEquals("session.create", o["type"]!!.jsonPrimitive.content)
        assertEquals("e1", o["event_id"]!!.jsonPrimitive.content)
        val session = o["session"]!!.jsonObject
        val audio = session["audio"]!!.jsonObject
        // 输入 16k、输出 24k,格式写清 pcm / pcm_s16le:供应商按这个决定怎么解
        assertEquals(16_000, audio["input"]!!.jsonObject["format"]!!.jsonObject["rate"]!!.jsonPrimitive.content.toInt())
        assertEquals(24_000, audio["output"]!!.jsonObject["format"]!!.jsonObject["rate"]!!.jsonPrimitive.content.toInt())
        assertEquals("pcm_s16le", audio["output"]!!.jsonObject["format"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("zh_male_x", audio["output"]!!.jsonObject["voice"]!!.jsonPrimitive.content)
        assertEquals("规则", session["instructions"]!!.jsonPrimitive.content)
    }

    /** 没给系统提示词就不带 instructions 字段,别发一个空串过去。 */
    @Test fun aBlankPromptIsOmittedNotSentEmpty() {
        val o = Json.parseToJsonElement(VolcRealtimeProtocol.create("e", VolcRealtimeConfig())).jsonObject
        assertFalse("不该带空的 instructions", "instructions" in o["session"]!!.jsonObject)
    }

    /**
     * 音频帧:字节数少于 [count] 时只发前 count 个。
     * 多发了会把上一帧的尾巴重复送过去,听起来是回声或者咔哒声。
     */
    @Test fun onlyTheDeclaredNumberOfBytesIsSent() {
        val bytes = ByteArray(640) { it.toByte() }
        val o = Json.parseToJsonElement(VolcRealtimeProtocol.audio("a", bytes, 320)).jsonObject
        val decoded = Base64.getDecoder().decode(o["audio"]!!.jsonPrimitive.content)
        assertEquals(320, decoded.size)
        assertArrayEquals(bytes.copyOf(320), decoded)
    }

    @Test fun greetingAndMuteAndCloseHaveTheRightTypes() {
        fun type(m: String) = Json.parseToJsonElement(m).jsonObject["type"]!!.jsonPrimitive.content
        assertEquals("speech_text_buffer.commit", type(VolcRealtimeProtocol.greeting("g", "你好")))
        assertEquals("input_audio_mute.commit", type(VolcRealtimeProtocol.mute("m", muted = true)))
        assertEquals("input_audio_unmute.commit", type(VolcRealtimeProtocol.mute("m", muted = false)))
        assertEquals("session.close", type(VolcRealtimeProtocol.close("c")))
    }

    // ---- 收进来的帧 ----

    @Test fun aFrameWithoutTypeIsIgnored() {
        assertNull(VolcRealtimeProtocol.parse("""{"delta":"abc"}"""))
        assertNull(VolcRealtimeProtocol.parse("""{"type":""}"""))
    }

    @Test fun garbageAndOversizeFramesAreDropped() {
        assertNull(VolcRealtimeProtocol.parse("not json"))
        assertNull(VolcRealtimeProtocol.parse("[1,2,3]"))
        // 超过 MAX_FRAME_CHARS 直接不解析,不让一个坏帧吃掉内存
        val huge = """{"type":"x","pad":"${"a".repeat(VolcRealtimeProtocol.MAX_FRAME_CHARS)}"}"""
        assertNull(VolcRealtimeProtocol.parse(huge))
    }

    @Test fun aWellFormedFrameIsParsed() {
        val f = VolcRealtimeProtocol.parse("""{"type":"response.output_audio.delta","delta":"AAAA"}""")
        assertNotNull(f)
        assertEquals("response.output_audio.delta", f!!["type"]!!.jsonPrimitive.content)
    }

    /**
     * 音频解码要卡三件事:能解 base64、长度不超一秒、字节数是偶数。
     * 奇数长度不是合法的 16 bit PCM,送进去就是半个采样点的错位。
     */
    @Test fun pcmDecodingEnforcesLengthAndAlignment() {
        val ok = Base64.getEncoder().encodeToString(ByteArray(640))
        assertArrayEquals(ByteArray(640), VolcRealtimeProtocol.pcm(frame("""{"delta":"$ok"}""")))
        // 奇数长度:不是合法 s16le
        val odd = Base64.getEncoder().encodeToString(ByteArray(641))
        assertNull("奇数长度不该收", VolcRealtimeProtocol.pcm(frame("""{"delta":"$odd"}""")))
        // 超过一秒(24000×2 字节)
        val tooLong = Base64.getEncoder().encodeToString(ByteArray(24_000 * 2 + 2))
        assertNull("超过一秒的包不该收", VolcRealtimeProtocol.pcm(frame("""{"delta":"$tooLong"}""")))
        // 坏 base64
        assertNull(VolcRealtimeProtocol.pcm(frame("""{"delta":"!!!not-base64!!!"}""")))
        // 没有 delta
        assertNull(VolcRealtimeProtocol.pcm(frame("""{"type":"x"}""")))
    }

    @Test fun theErrorCodeComesFromWhicheverFieldTheProviderUsed() {
        assertEquals(45000001L, VolcRealtimeProtocol.errorCode(frame("""{"error":{"code":45000001}}""")))
        assertEquals(403L, VolcRealtimeProtocol.errorCode(frame("""{"error":{"status_code":403}}""")))
        assertEquals(7L, VolcRealtimeProtocol.errorCode(frame("""{"code":7}""")))
        assertNull(VolcRealtimeProtocol.errorCode(frame("""{"type":"x"}""")))
    }

    /** 提示词长度有上限,超了在构造时就该炸,不能等到开工。 */
    @Test fun anOverlongPromptFailsFast() {
        VolcRealtimeConfig(systemPrompt = "x".repeat(16_384))
        var threw = false
        try { VolcRealtimeConfig(systemPrompt = "x".repeat(16_385)) } catch (_: IllegalArgumentException) { threw = true }
        assertTrue("超长提示词没有当场拒绝", threw)
    }

    @Test fun theSpeakerMustBeUsable() {
        for (bad in listOf("", "   ")) {
            var threw = false
            try { VolcRealtimeConfig(speaker = bad) } catch (_: IllegalArgumentException) { threw = true }
            assertTrue("不该接受: [$bad]", threw)
        }
    }

    private fun frame(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject
}
