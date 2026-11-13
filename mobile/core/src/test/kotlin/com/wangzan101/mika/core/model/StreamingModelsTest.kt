package com.wangzan101.mika.core.model

import com.wangzan101.mika.core.agent.RetryPolicy
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class StreamingModelsTest {
    private lateinit var server: MockWebServer
    private val caps = Capabilities(true, false, 32000, false)
    private val user = listOf(Message(Role.User, listOf(Part.Text("hi")), Author.User))

    @Before fun setUp() { server = MockWebServer().also { it.start() } }
    @After fun tearDown() { server.shutdown() }

    private fun event(data: String) = "data: $data\n\n"
    private fun stream(vararg data: String) = MockResponse().setHeader("Content-Type", "text/event-stream")
        .setBody(data.joinToString("") { event(it) })

    @Test fun openAiStreamsTextAndAssemblesSplitToolCall() = runTest {
        server.enqueue(stream(
            """{"choices":[{"delta":{"reasoning_content":"private","content":"先"}}]}""",
            """{"choices":[{"delta":{"content":"看","tool_calls":[{"index":0,"id":"c1","function":{"name":"phone_","arguments":"{\"re"}}]}}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"tap","arguments":"f\":\"a1\"}"}}]},"finish_reason":"tool_calls"}]}""",
            """{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}""",
            "[DONE]",
        ))
        val updates = mutableListOf<String>()
        val model = OpenAiCompatModel(server.url("/v1").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val reply = model.completeStreaming("s", user, emptyList(), updates::add)
        assertEquals(listOf("先", "先看"), updates)
        val thinking = Part.Thinking("private", ReasoningVia.ReasoningContent.tag(server.url("/v1/chat/completions").toString()))
        assertEquals(listOf(thinking, Part.Text("先看"), Part.ToolCall("c1", "phone_tap", """{"ref":"a1"}""")), reply.parts)
        assertEquals(StopReason.ToolUse, reply.stopReason)
        assertEquals(Usage(10, 3), reply.usage)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"stream\":true"))
    }

    /**
     * 有的兼容端点(方舟上的 qwen3 一类)流式分片里的 tool_calls 不带 index,整条调用和参数一次给全。
     * 这种也要收进来,不能因为缺 index 就丢掉,否则模型看起来什么都没做。
     */
    @Test fun openAiStreamAcceptsToolCallWithoutIndex() = runTest {
        server.enqueue(stream(
            """{"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"phone_open_app","arguments":"{\"package\":\"com.android.settings\"}"}}]},"finish_reason":null}]}""",
            """{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}""",
            "[DONE]",
        ))
        val model = OpenAiCompatModel(server.url("/v1").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val reply = model.completeStreaming("s", user, emptyList()) {}
        assertEquals(listOf(Part.ToolCall("call_1", "phone_open_app", """{"package":"com.android.settings"}""")), reply.parts)
        assertEquals(StopReason.ToolUse, reply.stopReason)
    }

    /** 不带 index 的后续分片(只有 arguments)续上同一条调用。 */
    @Test fun openAiStreamContinuesIndexlessToolCallFragments() = runTest {
        server.enqueue(stream(
            """{"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"phone_tap","arguments":"{\"re"}}]}}]}""",
            """{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"f\":\"a1\"}"}}]},"finish_reason":"tool_calls"}]}""",
            "[DONE]",
        ))
        val model = OpenAiCompatModel(server.url("/v1").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val reply = model.completeStreaming("s", user, emptyList()) {}
        assertEquals(listOf(Part.ToolCall("call_1", "phone_tap", """{"ref":"a1"}""")), reply.parts)
    }

    /** 流式里思考在 `reasoning` 字段、或 `content` 是分块数组的,都认出来,记下收到的位置。 */
    @Test fun openAiStreamReadsReasoningFieldAndChunkedContent() = runTest {
        val model = OpenAiCompatModel(server.url("/v1").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val endpoint = server.url("/v1/chat/completions").toString()
        server.enqueue(stream(
            """{"choices":[{"delta":{"reasoning":"想"}}]}""",
            """{"choices":[{"delta":{"reasoning":"好了","content":"答"}}]}""",
            """{"choices":[{"delta":{},"finish_reason":"stop"}]}""",
            "[DONE]",
        ))
        val reply = model.completeStreaming("s", user, emptyList()) {}
        assertEquals(listOf(Part.Thinking("想好了", ReasoningVia.Reasoning.tag(endpoint)), Part.Text("答")), reply.parts)

        server.enqueue(stream(
            """{"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"先"}]}]}}]}""",
            """{"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"想"}]}]}}]}""",
            """{"choices":[{"delta":{"content":"答案"}}]}""",
            """{"choices":[{"delta":{},"finish_reason":"stop"}]}""",
            "[DONE]",
        ))
        val updates = mutableListOf<String>()
        val chunked = model.completeStreaming("s", user, emptyList(), updates::add)
        assertEquals(listOf(Part.Thinking("先想", ReasoningVia.ThinkingChunks.tag(endpoint)), Part.Text("答案")), chunked.parts)
        assertEquals(listOf("答案"), updates)
    }

    @Test fun anthropicStreamsTextAndToolInput() = runTest {
        server.enqueue(stream(
            """{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}""",
            """{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}""",
            """{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"phone_tap","input":{}}}""",
            """{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"ref\":\"a1\"}"}}""",
            """{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}""",
            """{"type":"message_stop"}""",
        ))
        val updates = mutableListOf<String>()
        val model = AnthropicModel(server.url("/").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val reply = model.completeStreaming("s", user, emptyList(), updates::add)
        assertEquals(listOf("好"), updates)
        assertEquals(listOf(Part.Text("好"), Part.ToolCall("t1", "phone_tap", """{"ref":"a1"}""")), reply.parts)
        assertEquals(Usage(10, 5), reply.usage)
    }

    @Test fun geminiStreamsTextAndKeepsExplicitCallId() = runTest {
        server.enqueue(stream(
            """{"candidates":[{"content":{"parts":[{"text":"你"}]}}]}""",
            """{"candidates":[{"content":{"parts":[{"text":"好"},{"functionCall":{"id":"call9","name":"phone_tap","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}""",
        ))
        val updates = mutableListOf<String>()
        val model = GeminiModel(server.url("/").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val reply = model.completeStreaming("s", user, emptyList(), updates::add)
        assertEquals(listOf("你", "你好"), updates)
        assertEquals(listOf(Part.Text("你好"), Part.ToolCall("call9", "phone_tap", "{}")), reply.parts)
        assertEquals(StopReason.ToolUse, reply.stopReason)
        assertEquals("/v1beta/models/m:streamGenerateContent?alt=sse", server.takeRequest().path)
    }

    private fun openAi() = OpenAiCompatModel(server.url("/v1").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
    private fun anthropic() = AnthropicModel(server.url("/").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
    private fun gemini() = GeminiModel(server.url("/").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())

    /** 没收尾就断开的流不能当成回答,而是可重试的一时故障(和接口配置无关)。 */
    private suspend fun assertCut(model: StreamingChatModel) {
        try {
            model.completeStreaming("s", user, emptyList()) {}
            throw AssertionError("应拒绝不完整响应")
        } catch (e: ModelError.StreamCut) {
            assertTrue(RetryPolicy.transient(e))
        }
    }

    @Test fun openAiStreamCutAfterOneChunkIsRetryable() = runTest {
        server.enqueue(stream("""{"choices":[{"delta":{"content":"半句"}}]}"""))
        assertCut(openAi())
    }

    @Test fun anthropicStreamCutAfterOneChunkIsRetryable() = runTest {
        server.enqueue(stream(
            """{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}""",
            """{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半句"}}""",
        ))
        assertCut(anthropic())
    }

    @Test fun geminiStreamCutAfterOneChunkIsRetryable() = runTest {
        server.enqueue(stream("""{"candidates":[{"content":{"parts":[{"text":"半句"}]}}]}"""))
        assertCut(gemini())
    }

    /** 事件流一帧都没来就断了(比如长时间思考时被网关掐断),同样是可重试的断流。 */
    @Test fun eventStreamCutBeforeAnyEventIsRetryable() = runTest {
        server.enqueue(stream())
        assertCut(openAi())
    }

    /** 成功响应却既不是事件流、也没有任何事件(地址指到了网页):是配置问题,不重试。 */
    @Test fun nonStreamBodyWithoutEventsIsBadResponse() = runTest {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("<html>hi</html>"))
        try {
            openAi().completeStreaming("s", user, emptyList()) {}
            throw AssertionError("应拒绝非流式内容")
        } catch (e: ModelError.BadResponse) {
            assertTrue(!RetryPolicy.transient(e))
        }
    }

    /** 收到结束原因就算完整:有的端点不发最后的结束标记。 */
    @Test fun openAiFinishReasonWithoutDoneIsComplete() = runTest {
        server.enqueue(stream("""{"choices":[{"delta":{"content":"好了"},"finish_reason":"stop"}]}"""))
        val reply = openAi().completeStreaming("s", user, emptyList()) {}
        assertEquals(listOf(Part.Text("好了")), reply.parts)
        assertEquals(StopReason.EndTurn, reply.stopReason)
    }

    @Test fun anthropicStopReasonWithoutMessageStopIsComplete() = runTest {
        server.enqueue(stream(
            """{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}""",
            """{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}""",
            """{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好了"}}""",
            """{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}""",
        ))
        val reply = anthropic().completeStreaming("s", user, emptyList()) {}
        assertEquals(listOf(Part.Text("好了")), reply.parts)
        assertEquals(StopReason.EndTurn, reply.stopReason)
    }

    @Test fun geminiFinishReasonIsComplete() = runTest {
        server.enqueue(stream("""{"candidates":[{"content":{"parts":[{"text":"好了"}]},"finishReason":"STOP"}]}"""))
        val reply = gemini().completeStreaming("s", user, emptyList()) {}
        assertEquals(listOf(Part.Text("好了")), reply.parts)
        assertEquals(StopReason.EndTurn, reply.stopReason)
    }

    @Test fun openAiCompatibleEndpointCanStreamWithoutUsageOption() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("unknown field stream_options"))
        server.enqueue(stream(
            """{"choices":[{"delta":{"content":"继续"},"finish_reason":"stop"}]}""",
            "[DONE]",
        ))
        val model = OpenAiCompatModel(server.url("/v1").toString().trimEnd('/'), "k", "m", caps, OkHttpClient())
        val updates = mutableListOf<String>()
        assertEquals(listOf(Part.Text("继续")), model.completeStreaming("s", user, emptyList(), updates::add).parts)
        assertEquals(listOf("继续"), updates)
        assertTrue(server.takeRequest().body.readUtf8().contains("stream_options"))
        val retried = server.takeRequest().body.readUtf8()
        assertTrue(retried.contains("\"stream\":true"))
        assertTrue(!retried.contains("stream_options"))
    }
}
