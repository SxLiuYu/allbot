package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 服务类型的推导与持久化语义。
 *
 * 重点是**老数据不能坏**：老版本只写了 `local_endpoint`，没有 `backend_kind`。升级后
 * 必须继续按自建服务处理，不能因为读不到新字段就把人判成「未配置」导致电话接不了。
 */
class CallBackendKindTest {

    private fun config(
        localEndpoint: String? = null,
        credentials: Boolean = false,
        kind: CallBackendKind? = null,
    ) = CallConfig(localEndpoint = localEndpoint, credentialsConfigured = credentials, backendKind = kind)

    @Test
    fun legacyLocalEndpointIsCommunityServer() {
        val legacy = config(localEndpoint = "ws://127.0.0.1:8000/api/v1/realtime/ws/mika")
        assertEquals(CallBackendKind.CUSTOM, legacy.effectiveBackendKind)
        assertTrue("老的自建配置升级后必须仍然可用", legacy.backendReady)
    }

    @Test
    fun legacyVolcCredentialsStayVolcengine() {
        val legacy = config(credentials = true)
        assertEquals(CallBackendKind.VOLCENGINE, legacy.effectiveBackendKind)
        assertTrue(legacy.backendReady)
    }

    @Test
    fun nothingConfiguredIsUnconfigured() {
        val empty = config()
        assertEquals(CallBackendKind.UNCONFIGURED, empty.effectiveBackendKind)
        assertFalse(empty.backendReady)
    }

    @Test
    fun explicitKindWinsOverInference() {
        // 云端和自建共用同一个地址字段，只有显式 kind 能区分。
        val cloud = config(localEndpoint = "wss://example.invalid/realtime/ws", kind = CallBackendKind.CLOUD)
        assertEquals(CallBackendKind.CLOUD, cloud.effectiveBackendKind)
        val custom = config(localEndpoint = "wss://example.invalid/realtime/ws", kind = CallBackendKind.CUSTOM)
        assertEquals(CallBackendKind.CUSTOM, custom.effectiveBackendKind)
    }

    @Test
    fun explicitKindWithoutItsConfigIsNotReady() {
        // 选了云端却没填地址：不能因为「选了类型」就算就绪。
        val selectedButEmpty = config(kind = CallBackendKind.CLOUD)
        assertFalse(selectedButEmpty.backendReady)
        // 选了火山但没凭据同理。
        assertFalse(config(kind = CallBackendKind.VOLCENGINE).backendReady)
    }

    @Test
    fun isConfiguredChecksTheMatchingField() {
        assertTrue(CallBackendKind.VOLCENGINE.isConfigured(config(credentials = true)))
        assertFalse(CallBackendKind.VOLCENGINE.isConfigured(config(localEndpoint = "ws://a.b")))
        assertTrue(CallBackendKind.CUSTOM.isConfigured(config(localEndpoint = "ws://a.b")))
        assertTrue(CallBackendKind.CLOUD.isConfigured(config(localEndpoint = "wss://a.b")))
        assertFalse(CallBackendKind.UNCONFIGURED.isConfigured(config(credentials = true, localEndpoint = "ws://a.b")))
    }

    @Test
    fun autoAnswerStillNeedsFullReadiness() {
        // 服务类型只回答「后端配没配」，自动接听仍要求所有开关到位。
        val local = config(localEndpoint = "ws://a.b")
        assertTrue(local.backendReady)
        assertFalse(
            "没开 AI 电话时不该自动接",
            CallPolicy.callerAllowed(
                local.copy(enabled = false, autoAnswer = true, audioVerified = true, allowAllIncoming = true),
                "13800138000", 1_700_000_000_000L,
            ),
        )
    }
}
