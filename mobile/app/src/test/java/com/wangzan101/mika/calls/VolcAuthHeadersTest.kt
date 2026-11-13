package com.wangzan101.mika.calls

import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 认证头怎么发。
 *
 * 这是「连不上」和「连上了」的分界:头发错,服务端一律 401,后面所有音频逻辑
 * 都轮不到跑。之前这块一次都没测过。
 *
 * 两条路径互斥,不能同时发:
 * - 新版:只发 X-Api-Key
 * - 旧版:App ID + Access Key + 资源号 + 固定协议号 + 请求号
 *
 * 混发不是「多带了几个头」这么简单:服务端按其中一套认人,另一套会让它判断
 * 用哪个身份,结果通常是被拒。
 */
class VolcAuthHeadersTest {

    private fun headersOf(credentials: VolcRealtimeCredentials): Map<String, String> {
        val builder = Request.Builder().url("https://example.invalid/")
        credentials.applyHeaders(builder)
        // 头名大小写不敏感,统一折成小写再取,免得测试因为实现改了大小写而假失败。
        return builder.build().headers.toMultimap()
            .entries.associate { it.key.lowercase() to it.value.single() }
    }

    @Test fun theModernKeySendsOnlyTheApiKeyHeader() {
        val h = headersOf(VolcRealtimeCredentials(apiKey = "sk-abc"))
        assertEquals("sk-abc", h["x-api-key"])
        assertNull("新版不该带旧版那套头", h["x-api-app-id"])
        assertNull(h["x-api-access-key"])
        assertNull(h["x-api-app-key"])
    }

    @Test fun theLegacyPairSendsTheWholeLegacySet() {
        val h = headersOf(VolcRealtimeCredentials(appId = "app-1", accessKey = "ak-1"))
        assertEquals("app-1", h["x-api-app-id"])
        assertEquals("ak-1", h["x-api-access-key"])
        assertEquals("volc.speech.dialog", h["x-api-resource-id"])
        assertEquals(VolcRealtimeProtocol.LEGACY_APP_KEY, h["x-api-app-key"])
        assertTrue("旧版要带请求号,便于对账排障", !h["x-api-request-id"].isNullOrBlank())
        assertNull("旧版不该带新版那个头", h["x-api-key"])
    }

    /** 每次请求的 id 都不同,否则服务端去重会误判成重放。 */
    @Test fun everyLegacyRequestGetsItsOwnId() {
        val creds = VolcRealtimeCredentials(appId = "a", accessKey = "k")
        val first = headersOf(creds)["x-api-request-id"]
        val second = headersOf(creds)["x-api-request-id"]
        assertTrue("请求号不能重复", first != second)
    }

    /** 这个固定值是协议标识,不是用户的密钥——写死了是刻意的。 */
    @Test fun theLegacyAppKeyIsAProtocolConstantNotACredential() {
        assertEquals("PlgvMymc7f3tQnJ6", VolcRealtimeProtocol.LEGACY_APP_KEY)
        val h = headersOf(VolcRealtimeCredentials(appId = "user-app", accessKey = "user-key"))
        assertEquals("不能被用户的 App ID 覆盖", "PlgvMymc7f3tQnJ6", h["x-api-app-key"])
    }

    /** 无效凭据要在发请求之前就抛,不能带着空头去撞服务端。 */
    @Test fun invalidCredentialsFailBeforeAnyRequestIsBuilt() {
        for (bad in listOf(
            VolcRealtimeCredentials(),
            VolcRealtimeCredentials(apiKey = "  "),
            VolcRealtimeCredentials(appId = "only-id"),
            VolcRealtimeCredentials(accessKey = "only-key"),
            VolcRealtimeCredentials(apiKey = "has space"),
            VolcRealtimeCredentials(apiKey = "has\nnewline"),
        )) {
            val builder = Request.Builder().url("https://example.invalid/")
            val e = assertThrows(VolcRealtimeException::class.java) { bad.applyHeaders(builder) }
            assertEquals("必须是认证类错误,不能混成网络错", VolcRealtimeException.Kind.AUTH, e.kind)
        }
    }

    /** 首尾空白要去掉:用户从控制台复制时经常带上来。 */
    @Test fun surroundingWhitespaceIsTrimmedBeforeSending() {
        val h = headersOf(VolcRealtimeCredentials(apiKey = "  sk-padded\t"))
        assertEquals("sk-padded", h["x-api-key"])
        val legacy = headersOf(VolcRealtimeCredentials(appId = " app ", accessKey = " key "))
        assertEquals("app", legacy["x-api-app-id"])
        assertEquals("key", legacy["x-api-access-key"])
    }

    /**
     * 凭据绝不能出现在日志或错误信息里。toString 被覆盖成固定串就是这个原因——
     * 一旦有人把 credentials 塞进日志,密钥就泄漏了。
     */
    @Test fun toStringNeverLeaksTheSecret() {
        val creds = VolcRealtimeCredentials(apiKey = "sk-super-secret-value")
        val text = creds.toString()
        assertTrue("toString 不能带密钥", !text.contains("sk-super-secret-value"))
        assertTrue(text.contains("redacted"))

        val legacy = VolcRealtimeCredentials(appId = "app-secret", accessKey = "ak-secret")
        assertTrue(!legacy.toString().contains("app-secret"))
        assertTrue(!legacy.toString().contains("ak-secret"))
    }

    /** 异常信息里也不能带凭据。 */
    @Test fun theAuthErrorCarriesNoCredentialMaterial() {
        val creds = VolcRealtimeCredentials(apiKey = "bad key with space")
        val builder = Request.Builder().url("https://example.invalid/")
        val e = assertThrows(VolcRealtimeException::class.java) { creds.applyHeaders(builder) }
        assertTrue("异常信息不能带密钥", !(e.message ?: "").contains("bad key with space"))
    }
}
