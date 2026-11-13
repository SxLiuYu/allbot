package com.wangzan101.mika.core.model

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/**
 * 先问 [primary],它出错或超过 [timeoutMs] 就改问 [fallback],之后这个实例一直用 [fallback]。
 *
 * 给本地小模型用:服务停了、地址填错、机器不在线时,每个旁路任务都重连一次会反复干等。
 * 同一个实例第一次失败后,后续调用直接走主模型。
 * [capabilities] 始终按 [primary] 报:分工开关按声明的能力判断,内部换过模型不会把操作步骤误派给它;[name] 跟着实际在用的模型走。
 * 外层问它要逐段文字时,里面两个模型支持就照常转发,不支持的按整段文字回调一次;换过模型后也照样。
 */
class FallbackModel(
    private val primary: ChatModel,
    private val fallback: ChatModel,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
) : StreamingChatModel {
    @Volatile private var failed = false

    override val capabilities: Capabilities get() = primary.capabilities
    /** 记录用的名字跟着实际在用的那个走,好让运行记录能看出这次已经退回主模型。 */
    override val name: String get() = if (failed) fallback.name else primary.name

    override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply {
        if (failed || primary === fallback) return fallback.complete(system, messages, tools)
        return try {
            withTimeout(timeoutMs) { primary.complete(system, messages, tools) }
        } catch (e: CancellationException) {
            // 只是本地这次等超时,任务本身没取消:转成回退,别的取消照常往外抛
            if (e !is TimeoutCancellationException) throw e
            failed = true
            fallback.complete(system, messages, tools)
        } catch (e: Exception) {
            failed = true
            fallback.complete(system, messages, tools)
        }
    }

    override suspend fun completeStreaming(
        system: String, messages: List<Message>, tools: List<ToolSpec>, onText: (String) -> Unit,
    ): ModelReply {
        if (failed || primary === fallback) return streaming(fallback, system, messages, tools, onText)
        return try {
            withTimeout(timeoutMs) { streaming(primary, system, messages, tools, onText) }
        } catch (e: CancellationException) {
            if (e !is TimeoutCancellationException) throw e
            failed = true
            streaming(fallback, system, messages, tools, onText)
        } catch (e: Exception) {
            failed = true
            streaming(fallback, system, messages, tools, onText)
        }
    }

    private suspend fun streaming(
        model: ChatModel, system: String, messages: List<Message>, tools: List<ToolSpec>, onText: (String) -> Unit,
    ): ModelReply {
        if (model is StreamingChatModel) return model.completeStreaming(system, messages, tools, onText)
        return model.complete(system, messages, tools).also { r ->
            r.parts.filterIsInstance<Part.Text>().joinToString("") { it.text }.takeIf { it.isNotBlank() }?.let(onText)
        }
    }

    companion object {
        /** 本地小模型短回答通常在一两秒内;留够长一点的输入,又不让服务不可达时干等连接超时。 */
        const val DEFAULT_TIMEOUT_MS = 8_000L
    }
}
