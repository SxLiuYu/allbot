package com.wangzan101.mika.core.remote

import com.wangzan101.mika.core.agent.TaskState
import com.wangzan101.mika.core.mcp.FakeRemoteTasks
import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.record.RunRecords
import com.wangzan101.mika.core.record.RunSummary
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.net.InetAddress

class RemoteTaskApiTest {
    private val tasks = FakeRemoteTasks()
    private val host = RemoteHost(tasks, { TOKEN }, 0, false, "test")
    private val client = OkHttpClient()
    @Before fun start() = host.start()
    @After fun stop() { host.stop(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }

    private fun request(path: String, method: String = "GET", body: String? = null, token: String? = TOKEN,
        headers: Map<String, String> = emptyMap(), port: Int = host.boundPort): Pair<Int, JsonObject> {
        val builder = Request.Builder().url("http://127.0.0.1:$port$path")
            .method(method, body?.toRequestBody((headers["Content-Type"] ?: "application/json").toMediaType()))
        token?.let { builder.header("Authorization", "Bearer $it") }
        headers.forEach { (k, v) -> builder.header(k, v) }
        return client.newCall(builder.build()).execute().use { r -> r.code to Json.parseToJsonElement(r.body!!.string()).jsonObject }
    }

    private fun mcp(name: String, args: JsonObject): JsonObject = request("/mcp", "POST", buildJsonObject {
        put("jsonrpc", "2.0"); put("id", 1); put("method", "tools/call")
        putJsonObject("params") { put("name", name); put("arguments", args) }
    }.toString()).second["result"]!!.jsonObject

    @Test fun bothAdaptersUseTheSameTasksAndConversationNamespace() {
        val (code, first) = request("/api/v1/tasks", "POST", """{"goal":"from CLI"}""")
        assertEquals(201, code)
        val id = first["task_id"]!!.jsonPrimitive.content
        val viaMcp = mcp("mika_task_status", buildJsonObject { put("task_id", id) })["structuredContent"]!!.jsonObject
        assertEquals(first, viaMcp)
        val second = mcp("mika_run_task", buildJsonObject {
            put("goal", "from MCP"); put("conversation", first["conversation"]!!)
        })["structuredContent"]!!.jsonObject
        assertEquals(first["conversation"], second["conversation"])
        val list = request("/api/v1/tasks?limit=1").second["tasks"]!!.jsonArray
        assertEquals(1, list.size)
        assertEquals(second["task_id"], list[0].jsonObject["task_id"])
        assertEquals(2, tasks.tasks.size)
    }

    @Test fun answerAndCancellationGoThroughTheSameRules() {
        request("/api/v1/tasks", "POST", """{"goal":"a task"}""")
        tasks.set("t1", TaskState.WaitingTakeover("payment", "Use the phone"))
        assertEquals(409, request("/api/v1/tasks/t1/answer", "POST", """{"text":"yes"}""").first)
        assertTrue(mcp("mika_answer", buildJsonObject { put("task_id", "t1"); put("text", "yes") })["isError"]!!.jsonPrimitive.boolean)
        assertTrue(tasks.answers.isEmpty())
        tasks.set("t1", TaskState.WaitingInput("Which account?"))
        assertEquals(200, request("/api/v1/tasks/t1/answer", "POST", """{"text":"personal"}""").first)
        assertEquals(listOf("t1" to "personal"), tasks.answers)
        val (status, cancelled) = request("/api/v1/tasks/t1/cancel", "POST", "{}")
        assertEquals(202, status)
        assertTrue(cancelled["accepted"]!!.jsonPrimitive.boolean)
        assertNull(cancelled["status"])
        assertEquals("waiting_for_answer", request("/api/v1/tasks/t1").second["status"]!!.jsonPrimitive.content)
        tasks.set("t1", TaskState.Cancelled)
        assertEquals("cancelled", mcp("mika_task_status", buildJsonObject { put("task_id", "t1") })["structuredContent"]!!.jsonObject["status"]!!.jsonPrimitive.content)
    }

    @Test fun resultsPreserveVerificationUnknownFalseAndTrue() {
        request("/api/v1/tasks", "POST", """{"goal":"a task"}""")
        tasks.set("t1", TaskState.Succeeded("answer", reviewed = false))
        assertNull(request("/api/v1/tasks/t1").second["verified"])
        for (verified in listOf(false, true)) {
            tasks.set("t1", TaskState.Succeeded("answer", verified = verified, reviewed = true))
            val viaApi = request("/api/v1/tasks/t1").second
            val viaMcp = mcp("mika_task_status", buildJsonObject { put("task_id", "t1") })["structuredContent"]!!.jsonObject
            assertEquals(viaMcp, viaApi)
            assertEquals(verified, viaApi["verified"]!!.jsonPrimitive.boolean)
        }
    }

    @Test fun httpAndMcpSteerTheSameTaskAndReportReceiptSeparatelyFromConsumption() {
        val info = request("/api/v1").second
        assertTrue(info["capabilities"]!!.jsonArray.any { it.jsonPrimitive.content == "task_steer" })
        assertEquals(RemoteTaskService.MAX_STEER, info["limits"]!!.jsonObject["max_steer"]!!.jsonPrimitive.int)
        request("/api/v1/tasks", "POST", """{"goal":"read"}""")
        tasks.set("t1", TaskState.Running(1, "reading"))
        val (code, ack) = request("/api/v1/tasks/t1/steer", "POST", """{"text":"only today"}""")
        assertEquals(202, code)
        assertTrue(ack["accepted"]!!.jsonPrimitive.boolean)
        assertEquals("s1", ack["message_id"]!!.jsonPrimitive.content)
        assertNull(ack["status"])
        val viaMcp = mcp("mika_steer_task", buildJsonObject { put("task_id", "t1"); put("text", "only read") })["structuredContent"]!!.jsonObject
        assertEquals("s2", viaMcp["message_id"]!!.jsonPrimitive.content)
        val task = tasks.get("t1")!!
        assertEquals(listOf("t1" to "only today", "t1" to "only read"), tasks.steered)
        tasks.tasks["t1"] = task.copy(steers = listOf(RemoteSteer("s1", "joined"), RemoteSteer("s2", "received")))
        val status = request("/api/v1/tasks/t1").second
        assertEquals(status, mcp("mika_task_status", buildJsonObject { put("task_id", "t1") })["structuredContent"]!!.jsonObject)
        assertEquals(listOf("joined", "received"), status["steers"]!!.jsonArray.map { it.jsonObject["state"]!!.jsonPrimitive.content })
        assertEquals(1, tasks.tasks.size)
    }

    @Test fun rejectedSteersNeverDeliverOrStartNewTasks() {
        request("/api/v1/tasks", "POST", """{"goal":"read"}""")
        tasks.set("t1", TaskState.Running(1, "reading"))
        for (body in listOf("{}", """{"text":7}""", """{"text":" "}""", """{"text":"more","approve":true}""")) {
            assertEquals(400, request("/api/v1/tasks/t1/steer", "POST", body).first)
        }
        assertEquals(404, request("/api/v1/tasks/local-task/steer", "POST", """{"text":"more"}""").first)
        assertEquals(405, request("/api/v1/tasks/t1/steer").first)
        tasks.set("t1", TaskState.WaitingTakeover("payment", "Use phone"))
        assertEquals(409, request("/api/v1/tasks/t1/steer", "POST", """{"text":"approve"}""").first)
        tasks.set("t1", TaskState.Cancelled)
        assertEquals(409, request("/api/v1/tasks/t1/steer", "POST", """{"text":"continue"}""").first)
        assertTrue(tasks.steered.isEmpty())
        assertEquals(1, tasks.tasks.size)
    }

    @Test fun malformedInputNeverStartsATaskAndMissingTasksAre404() {
        for (body in listOf("[]", "bad", "{}", """{"goal":7}""", """{"goal":"x","read_only":true}""",
            """{"goal":"x","conversation":"local-id"}""")) {
            assertEquals(body, 400, request("/api/v1/tasks", "POST", body).first)
        }
        assertTrue(tasks.tasks.isEmpty())
        assertEquals(404, request("/api/v1/tasks/missing").first)
        assertEquals(400, request("/api/v1/tasks?limit=1&limit=2").first)
        assertEquals(400, request("/api/v1/tasks?limit=0").first)
        assertEquals(400, request("/api/v1/tasks?unknown=1").first)
        assertEquals(405, request("/api/v1/tasks/t1", "POST", "{}").first)
        assertEquals(415, request("/api/v1/tasks", "POST", "{}", headers = mapOf("Content-Type" to "text/plain")).first)
        assertEquals(404, request("/api/v1/other").first)
    }

    @Test fun authenticationAndRateLimitsAreSharedAcrossBothRoutes() {
        assertEquals(401, request("/api/v1", token = null).first)
        assertEquals(403, request("/api/v1", headers = mapOf("Origin" to "https://example.test")).first)
        // The same caller's failures on either route count against one policy instance.
        repeat(4) { assertEquals(401, request(if (it % 2 == 0) "/mcp" else "/api/v1", token = "wrong").first) }
        assertEquals(429, request("/api/v1").first)
        assertEquals(429, request("/mcp", "POST", "{}").first)
    }

    @Test fun unknownRoutesAreAuthenticatedAndLoopbackCredentialsStayLocal() {
        assertEquals(401, request("/other", token = null).first)
        assertEquals(404, request("/other").first)
        val localOnly = RemoteHost(tasks, { null }, 0, false, "test", loopbackToken = { TOKEN })
        fun req(address: String) = HttpRequest("GET", "/api/v1", mapOf("authorization" to "Bearer $TOKEN"), byteArrayOf(), InetAddress.getByName(address))
        assertEquals(200, localOnly.handle(req("127.0.0.1")).status)
        assertEquals(401, localOnly.handle(req("192.168.1.20")).status)
    }

    /**
     * 运行记录:远程下发任务也要能读步数、token 和结局判定。
     * 这些只在 run.json 里,以前只有 adb 读得到,直连和网关模式下量不到指标。
     */
    @Test fun runRecordsAreReadableAndLinkedFromTheTask() {
        val summaries = mapOf("r1" to RunSummary("r1", "打开支付宝看余额", model = "m", startedAtMs = 100,
            endedAtMs = 9_100, outcome = "succeeded", answerOrReason = "5.48 元", judged = "done", steps = 8,
            inputTokens = 123_456, outputTokens = 789, cachedTokens = 100_000, origin = "mcp"))
        val runs = object : RunRecords {
            override suspend fun summary(runId: String) = summaries[runId]
            override suspend fun events(runId: String) = emptyList<RunEvent>()
        }
        val withRuns = RemoteHost(tasks, { TOKEN }, 0, false, "test",
            endpoints = RemoteEndpoints(tasks, "test", runs = runs))
        withRuns.start()
        try {
            fun viaHost(path: String) = withRuns.handle(HttpRequest("GET", path,
                mapOf("authorization" to "Bearer $TOKEN", "accept" to "application/json"), byteArrayOf(), InetAddress.getByName("127.0.0.1")))
            // 有能力声明,电脑据此判断能不能读
            val info = Json.parseToJsonElement(viaHost("/api/v1").body.toString(Charsets.UTF_8)).jsonObject
            assertTrue(info["capabilities"]!!.jsonArray.any { it.jsonPrimitive.content == "runs" })

            val (code, run) = request("/api/v1/runs/r1", port = withRuns.boundPort)
            assertEquals(200, code)
            assertEquals("r1", run["run_id"]!!.jsonPrimitive.content)
            assertEquals("done", run["judged"]!!.jsonPrimitive.content)
            assertEquals(8, run["steps"]!!.jsonPrimitive.int)
            assertEquals(123_456, run["input_tokens"]!!.jsonPrimitive.int)
            assertEquals(9_100L, run["ended_at_ms"]!!.jsonPrimitive.long)
            assertEquals("mcp", run["origin"]!!.jsonPrimitive.content)
            // 缺的字段不写,「没量到」和「量到 0」分得开
            assertNull(run["verdict"])

            assertEquals(404, request("/api/v1/runs/nope", port = withRuns.boundPort).first)
            assertEquals(404, request("/api/v1/runs", port = withRuns.boundPort).first)
        } finally {
            withRuns.stop(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }

    /**
     * /runs/{id}/events:判「规则触发没有」要看 ToolResult 的 errorCode / fallback 和 State 的
     * stall_detected / stall_stopped,这些都不在概要里。远程模式下没有 adb,只能靠这个端点。
     */
    @Test fun runEventsAreReadableSoRulesCanBeJudgedRemotely() {
        val events = listOf(
            RunEvent.ToolResult(1, 1, "phone_back", """{"ok":false,"error":"action_failed"}""", null, null, errorCode = "action_failed"),
            RunEvent.ToolResult(2, 2, "phone_back", """{"ok":false,"error":"action_failed"}""", null, null,
                errorCode = "action_failed", sameErrorStreak = 2, fallback = "phone_system_command"),
            RunEvent.State(3, "stall_stopped", "probe_loop"),
        )
        val runs = object : RunRecords {
            override suspend fun summary(runId: String) = RunSummary(runId, "g", startedAtMs = 1)
            override suspend fun events(runId: String) = if (runId == "r1") events else emptyList()
        }
        val host = RemoteHost(tasks, { TOKEN }, 0, false, "test",
            endpoints = RemoteEndpoints(tasks, "test", runs = runs))
        host.start()
        try {
            val (code, body) = request("/api/v1/runs/r1/events", port = host.boundPort)
            assertEquals(200, code)
            assertEquals("r1", body["run_id"]!!.jsonPrimitive.content)
            val list = body["events"]!!.jsonArray
            assertEquals(3, list.size)
            val first = list[0].jsonObject
            assertEquals("tool_result", first["type"]!!.jsonPrimitive.content)
            assertEquals("phone_back", first["tool"]!!.jsonPrimitive.content)
            assertEquals("action_failed", first["errorCode"]!!.jsonPrimitive.content)
            // 换路标记要带出来,否则判不出「失败后有没有照提示换做法」
            assertEquals("phone_system_command", list[1].jsonObject["fallback"]!!.jsonPrimitive.content)
            assertEquals("stall_stopped", list[2].jsonObject["name"]!!.jsonPrimitive.content)
            assertEquals("probe_loop", list[2].jsonObject["detail"]!!.jsonPrimitive.content)
            // 没有事件的运行给 404,而不是一个空数组
            assertEquals(404, request("/api/v1/runs/r2/events", port = host.boundPort).first)
        } finally {
            host.stop(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }

    /** 没接运行记录时,能力里不声明 runs,端点也不出现(而不是声明了再报错)。 */
    @Test fun runsEndpointIsAbsentWithoutRunRecords() {
        assertEquals(404, request("/api/v1/runs/r1").first)
        val info = request("/api/v1").second
        assertFalse(info["capabilities"]!!.jsonArray.any { it.jsonPrimitive.content == "runs" })
    }

    private companion object { const val TOKEN = "test-api-token" }
}
