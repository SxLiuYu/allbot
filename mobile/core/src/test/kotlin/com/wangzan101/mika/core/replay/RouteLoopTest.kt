package com.wangzan101.mika.core.replay

import com.wangzan101.mika.core.action.ActionExecutor
import com.wangzan101.mika.core.action.ActionRecorder
import com.wangzan101.mika.core.action.Origin
import com.wangzan101.mika.core.action.execution
import com.wangzan101.mika.core.agent.FakeModel
import com.wangzan101.mika.core.gate.ConfirmationGate
import com.wangzan101.mika.core.guard.OperationGuards
import com.wangzan101.mika.core.model.ModelReply
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.StopReason
import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.testing.TOOLS
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 录制、匹配、回放三段各自的测试在别的文件里;这里只钉一件事:一段真实运行记下来的路线,
 * 经过落盘编码、按新原话匹配,能原样在同样的界面上跑完,而且输入的字仍是新原话里的那一段。
 */
class RouteLoopTest {
    private val goal = "在备忘录里写今天天气不错"
    private val home = Anchors("com.notes", listOf("备忘录", "全部笔记"))
    private val editor = Anchors("com.notes", listOf("新笔记", "完成"))
    private val newBtn = Selector("button", "新建", "n:id/new", listOf(800, 900, 999, 999), 0)
    private val field = Selector("edit", "", "n:id/body", listOf(0, 100, 999, 900), 0)

    private fun target(step: Int, tool: String, args: String, sel: Selector?, before: Anchors, after: Anchors, callId: String) =
        RunEvent.ActionTarget(step.toLong(), step, tool, args, sel, before, after, true, callId)

    private fun result(step: Int, tool: String, json: String, callId: String) =
        RunEvent.ToolResult(step.toLong(), step, tool, json, true, null, callId = callId)

    /** 一次办成的运行,形状与 Notes 那套界面一致(所以记下来的路线能在那块屏上回放)。 */
    private fun successfulRun(typed: String) = listOf(
        RunEvent.TaskStarted(0, goal, "m"),
        target(1, "phone_launch_app", """{"package":"com.notes"}""", null, Anchors(null, emptyList()), home, "c1"),
        result(1, "phone_launch_app", """{"ok":true,"changed":true}""", "c1"),
        target(2, "phone_tap", """{"ref":"@e2","snapshotId":"s1"}""", newBtn, home, editor, "c2"),
        result(2, "phone_tap", """{"ok":true,"changed":true}""", "c2"),
        target(3, "phone_type_text", """{"ref":"@e3","snapshotId":"s2","text":"$typed"}""", field, editor, Anchors("com.notes", emptyList()), "c3"),
        result(3, "phone_type_text", """{"ok":true,"typed":6,"secret":false,"verification":"match"}""", "c3"),
        RunEvent.TaskEnded(4, "succeeded", "写好了"),
    )

    @Test fun recordedRouteSurvivesStorageAndReplaysWithNewSlot() = runTest {
        // 1. 录制
        val recorded = RouteRecorder.record(goal, successfulRun("今天天气不错"), nowMs = 7, tools = TOOLS)
        assertNotNull("这次运行应该能记成路线", recorded)
        val route = recorded!!
        assertEquals("在备忘录里写{1}", route.template)
        assertEquals(listOf("phone_launch_app", "phone_tap", "phone_type_text"), route.steps.map { it.tool })

        // 2. 落盘再读回来(FileRouteStore 走同一套编解码)
        val stored = RouteCodec.decode(RouteCodec.encode(route))
        assertEquals(route, stored)

        // 3. 按一句换了参数的新原话匹配
        val newGoal = "在备忘录里写周末去爬山"
        val model = FakeModel(ModelReply(listOf(Part.Text("""{"route":1,"slots":["周末去爬山"]}""")), StopReason.EndTurn, null))
        val choice = RouteMatcher(model, MemRoutes(stored), null).choose(newGoal)
        assertNotNull("模板对得上就该选中它", choice)
        assertEquals(listOf("周末去爬山"), choice!!.slots)

        // 4. 在同样的界面上回放
        val screen = Notes.screen()
        val out = replayerOn(toolDispatcherFor(screen), Events()).run(choice)
        assertEquals(ReplayOutcome.Completed(3), out)
        assertEquals(listOf("新建"), screen.taps)
        assertEquals(listOf("周末去爬山"), screen.typed)
    }

    @Test fun recordedRouteIsNotReusedForUnrelatedRequest() = runTest {
        val stored = RouteCodec.decode(RouteCodec.encode(RouteRecorder.record(goal, successfulRun("今天天气不错"), 7, TOOLS)!!))
        val model = FakeModel(ModelReply(listOf(Part.Text("""{"route":null}""")), StopReason.EndTurn, null))
        // 候选里没有相似的,根本不该叫模型
        assertEquals(null, RouteMatcher(model, MemRoutes(stored), null).choose("打开计算器算 12 乘 34"))
        assertEquals(0, model.requests.size)
    }

    /**
     * 一次真实的「先滚着找、找到再点」:查找内部滚了几次、停在哪个编号上都不进路线,
     * 回放时按查找条件重新滚一遍,再用目标特征点新找到的那一行。
     */
    @Test fun findStepReplaysAsAWholeAgainstANewTarget() = runTest {
        val goal = "去设置里找到关于手机"
        fun home() = listOf(
            ui("@h1", "text", "设置", listOf(0, 0, 999, 60), clickable = false),
            ui("@h2", "text", "网络与互联网", listOf(0, 60, 999, 120), clickable = false),
        )
        fun screen(label: String, ref: String) = PagedScreen(
            mapOf(
                "home" to home(),
                "found" to listOf(ui(ref, "button", label, listOf(0, 200, 999, 280))),
                "detail" to listOf(ui("@d1", "text", label, listOf(0, 0, 999, 60), clickable = false)),
            ),
        ).apply {
            pkg = "com.settings"
            onScroll = { page = "found" }
            links["found" to label] = "detail"
        }

        // 录制:查找 + 点击
        val recorded = screen("关于手机", "@e1")
        val sink = Events()
        val executor = ActionExecutor(
            toolDispatcherFor(recorded), OperationGuards(), ConfirmationGate(), gate = {}, recorder = ActionRecorder(sink),
        )
        val find = executor.run(
            Part.ToolCall("c1", "phone_find", """{"text":"关于手机","direction":"down"}"""), Origin.Model(1),
        ).execution().content
        assertEquals("true", find["found"]!!.jsonPrimitive.content)
        val ref = find["matches"]!!.jsonArray.first().jsonObject["ref"]!!.jsonPrimitive.content
        val snapshot = find["snapshotId"]!!.jsonPrimitive.content
        executor.run(
            Part.ToolCall("c2", "phone_tap", buildJsonObject { put("ref", ref); put("snapshotId", snapshot) }.toString()),
            Origin.Model(2),
        )
        sink.event(RunEvent.TaskEnded(3, "succeeded", "打开了"))

        val route = RouteRecorder.record(goal, sink.all, nowMs = 7, tools = TOOLS)!!
        assertEquals(listOf("phone_find", "phone_tap"), route.steps.map { it.tool })
        assertNull("查找不记目标元素", route.steps[0].target)
        val args = Json.parseToJsonElement(route.steps[0].argsJson).jsonObject
        assertEquals("{1}", args["text"]!!.jsonPrimitive.content)
        assertEquals("down", args["direction"]!!.jsonPrimitive.content)

        // 回放:同一个位置换成另一个目标,查找自己滚到它,再按特征点中
        val replayScreen = screen("电池", "@e1")
        val out = replayerOn(toolDispatcherFor(replayScreen), Events())
            .run(RouteChoice(RouteCodec.decode(RouteCodec.encode(route)), listOf("电池")))
        assertEquals(ReplayOutcome.Completed(2), out)
        assertTrue("查找滚过一屏", replayScreen.log.contains("scroll"))
        assertEquals(listOf("电池"), replayScreen.taps)
    }

    private fun toolDispatcherFor(screen: com.wangzan101.mika.core.uistate.ScreenPort) =
        com.wangzan101.mika.core.assembly.toolDispatcher(screen).also { it.captureTargets = true }
}
