package com.wangzan101.mika.calls

import android.content.SharedPreferences
import com.wangzan101.mika.settings.KeyCipher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 电话设置怎么落盘、怎么读回来。
 *
 * 这层原来一条测试都没有,因为它直接调 Build.FINGERPRINT 和 android.util.Base64,
 * 纯 JVM 下会抛 Stub。把指纹做成构造参数、Base64 换成 java.util.Base64 之后,
 * 保存、校验、清除、作废这几条规则都能在这里钉住。
 *
 * 最要紧的是失败路径:设置写不进去时,自动接听必须跟着关掉。否则用户以为
 * 关掉了,实际还在自动接——那是安全边界,不是体验问题。
 */
class CallSettingsTest {

    /** 内存版 SharedPreferences。写失败可注入,用来验「写不进去时怎么收场」。 */
    private class MemoryPrefs(var failCommit: Boolean = false) : SharedPreferences {
        val values = HashMap<String, Any?>()
        override fun getAll(): Map<String, *> = values.toMap()
        override fun getString(key: String, defValue: String?) = values[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: Set<String>?): Set<String>? =
            (values[key] as? Set<*>)?.filterIsInstance<String>()?.toSet() ?: defValues
        override fun getInt(key: String, defValue: Int) = values[key] as? Int ?: defValue
        override fun getLong(key: String, defValue: Long) = values[key] as? Long ?: defValue
        override fun getFloat(key: String, defValue: Float) = values[key] as? Float ?: defValue
        override fun getBoolean(key: String, defValue: Boolean) = values[key] as? Boolean ?: defValue
        override fun contains(key: String) = key in values
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val pending = HashMap<String, Any?>()
            private val removed = HashSet<String>()
            override fun putString(key: String, value: String?) = apply { pending[key] = value }
            override fun putStringSet(key: String, values: Set<String>?) = apply { pending[key] = values }
            override fun putInt(key: String, value: Int) = apply { pending[key] = value }
            override fun putLong(key: String, value: Long) = apply { pending[key] = value }
            override fun putFloat(key: String, value: Float) = apply { pending[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { pending[key] = value }
            override fun remove(key: String) = apply { removed += key }
            override fun clear() = apply { values.clear() }
            override fun commit(): Boolean {
                if (failCommit) return false
                removed.forEach { values.remove(it) }
                values.putAll(pending)
                return true
            }
            override fun apply() { commit() }
        }
    }

    /** 假加密:翻转每个字节。够验证「存的是密文、读回来还原」。 */
    private class FlipCipher : KeyCipher {
        override fun encrypt(plain: ByteArray) = ByteArray(plain.size) { (plain[it] + 1).toByte() }
        override fun decrypt(data: ByteArray) = ByteArray(data.size) { (data[it] - 1).toByte() }
    }

    private val build = "google/sdk_gphone64/35"

    private fun settings(prefs: MemoryPrefs = MemoryPrefs(), cipher: KeyCipher = FlipCipher()) =
        CallSettings(prefs, cipher, build)

    // ---- 保存与读回 ----

    @Test fun savingWritesEveryFieldAndReadsBack() {
        val prefs = MemoryPrefs()
        val s = settings(prefs)
        val saved = s.save(CallConfig(
            enabled = true, audioVerified = true, maxCallSeconds = 300,
            greeting = "  您好  ", systemPrompt = "  说明  ", speaker = "zh_male_x",
        ))
        assertEquals("首尾空白要去掉", "您好", saved.greeting)

        // 新的实例从同一份 prefs 读,应该完全一致
        val again = settings(prefs).state.value
        assertTrue(again.enabled)
        assertTrue("同一个系统版本,验证结论有效", again.audioVerified)
        assertEquals(300, again.maxCallSeconds)
        assertEquals("您好", again.greeting)
        assertEquals("说明", again.systemPrompt)
        assertEquals("zh_male_x", again.speaker)
    }

    @Test fun aDifferentBuildInvalidatesTheAudioVerification() {
        // 换了系统版本,上次「听过出声」的结论不能顺延。
        val prefs = MemoryPrefs()
        settings(prefs).save(CallConfig(enabled = true, audioVerified = true))
        val otherBuild = CallSettings(prefs, FlipCipher(), "other/build/99").state.value
        assertFalse("换了系统版本还打着勾", otherBuild.audioVerified)
    }

    // ---- 写失败 ----

    @Test fun aFailedWriteTurnsAutoAnswerOff() {
        // 写不进去时必须把自动接听关掉。
        // 否则用户以为改了策略,实际旧策略还在跑——自动接陌生号码。
        val prefs = MemoryPrefs()
        val s = settings(prefs)
        s.save(CallConfig(enabled = true, autoAnswer = true, audioVerified = true))
        assertTrue("先确认自动接听是开的", s.state.value.autoAnswer)

        prefs.failCommit = true
        val threw = runCatching { s.save(CallConfig(enabled = true, autoAnswer = true, audioVerified = true)) }
        assertTrue("写失败要抛出来", threw.isFailure)
        // 关键是事后状态:内存里的 autoAnswer 必须已经关掉,不能留着旧值继续自动接。
        assertFalse("写失败后自动接听必须关掉", s.state.value.autoAnswer)
        assertFalse("后台常驻授权也要一并关掉", s.state.value.backgroundStandbyAuthorized)
    }

    // ---- 号码名单 ----

    @Test fun duplicateNumbersCollapseAndInvalidOnesAreRejected() {
        val prefs = MemoryPrefs()
        val s = settings(prefs)
        val saved = s.save(CallConfig(
            enabled = true, audioVerified = true,
            allowedIncomingNumbers = setOf("+86 13800138000", "13800138000", "+8613800138000"),
        ))
        assertEquals("同一个号码的三种写法要合成一条", 1, saved.allowedIncomingNumbers.size)

        for (bad in listOf("", "abc", "12")) {
            val threw = runCatching { s.save(CallConfig(allowedIncomingNumbers = setOf(bad))) }
            assertTrue("无效号码 [$bad] 没拦住", threw.isFailure)
        }
    }

    @Test fun theAllowlistIsCappedAtOneHundred() {
        val s = settings()
        val tooMany = (1..101).map { "1380013%04d".format(it) }.toSet()
        val threw = runCatching { s.save(CallConfig(allowedIncomingNumbers = tooMany)) }
        assertTrue("101 个号码应该被拒", threw.isFailure)
    }

    // ---- 时长与延迟的边界 ----

    @Test fun durationAndDelayAreClamped() {
        val s = settings()
        val low = s.save(CallConfig(enabled = true, audioVerified = true, maxCallSeconds = 1, autoAnswerDelaySeconds = 0))
        assertEquals("最小时长 15 秒", 15, low.maxCallSeconds)
        assertEquals("最小延迟 3 秒", 3, low.autoAnswerDelaySeconds)

        val high = s.save(CallConfig(enabled = true, audioVerified = true, maxCallSeconds = 99_999, autoAnswerDelaySeconds = 99))
        assertEquals(CallPolicy.MAX_SECONDS, high.maxCallSeconds)
        assertEquals(CallConfig.MAX_AUTO_ANSWER_DELAY_SECONDS, high.autoAnswerDelaySeconds)
    }

    @Test fun anInvalidSpeakerIsRejected() {
        val s = settings()
        for (bad in listOf("有中文", "has space", "a".repeat(101))) {
            val threw = runCatching { s.save(CallConfig(enabled = true, audioVerified = true, speaker = bad)) }
            assertTrue("无效音色 [${bad.take(10)}] 没拦住", threw.isFailure)
        }
        // 全空时回落到默认音色,不是报错
        val blank = s.save(CallConfig(enabled = true, audioVerified = true, speaker = "   "))
        assertTrue("空音色应该用默认值", blank.speaker.isNotBlank())
    }

    // ---- 音频模式切换让验证作废 ----

    @Test fun switchingAudioModeDropsTheVerification() {
        val prefs = MemoryPrefs()
        val s = settings(prefs)
        s.save(CallConfig(enabled = true, audioVerified = true, audioMode = CallAudioMode.DIRECT))
        val switched = s.save(s.state.value.copy(audioMode = CallAudioMode.REDIRECT, audioVerified = true))
        assertFalse("切了音频路径,上次的「能听见」不算了", switched.audioVerified)
        assertFalse("而且自动接听要跟着关", switched.autoAnswer)
    }

    // ---- 凭据 ----

    @Test fun credentialsAreStoredEncryptedAndNeverInPlainText() {
        val prefs = MemoryPrefs()
        val s = settings(prefs)
        s.saveCredentials("", "", "sk-secret-value")

        val stored = prefs.values["volc_credentials_v1"] as? String
        assertNotNull("凭据应该存进去了", stored)
        assertFalse("不能明文存", stored!!.contains("sk-secret-value"))
        assertTrue("状态要反映已配置", s.state.value.credentialsConfigured)

        val read = s.credentials()
        assertNotNull("应该能读回来", read)
        assertTrue("读回来的凭据要有效", read!!.valid)
    }

    @Test fun bothCredentialShapesAreSupported() {
        val modern = settings().apply { saveCredentials("", "", "api-key-1") }
        assertTrue("只填 API Key 应该可以", modern.state.value.credentialsConfigured)

        val legacy = settings().apply { saveCredentials("app-id-1", "access-key-1", "") }
        assertTrue("旧版两半都填应该可以", legacy.state.value.credentialsConfigured)

        val half = settings()
        val threw = runCatching { half.saveCredentials("app-id-1", "", "") }
        assertTrue("只填半个旧版要被拒", threw.isFailure)
        assertFalse("被拒之后不能算已配置", half.state.value.credentialsConfigured)
    }

    @Test fun clearingCredentialsTurnsAutoAnswerOff() {
        // 清除凭据必须同时关自动接听——没凭据接起来就是哑的。
        val prefs = MemoryPrefs()
        val s = settings(prefs)
        s.save(CallConfig(enabled = true, autoAnswer = true, audioVerified = true))
        s.saveCredentials("", "", "sk-1")
        assertTrue(s.state.value.credentialsConfigured)

        s.saveCredentials("", "", "")
        assertFalse("清除后不该还算已配置", s.state.value.credentialsConfigured)
        assertFalse("自动接听要跟着关", s.state.value.autoAnswer)
        assertNull("存的那条应该删干净", prefs.values["volc_credentials_v1"])
        assertNull("也不该还能读出来", s.credentials())

        // 关键:落盘的那两个开关也要归零,否则重启后 read() 会把它们读回来。
        // 只改内存状态不够——用户下次开 App 又会自动接。
        assertEquals("prefs 里的 auto_answer 必须归零", false, prefs.values["auto_answer"])
        assertEquals("prefs 里的后台常驻授权必须归零", false, prefs.values["background_standby_authorized"])

        // 用同一份 prefs 重建实例,模拟重启
        val afterRestart = settings(prefs).state.value
        assertFalse("重启后不该自动接听", afterRestart.autoAnswer)
        assertFalse("重启后不该算已配置", afterRestart.credentialsConfigured)
    }

    @Test fun aCorruptStoredCredentialReadsAsAbsentInsteadOfThrowing() {
        // 存的内容坏了(密钥轮换、数据被改)时不能崩,只能当成没配。
        val prefs = MemoryPrefs()
        prefs.values["volc_credentials_v1"] = "not-valid-base64!!!"
        val s = settings(prefs)
        assertFalse("坏数据不该让 App 崩", s.state.value.credentialsConfigured)
        assertNull(s.credentials())
    }

    @Test fun theCipherFailingToEncryptIsReportedNotSwallowed() {
        val failing = object : KeyCipher {
            override fun encrypt(plain: ByteArray): ByteArray = throw IllegalStateException("no key")
            override fun decrypt(data: ByteArray): ByteArray = data
        }
        val s = CallSettings(MemoryPrefs(), failing, build)
        val threw = runCatching { s.saveCredentials("", "", "sk-1") }
        assertTrue("加密失败要抛出来,不能静默当成存好了", threw.isFailure)
        assertFalse("而且状态不能变已配置", s.state.value.credentialsConfigured)
    }

    // ---- 后台常驻授权 ----

    @Test fun backgroundStandbyNeedsEveryGate() {
        val s = settings()
        assertFalse("什么都没配时不许授权", s.authorizeBackgroundStandby())
        s.saveCredentials("", "", "sk-1")
        s.save(CallConfig(enabled = true, autoAnswer = true, audioVerified = true))
        assertTrue("全部条件齐了才允许", s.authorizeBackgroundStandby())
    }

    @Test fun backgroundStandbyIsRefusedWithoutCredentials() {
        val s = settings()
        s.save(CallConfig(enabled = true, autoAnswer = true, audioVerified = true))
        assertFalse("没有火山凭据就不许常驻", s.authorizeBackgroundStandby())
    }
}
