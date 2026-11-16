package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 初始化步骤的判定。
 *
 * 这一层只回答「还差哪几步」，不改变放行规则：真正的自动接听判定仍在
 * [CallPolicy.callerAllowed]，它自己会再检查 enabled / autoAnswer / backendReady /
 * audioVerified。所以即使这里的计算出错，也不会让一通陌生号码被自动接起。
 */
class CallSetupStepTest {

    private val readyConfig = CallConfig(
        enabled = true,
        autoAnswer = true,
        credentialsConfigured = true,
        audioVerified = true,
        allowAllIncoming = true,
    )

    private val readyState = CallRuntimeState(
        prepared = true,
        phonePermissionGranted = true,
        shellConnected = true,
        notificationsAvailable = true,
        audioReady = true,
    )

    @Test
    fun everythingReadyHasNoMissingSteps() {
        assertEquals(emptyList<CallSetupStep>(), CallSetupStep.missing(readyConfig, readyState))
        assertTrue(CallSetupStep.ready(readyConfig, readyState))
    }

    @Test
    fun missingStepsKeepDeclaredOrder() {
        val empty = CallConfig()
        assertEquals(CallSetupStep.entries, CallSetupStep.missing(empty, CallRuntimeState()))
        assertFalse(CallSetupStep.ready(empty, CallRuntimeState()))
    }

    @Test
    fun backendAloneIsEnoughForBackendStep() {
        // 自建服务：只要地址在，就算这一步完成，不要求火山凭据。
        val local = readyConfig.copy(
            credentialsConfigured = false,
            localEndpoint = "ws://127.0.0.1:8000/api/v1/realtime/ws/mika",
        )
        assertTrue(CallSetupStep.completed(local, readyState).contains(CallSetupStep.BACKEND))
    }

    @Test
    fun audioVerificationIsItsOwnStep() {
        val notVerified = readyConfig.copy(audioVerified = false)
        assertFalse(CallSetupStep.completed(notVerified, readyState).contains(CallSetupStep.AUDIO_VERIFIED))
        assertEquals(listOf(CallSetupStep.AUDIO_VERIFIED), CallSetupStep.missing(notVerified, readyState))
    }

    @Test
    fun permissionsStepNeedsBothGrantAndAudioPipeline() {
        // 权限给了但音频管道没就绪（probeAudio 未通过）仍算没完成：只给权限解决不了没声音。
        assertFalse(
            CallSetupStep.completed(readyConfig, readyState.copy(audioReady = false))
                .contains(CallSetupStep.DEVICE_PERMISSIONS),
        )
        assertFalse(
            CallSetupStep.completed(readyConfig, readyState.copy(phonePermissionGranted = false))
                .contains(CallSetupStep.DEVICE_PERMISSIONS),
        )
    }

    @Test
    fun notificationsStepAlsoRequiresPrepared() {
        // prepared 表示通话服务已就绪；只给通知权限不够。
        assertFalse(
            CallSetupStep.completed(readyConfig, readyState.copy(prepared = false))
                .contains(CallSetupStep.NOTIFICATIONS),
        )
    }

    @Test
    fun setupCompletionDoesNotGrantAutoAnswerByItself() {
        // 五步全绿但用户没打开自动接听：仍然不能自动接。
        val notEnabled = readyConfig.copy(autoAnswer = false)
        assertTrue(CallSetupStep.ready(notEnabled, readyState))
        assertFalse(
            CallPolicy.callerAllowed(notEnabled, "13800138000", 1_700_000_000_000L),
        )
    }
}
