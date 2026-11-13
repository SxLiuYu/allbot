package com.wangzan101.mika.core.model

import com.wangzan101.mika.core.testing.answerReply
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FallbackModelTest {
    private class CountingModel(
        private val reply: ModelReply? = null,
        private val error: Throwable? = null,
        private val hang: Boolean = false,
        override val name: String = "counting",
        private val streaming: Boolean = false,
    ) : StreamingChatModel {
        override val capabilities = Capabilities(toolCalls = false, vision = false, contextTokens = 8_192, reasoning = false)
        var calls = 0
            private set
        val offeredTools = mutableListOf<List<String>>()

        override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply {
            calls++
            offeredTools += tools.map { it.name }
            if (hang) awaitCancellation()
            if (error != null) throw error
            return reply!!
        }

        override suspend fun completeStreaming(
            system: String, messages: List<Message>, tools: List<ToolSpec>, onText: (String) -> Unit,
        ): ModelReply {
            val r = complete(system, messages, tools)
            if (!streaming) return r
            val text = (r.parts.single() as Part.Text).text
            onText(text.take(2))
            onText(text)
            return r
        }
    }

    private suspend fun ask(m: ChatModel, tools: List<ToolSpec> = emptyList()) = m.complete("s", emptyList(), tools)

    private fun text(reply: ModelReply) = (reply.parts.single() as Part.Text).text

    @Test fun primaryFailsThenEveryLaterCallGoesToFallback() = runTest {
        val broken = CountingModel(error = IllegalStateException("down"), name = "local")
        val main = CountingModel(reply = answerReply("main"), name = "main")
        val m = FallbackModel(broken, main)
        assertEquals("local", m.name)
        assertEquals("main", text(ask(m)))
        assertEquals("main", text(ask(m)))
        assertEquals("本地只试一次", 1, broken.calls)
        assertEquals(2, main.calls)
        assertEquals("main", m.name)
    }

    @Test fun outerCancellationIsNotSwallowed() = runTest {
        val main = CountingModel(reply = answerReply("main"))
        val hanging = object : ChatModel {
            override val capabilities = Capabilities(toolCalls = false, vision = false, contextTokens = 8_192, reasoning = false)
            override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply = awaitCancellation()
        }
        val job = launch { FallbackModel(hanging, main).complete("s", emptyList(), emptyList()) }
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        assertEquals("取消不触发主模型", 0, main.calls)
    }

    /** 已经退回主模型之后,外部取消照样往外抛,不能当成一次本地失败再回退。 */
    @Test fun fallbackCancellationIsNotSwallowed() = runTest {
        val broken = CountingModel(error = IllegalStateException("down"), name = "local")
        var calls = 0
        val main = object : StreamingChatModel {
            override val name = "main"
            override val capabilities = Capabilities(toolCalls = false, vision = false, contextTokens = 8_192, reasoning = false)
            override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply {
                calls++
                if (calls == 1) return answerReply("main")
                awaitCancellation()
            }
            override suspend fun completeStreaming(
                system: String, messages: List<Message>, tools: List<ToolSpec>, onText: (String) -> Unit,
            ): ModelReply = complete(system, messages, tools)
        }
        val m = FallbackModel(broken, main)
        assertEquals("main", text(ask(m)))
        val job = launch { m.completeStreaming("s", emptyList(), emptyList()) {} }
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        assertEquals("本地只试一次", 1, broken.calls)
        assertTrue("取消后没换别的模型重试", calls <= 2)
    }

    @Test fun localTimeoutSwitchesToMainModel() = runTest {
        val hang = CountingModel(hang = true, name = "local")
        val main = CountingModel(reply = answerReply("main"), name = "main")
        val m = FallbackModel(hang, main, timeoutMs = 1_000)
        assertEquals("main", text(ask(m)))
        assertEquals(1, hang.calls)
        assertEquals(1, main.calls)
        assertEquals("main", m.name)
    }

    @Test fun streamingTextIsForwardedAndFallsBackOnce() = runTest {
        val local = CountingModel(reply = answerReply("local"), name = "local", streaming = true)
        val main = CountingModel(reply = answerReply("main"), name = "main", streaming = true)
        val m = FallbackModel(local, main)
        val seen = mutableListOf<String>()
        assertEquals("local", text(m.completeStreaming("s", emptyList(), emptyList(), seen::add)))
        assertEquals(listOf("lo", "local"), seen)
        assertEquals(1, local.calls)
        assertEquals(0, main.calls)

        val broken = CountingModel(error = IllegalStateException("down"), name = "broken")
        val seen2 = mutableListOf<String>()
        val wrapped = FallbackModel(broken, main)
        assertEquals("main", text(wrapped.completeStreaming("s", emptyList(), emptyList(), seen2::add)))
        assertEquals(listOf("ma", "main"), seen2)
        assertEquals("本地只试一次", 1, broken.calls)
        assertEquals(1, main.calls)
        assertEquals("main", wrapped.name)
    }

    @Test fun capabilitiesAndToolsStayAsDeclared() = runTest {
        val broken = CountingModel(error = IllegalStateException("down"), name = "local")
        val main = CountingModel(reply = answerReply("main"), name = "main")
        val m = FallbackModel(broken, main)
        assertFalse("纯文本轻量模型不会被 ModelRouter 派去跑操作步骤", m.capabilities.toolCalls)
        val tool = ToolSpec("x", "test", "{}")
        ask(m, listOf(tool))
        assertEquals(listOf(listOf("x")), broken.offeredTools)
        assertEquals(listOf(listOf("x")), main.offeredTools)
    }
}
