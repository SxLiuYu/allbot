package com.wangzan101.mika.calls

import com.wangzan101.mika.core.calls.PhoneCallPort
import com.wangzan101.mika.core.calls.PhoneCallTask
import kotlinx.serialization.json.*

/** One native runtime for the local agent, UI and authenticated MCP endpoint. */
class AndroidPhoneCallPort(private val runtime: CallRuntime) : PhoneCallPort {
    override suspend fun state(): JsonObject {
        runtime.refresh()
        return snapshot()
    }

    private fun snapshot() = buildJsonObject {
        val config = runtime.settings.state.value
        val state = runtime.state.value
        put("enabled", config.enabled)
        put("prepared", state.prepared)
        put("audio_ready", state.audioReady)
        put("audio_verified", config.audioVerified)
        put("helper_connected", state.shellConnected)
        put("notifications_available", state.notificationsAvailable)
        state.audioDetail?.let { put("audio_detail", it) }
        put("credentials_configured", config.credentialsConfigured)
        put("phase", state.phase.name.lowercase())
        put("ai_active", state.aiActive)
        put("auto_answer", config.autoAnswer)
        put("auto_answer_pending", state.pendingAutoAnswer)
        put("max_call_seconds", config.maxCallSeconds)
        state.direction?.let { put("direction", it.name.lowercase()) }
        state.callId?.let { put("call_id", it) }
        state.number?.let { put("number", it) }
        state.detail?.let { put("detail", it) }
        putJsonArray("sims") {
            state.simOptions.forEach { sim -> add(buildJsonObject {
                put("id", sim.id); put("label", sim.label); put("default", sim.isDefault)
            }) }
        }
        // 空列表有两种原因,不说清楚会让人以为手机没插卡:没有电话权限时读不到
        // SIM,和真的没卡长得一模一样。
        if (state.simOptions.isEmpty()) {
            put("sims_detail", if (!state.phonePermissionGranted) {
                "未授予电话权限(READ_PHONE_STATE / CALL_PHONE),读不到 SIM 卡"
            } else {
                "已授予电话权限,但没读到可用的 SIM 卡(可能未插卡或运营商未注册)"
            })
        }
    }

    private fun result(result: CallActionResult) = buildJsonObject {
        put("ok", result.ok); put("message", result.message); put("call", snapshot())
    }
    override suspend fun dial(number: String, simId: String?, task: PhoneCallTask?) = result(runtime.dial(
        number, simId, task?.let { CallTaskBrief(it.goal, it.questions, it.context, it.constraints) },
    ))
    override suspend fun answer(callId: String) = result(runtime.answer(expectedCallId = callId))
    override suspend fun hangup(callId: String) = result(runtime.hangup(expectedCallId = callId))
    override suspend fun takeover() = result(runtime.takeover())
}
