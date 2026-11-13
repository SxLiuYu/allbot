package com.wangzan101.mika.core.cap.phone

import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.tool.Args
import com.wangzan101.mika.core.tool.FakeScreen
import com.wangzan101.mika.core.tool.SubActions
import com.wangzan101.mika.core.tool.ToolExecution
import com.wangzan101.mika.core.record.Redactor
import com.wangzan101.mika.core.tool.Verb
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.ScreenEvent
import com.wangzan101.mika.core.uistate.SystemCommandResult
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.UiTreeNode
import com.wangzan101.mika.core.uistate.UiWindowTree
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneAutomationToolsTest {
    private fun tree() = ScreenSnapshot("p1", "com.example.app", emptyList(), 1080, 2400, windows = listOf(
        UiWindowTree(1, "application", 0, "会话", "com.example.app", true, true, listOf(
            UiTreeNode("List", listOf(0, 100, 999, 900), resourceId = "id/messages", children = listOf(
                UiTreeNode("TextView", listOf(30, 200, 900, 260), ref = "@e2", text = "午餐 350", resourceId = "id/message"),
                UiTreeNode("EditText", listOf(30, 900, 900, 950), ref = "@e3", text = "123456", secret = true),
            )),
        )),
    ))

    @Test fun queryKeepsParentRelationshipAndHidesSecret() {
        val found = PhoneAutomationEngine.find(tree(), PhoneAutomationEngine.Query(text = "午餐"), 20)
        assertEquals(1, found["total"]!!.jsonPrimitive.content.toInt())
        val item = found["matches"]!!.jsonArray.single().jsonObject
        assertEquals("@e2", item["ref"]!!.jsonPrimitive.content)
        assertTrue(item["parents"]!!.jsonArray.isNotEmpty())
        assertEquals(0, PhoneAutomationEngine.find(tree(), PhoneAutomationEngine.Query(text = "123456"), 20)["total"]!!.jsonPrimitive.content.toInt())
    }

    @Test fun queryReturnsClickableAncestorForTextOnlyChild() {
        val screen = ScreenSnapshot("p1", "com.example.app", emptyList(), 1080, 2400, windows = listOf(
            UiWindowTree(1, "application", 0, null, "com.example.app", true, true, listOf(
                UiTreeNode("Row", listOf(0, 100, 999, 200), ref = "@e1", clickable = true, children = listOf(
                    UiTreeNode("TextView", listOf(30, 110, 600, 180), text = "打开群聊"),
                )),
            )),
        ))
        val item = PhoneAutomationEngine.find(screen, PhoneAutomationEngine.Query(text = "打开群聊"), 10)["matches"]!!.jsonArray.single().jsonObject
        assertEquals("@e1", item["actionRef"]!!.jsonPrimitive.content)
    }

    @Test fun queryDoesNotEncodeImageEvenWhenRunRecordsFrames() = runTest {
        var screenshots = 0
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot = tree()
            override suspend fun screenshotPng(): ByteArray? { screenshots++; return byteArrayOf(1) }
        }
        val result = toolDispatcher(screen, recordFrames = true).executeRead(Part.ToolCall("q", "phone_query", """{"text":"午餐"}"""))
        assertEquals("true", result.content["ok"]!!.jsonPrimitive.content)
        assertEquals(0, screenshots)
    }

    @Test fun collectMergesOverlapAndStopsAfterTwoPagesWithoutNewText() = runTest {
        val dispatcher = toolDispatcher(FakeScreen())
        val pages = listOf(listOf("甲", "乙"), listOf("乙", "丙"), listOf("丙", "丁"), listOf("丙", "丁"), listOf("丙", "丁"))
        var reads = 0
        var scrolls = 0
        dispatcher.ctx.sub = SubActions { call ->
            if (call.name == "phone_scroll") {
                scrolls++
                ToolExecution(buildJsonObject { put("ok", true) })
            } else {
                val names = pages[reads++].mapIndexed { index, name -> buildJsonObject {
                    put("name", name); put("bounds", JsonArray(listOf(0, 100 + index * 100, 999, 190 + index * 100).map(::JsonPrimitive)))
                } }
                ToolExecution(buildJsonObject {
                    put("ok", true); put("currentApp", "com.example.app"); put("snapshotId", "p$reads")
                    put("elements", JsonArray(names))
                })
            }
        }
        val args = Args(PhoneCollect.def, Json.parseToJsonElement("""{"direction":"down","pages":10}""").jsonObject)
        val result = PhoneCollect.execute(args, dispatcher.ctx).content
        assertEquals("no_new_content", result["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals(5, reads)
        assertEquals(4, scrolls)
        assertTrue(result["text"]!!.jsonPrimitive.content.contains("甲\n乙\n丙\n丁"))
        assertFalse(result["truncated"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test fun collectInterleavesOcrOnlyLinesInVisualOrder() = runTest {
        val dispatcher = toolDispatcher(FakeScreen())
        dispatcher.ctx.sub = SubActions {
            val elements = listOf("第一条" to 100, "第三条" to 300).map { (name, y) -> buildJsonObject {
                put("name", name)
                put("bounds", JsonArray(listOf(100, y, 900, y + 50).map(::JsonPrimitive)))
            } }
            ToolExecution(buildJsonObject {
                put("ok", true); put("currentApp", "com.example.app"); put("snapshotId", "p1")
                put("elements", JsonArray(elements))
                put("visibleText", JsonArray(listOf(buildJsonObject {
                    put("text", "第二条")
                    put("bounds", JsonArray(listOf(100, 200, 900, 250).map(::JsonPrimitive)))
                })))
            })
        }
        val args = Args(PhoneCollect.def, Json.parseToJsonElement("""{"direction":"down","pages":1}""").jsonObject)
        val result = PhoneCollect.execute(args, dispatcher.ctx).content
        assertTrue(result["text"]!!.jsonPrimitive.content.contains("第一条\n第二条\n第三条"))
    }

    @Test fun collectUsesOcrWhenAccessibilityTextIsUnreadable() = runTest {
        val dispatcher = toolDispatcher(FakeScreen())
        dispatcher.ctx.sub = SubActions {
            ToolExecution(buildJsonObject {
                put("ok", true); put("currentApp", "com.example.app"); put("snapshotId", "p1")
                put("readable", false); put("imageReason", "empty_elements")
                put("elements", JsonArray(emptyList()))
                put("visibleText", JsonArray(listOf(buildJsonObject {
                    put("text", "群聊消息正文")
                    put("bounds", JsonArray(listOf(100, 200, 900, 250).map(::JsonPrimitive)))
                })))
            })
        }
        val args = Args(PhoneCollect.def, Json.parseToJsonElement("""{"direction":"down","pages":1}""").jsonObject)
        val result = PhoneCollect.execute(args, dispatcher.ctx).content
        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["text"]!!.jsonPrimitive.content.contains("群聊消息正文"))
    }

    @Test fun runResolvesTargetsAgainAndStopsOnAmbiguity() = runTest {
        val dispatcher = toolDispatcher(FakeScreen())
        val calls = mutableListOf<String>()
        dispatcher.ctx.sub = SubActions { call ->
            calls += call.name
            when (call.name) {
                "phone_query" -> {
                    val target = Json.parseToJsonElement(call.argsJson).jsonObject["text"]!!.jsonPrimitive.content
                    ToolExecution(buildJsonObject {
                        put("ok", true); put("snapshotId", "p${calls.size}")
                        put("matches", JsonArray((if (target == "重复") listOf("@e1", "@e2") else listOf("@e1")).map { ref ->
                            buildJsonObject { put("ref", ref); put("name", target); put("clickable", true) }
                        }))
                    })
                }
                "phone_list_elements" -> ToolExecution(buildJsonObject { put("ok", true); put("snapshotId", "p-final") })
                else -> ToolExecution(buildJsonObject { put("ok", true) })
            }
        }
        val json = """{"commands":[{"op":"tap","targetText":"搜索"},{"op":"tap","targetText":"结果"},{"op":"tap","targetText":"重复"}]}"""
        val result = PhoneRun.execute(Args(PhoneRun.def, Json.parseToJsonElement(json).jsonObject), dispatcher.ctx).content
        assertEquals("phone_run_stopped", result["error"]!!.jsonPrimitive.content)
        assertEquals("ambiguous_target", result["reason"]!!.jsonPrimitive.content)
        assertEquals(2, result["completed"]!!.jsonPrimitive.content.toInt())
        assertEquals(2, calls.count { it == "phone_tap" })
        assertEquals(3, calls.count { it == "phone_query" })
    }

    @Test fun runHidesNestedTypedTextInRecord() {
        val redacted = Redactor.args(Verb.PhoneRun, """{"commands":[{"op":"type","text":"秘密"},{"op":"tap","targetText":"发送"}]}""", true)
        assertFalse(redacted.contains("秘密"))
        assertTrue(redacted.contains("发送"))
    }

    @Test fun findScrollsUntilContentContainsTarget() = runTest {
        var page = 0
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot {
                val row = UiTreeNode("TextView", listOf(20, 200, 900, 300), ref = "@e1", text = if (page >= 2) "目标" else "第$page 页")
                val list = UiTreeNode("List", listOf(0, 100, 999, 900), children = listOf(row))
                return tree().copy(windows = listOf(UiWindowTree(1, "application", 0, null, "com.example.app", true, true, listOf(list))))
            }
        }
        val dispatcher = toolDispatcher(screen)
        dispatcher.ctx.sub = SubActions { call ->
            if (call.name == "phone_scroll") page++
            ToolExecution(buildJsonObject { put("ok", true) })
        }
        val args = Args(PhoneFind.def, Json.parseToJsonElement("""{"text":"目标","direction":"down"}""").jsonObject)
        val result = PhoneFind.execute(args, dispatcher.ctx).content
        assertEquals("true", result["found"]!!.jsonPrimitive.content)
        assertEquals("2", result["scrolls"]!!.jsonPrimitive.content)
        assertEquals("@e1", result["matches"]!!.jsonArray.single().jsonObject["ref"]!!.jsonPrimitive.content)
    }

    /** 第一下滚动后列表还在惯性滑动,第二下被拒:等它停下再试一次,不要直接算滚动失败。 */
    @Test fun findRetriesScrollOnceAfterTheListSettles() = runTest {
        var page = 0
        var scrollCalls = 0
        val scrollArgs = mutableListOf<String>()
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot {
                val row = UiTreeNode("TextView", listOf(20, 200, 900, 300), ref = "@e1", text = if (page >= 2) "目标" else "第$page 页")
                val list = UiTreeNode("List", listOf(0, 100, 999, 900), children = listOf(row))
                return tree().copy(windows = listOf(UiWindowTree(1, "application", 0, null, "com.example.app", true, true, listOf(list))))
            }
        }
        val dispatcher = toolDispatcher(screen)
        dispatcher.ctx.sub = SubActions { call ->
            if (call.name == "phone_scroll") {
                scrollCalls++
                scrollArgs += call.argsJson
                when (scrollCalls) {
                    1 -> { page = 1; ToolExecution(buildJsonObject { put("ok", true) }) }
                    2 -> ToolExecution(buildJsonObject { put("ok", false); put("error", "action_failed") })
                    else -> { page = 2; ToolExecution(buildJsonObject { put("ok", true) }) }
                }
            } else ToolExecution(buildJsonObject { put("ok", true) })
        }
        val args = Args(PhoneFind.def, Json.parseToJsonElement("""{"text":"目标","direction":"down"}""").jsonObject)
        val result = PhoneFind.execute(args, dispatcher.ctx).content
        assertEquals("true", result["found"]!!.jsonPrimitive.content)
        assertEquals("2", result["scrolls"]!!.jsonPrimitive.content)
        assertEquals(3, scrollCalls)
        assertTrue("重试改用手势滑动", scrollArgs[2].contains("\"amount\":4"))
    }

    /** 一个目标始终不在树里的屏:只靠 phone_find 的子动作返回什么来决定停在哪。 */
    private fun findDispatcher(screen: ScreenPort, scroll: () -> ToolExecution): Pair<com.wangzan101.mika.core.tool.ToolDispatcher, () -> Int> {
        var scrolls = 0
        val d = toolDispatcher(screen)
        d.ctx.sub = SubActions { call ->
            if (call.name == "phone_scroll") { scrolls++; scroll() } else ToolExecution(buildJsonObject { put("ok", true) })
        }
        return d to { scrolls }
    }

    /** 滚动失败时要把底层错误码和「为什么停下」分开,别让模型把 action_failed 当成目标不存在。 */
    @Test fun findSeparatesScrollFailureFromStoppedReason() = runTest {
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot = tree()
        }
        val (d, scrolls) = findDispatcher(screen) { ToolExecution(buildJsonObject { put("ok", false); put("error", "action_failed") }) }
        val r = PhoneFind.execute(Args(PhoneFind.def, Json.parseToJsonElement("""{"text":"关于手机","direction":"down"}""").jsonObject), d.ctx).content
        assertEquals("scroll_failed", r["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals("action_failed", r["scrollError"]!!.jsonPrimitive.content)
        assertEquals("false", r["found"]!!.jsonPrimitive.content)
        assertEquals("无障碍滚动和手势兜底都失败", 2, scrolls())
        assertFalse(r.containsKey("hint"))
    }

    /** 列表内容连着两屏不动:这是到了尽头,不是滚动失败,也没有内部错误码。 */
    @Test fun findReportsContentUnchangedWithoutRetrying() = runTest {
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot = tree()
        }
        val (d, scrolls) = findDispatcher(screen) { ToolExecution(buildJsonObject { put("ok", true) }) }
        val r = PhoneFind.execute(Args(PhoneFind.def, Json.parseToJsonElement("""{"text":"关于手机","direction":"down"}""").jsonObject), d.ctx).content
        assertEquals("content_unchanged", r["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals("false", r["found"]!!.jsonPrimitive.content)
        assertEquals(2, scrolls())
        assertFalse(r.containsKey("scrollError"))
        assertFalse(r.containsKey("hint"))
    }

    /** 到达 maxScrolls 还没找到:按次数停下,和滚动失败分开。 */
    @Test fun findReportsScrollLimitSeparately() = runTest {
        var page = 0
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot {
                val row = UiTreeNode("TextView", listOf(20, 200, 900, 300), ref = "@e1", text = "第$page 页")
                return tree().copy(windows = listOf(UiWindowTree(1, "application", 0, null, "com.example.app", true, true,
                    listOf(UiTreeNode("List", listOf(0, 100, 999, 900), children = listOf(row))))))
            }
        }
        val d = toolDispatcher(screen)
        d.ctx.sub = SubActions { call ->
            if (call.name == "phone_scroll") page++
            ToolExecution(buildJsonObject { put("ok", true) })
        }
        val r = PhoneFind.execute(Args(PhoneFind.def, Json.parseToJsonElement("""{"text":"关于手机","direction":"down","maxScrolls":2}""").jsonObject), d.ctx).content
        assertEquals("scroll_limit", r["stoppedBecause"]!!.jsonPrimitive.content)
        assertEquals("2", r["scrolls"]!!.jsonPrimitive.content)
        assertFalse(r.containsKey("scrollError"))
        assertFalse(r.containsKey("hint"))
    }

    @Test fun extractGroupsListRowsAndOmitsSecretValue() = runTest {
        val base = tree()
        val root = base.windows.single().nodes.single()
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot = base.copy(windows = base.windows.map {
                it.copy(nodes = listOf(root.copy(scrollable = true, children = root.children.map { child ->
                    if (child.secret) child.copy(editable = true) else child
                })))
            })
        }
        val dispatcher = toolDispatcher(screen)
        val list = PhoneExtract.execute(Args(PhoneExtract.def, Json.parseToJsonElement("""{"mode":"list"}""").jsonObject), dispatcher.ctx).content
        assertEquals("1", list["count"]!!.jsonPrimitive.content)
        assertTrue(list.toString().contains("午餐 350"))
        assertFalse(list.toString().contains("123456"))
        val form = PhoneExtract.execute(Args(PhoneExtract.def, Json.parseToJsonElement("""{"mode":"form"}""").jsonObject), dispatcher.ctx).content
        assertEquals("true", form["items"]!!.jsonArray.single().jsonObject["secret"]!!.jsonPrimitive.content)
        assertFalse(form.toString().contains("123456"))
    }

    @Test fun waitUsesScreenConditionAndCommandUsesSystemPort() = runTest {
        var condition = ""
        var command = ""
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun waitFor(c: String, value: String?, timeoutMs: Long): Boolean {
                condition = "$c:$value:$timeoutMs"; return true
            }
            override suspend fun systemCommand(c: String): SystemCommandResult {
                command = c; return SystemCommandResult(0, "shell")
            }
        }
        val dispatcher = toolDispatcher(screen)
        val wait = PhoneWait.execute(Args(PhoneWait.def, Json.parseToJsonElement("""{"condition":"appear","value":"完成","timeoutMs":8000}""").jsonObject), dispatcher.ctx)
        assertEquals("true", wait.content["met"]!!.jsonPrimitive.content)
        assertEquals("appear:完成:8000", condition)
        val cmd = PhoneCommand.execute(Args(PhoneCommand.def, Json.parseToJsonElement("""{"command":"pm list packages"}""").jsonObject), dispatcher.ctx)
        assertEquals("pm list packages", command)
        assertTrue(cmd.content["output"]!!.jsonPrimitive.content.contains("shell"))
        assertFalse(Redactor.args(Verb.PhoneCommand, """{"command":"echo private"}""", false).contains("private"))
    }

    @Test fun gestureConvertsTwoFingerPathsToPixels() = runTest {
        var paths: List<List<Pair<Int, Int>>> = emptyList()
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot(): ScreenSnapshot = tree()
            override suspend fun gesture(p: List<List<Pair<Int, Int>>>, durationMs: Long): ActionResult {
                paths = p; return ActionResult.Ok(changed = true)
            }
        }
        val dispatcher = toolDispatcher(screen)
        val args = Args(PhoneGesture.def, Json.parseToJsonElement("""{"paths":[[[400,500],[200,500]],[[600,500],[800,500]]]}""").jsonObject)
        val result = PhoneGesture.execute(args, dispatcher.ctx)
        assertEquals("true", result.content["ok"]!!.jsonPrimitive.content)
        assertEquals(2, paths.size)
        assertTrue(paths[0][0].first < paths[1][0].first)
    }

    @Test fun eventWatchReturnsSeveralNotificationsFromOneSubscription() = runTest {
        var requested = ""
        val screen = object : ScreenPort by FakeScreen() {
            override suspend fun watchEvents(kind: String, packageName: String?, durationMs: Long, maxEvents: Int): List<ScreenEvent> {
                requested = "$kind:$packageName:$durationMs:$maxEvents"
                return listOf(ScreenEvent("notification", "com.example.app", "第一条"), ScreenEvent("notification", "com.example.app", "第二条"))
            }
        }
        val dispatcher = toolDispatcher(screen)
        val args = Args(PhoneEventTool.def, Json.parseToJsonElement("""{"kind":"notification","mode":"watch","packageName":"com.example.app","timeoutMs":9000,"maxEvents":5}""").jsonObject)
        val result = PhoneEventTool.execute(args, dispatcher.ctx).content
        assertEquals("notification:com.example.app:9000:5", requested)
        assertEquals("2", result["count"]!!.jsonPrimitive.content)
        assertTrue(result.toString().contains("第二条"))
    }
}
