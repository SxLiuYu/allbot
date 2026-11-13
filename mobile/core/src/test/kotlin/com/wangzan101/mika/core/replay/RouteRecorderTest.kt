package com.wangzan101.mika.core.replay

import com.wangzan101.mika.core.record.RunEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wangzan101.mika.core.testing.TOOLS

class RouteRecorderTest {
    private val goal = "在备忘录里写今天天气不错"
    private val home = Anchors("com.notes", listOf("备忘录", "全部笔记"))
    private val editor = Anchors("com.notes", listOf("新笔记", "完成"))
    private val newBtn = Selector("button", "新建", "n:id/new", listOf(800, 900, 999, 999), 0)
    private val field = Selector("edit", "", "n:id/body", listOf(0, 120, 999, 900), 0)

    private fun target(step: Int, tool: String, args: String, sel: Selector? = null, before: Anchors = home, after: Anchors = editor, effective: Boolean = true,
                       callId: String = "c$step", protected: Boolean = false) =
        RunEvent.ActionTarget(step.toLong(), step, tool, args, sel, before, after, effective, callId, protected)

    private fun result(step: Int, tool: String, json: String, callId: String = "c$step", source: String = "model") =
        RunEvent.ToolResult(step.toLong(), step, tool, json, true, null, source = source, callId = callId)

    /** 一次核查通过的成功运行;[middle] 插在动作之间。 */
    private fun run(vararg middle: RunEvent, typed: String = "今天天气不错", typedResult: String = """{"ok":true,"typed":6,"secret":false,"verification":"match"}""",
                    goal: String = this.goal) = listOf(
        RunEvent.TaskStarted(0, goal, "m"),
        RunEvent.Criteria(1, listOf("写了"), emptyList()),
        target(1, "phone_launch_app", """{"package":"com.notes"}""", before = Anchors(null, emptyList()), after = home),
        result(1, "phone_launch_app", """{"ok":true}"""),
        RunEvent.ToolResult(2, 2, "phone_observe", """{"ok":true,"currentApp":"com.notes"}""", null, 1),
        target(3, "phone_tap", """{"ref":"@e2","snapshotId":"s1"}""", newBtn),
        result(3, "phone_tap", """{"ok":true,"changed":true}"""),
        *middle,
        target(4, "phone_type_text", """{"ref":"@e9","snapshotId":"s2","text":"$typed"}""", field, before = editor, after = Anchors("com.notes", listOf("保存"))),
        result(4, "phone_type_text", typedResult),
        // 另一次调用的结果(同一步号)不能拿来配对
        result(4, "phone_type_text", """{"ok":true,"secret":false}""", callId = "other"),
        RunEvent.Verifier(5, "pass", "{}"),
        RunEvent.TaskEnded(6, "succeeded", "写好了"),
    )

    @Test fun recordsOnlyEffectiveWrites() {
        val events = run(
            target(3, "phone_tap", """{"x":10,"y":10}""", effective = false),
            result(3, "phone_tap", """{"ok":true,"changed":false}"""),
            target(3, "phone_scroll", """{"direction":"down"}""", effective = false),
        )
        val r = RouteRecorder.record(goal, events, nowMs = 99, tools = TOOLS)!!
        assertEquals(listOf("phone_launch_app", "phone_tap", "phone_type_text"), r.steps.map { it.tool })
        assertEquals(listOf("com.notes"), r.packages)
        assertEquals(99, r.lastUsedMs)
        // 编号是一次读屏内的,路线里只留选择器
        val tap = Json.parseToJsonElement(r.steps[1].argsJson).jsonObject
        assertFalse("ref" in tap); assertFalse("snapshotId" in tap)
        assertEquals(newBtn, r.steps[1].target)
    }

    @Test fun runsThatUsedTheBrowserAreNotRecorded() {
        // 网页任务:用过 web_navigate,之后在网页上点的是共用的 tap,也不记
        val events = run(
            RunEvent.ModelReply(3, 3, "", "web_navigate", "{}", null, null, null),
            result(3, "web_navigate", """{"ok":true,"surface":"web"}"""),
        )
        assertNull(RouteRecorder.record(goal, events, 0, TOOLS))
    }

    @Test fun onlySucceededRunsMakeRoutes() {
        // 办没办成由调用方按 LearnGate 判;没跑核查的运行照样记得下
        assertNotNull(RouteRecorder.record(goal, run().filter { it !is RunEvent.Verifier }, 1, TOOLS))
        val ended = run().map { if (it is RunEvent.TaskEnded) RunEvent.TaskEnded(6, "failed", "x") else it }
        assertNull(RouteRecorder.record(goal, ended, 1, TOOLS))
    }

    @Test fun typedTextInGoalBecomesSlot() {
        val r = RouteRecorder.record(goal, run(), 1, TOOLS)!!
        assertEquals("在备忘录里写{1}", r.template)
        assertEquals(1, r.slots)
        val typed = Json.parseToJsonElement(r.steps[2].argsJson).jsonObject
        assertEquals("{1}", typed["text"]!!.jsonPrimitive.content)
        assertFalse(r.steps.any { "今天天气不错" in it.argsJson })
    }

    @Test fun typedTextNotASlotMeansNoRoute() {
        // 不在原话里、太短、在原话里出现不止一次、被更长的槽吞掉:都不记
        assertNull(RouteRecorder.record(goal, run(typed = "日记"), 1, TOOLS))
        assertNull(RouteRecorder.record("写个a", run(typed = "a", goal = "写个a"), 1, TOOLS))
        val twice = "写今天天气不错,今天天气不错"
        assertNull(RouteRecorder.record(twice, run(goal = twice), 1, TOOLS))
        val swallowed = run(target(3, "phone_type_text", """{"text":"天气"}""", field, callId = "s"), result(3, "phone_type_text", """{"ok":true,"secret":false}""", callId = "s"))
        assertNull(RouteRecorder.record(goal, swallowed, 1, TOOLS))
    }

    @Test fun targetNameInGoalBecomesSlot() {
        val memo = Selector("button", "备忘录", null, listOf(0, 0, 100, 100), 0, uniqueAtRecord = true)
        val events = run(target(3, "phone_tap", """{"ref":"@e1","snapshotId":"s1","target":"备忘录图标"}""", memo, callId = "m"),
            result(3, "phone_tap", """{"ok":true,"changed":true}""", callId = "m"))
        val r = RouteRecorder.record(goal, events, 1, TOOLS)!!
        assertEquals("在{1}里写{2}", r.template)
        assertEquals(2, r.slots)
        val tap = r.steps.first { it.target?.role == "button" && it.target.resourceId == null }
        assertEquals(memo.copy(name = "{1}"), tap.target)
        // 模型写的 target 描述不存
        assertFalse("target" in Json.parseToJsonElement(tap.argsJson).jsonObject)
        // 一个字的名字碰巧在原话里:没法可靠绑槽,不记
        val one = Selector("button", "写", null, listOf(0, 0, 1, 1), 0)
        assertNull(RouteRecorder.record(goal, run(target(3, "phone_tap", "{}", one, callId = "w"), result(3, "phone_tap", """{"ok":true,"changed":true}""", callId = "w")), 1, TOOLS))
    }

    @Test fun targetNameContainingSlotValueIsDropped() {
        val sel = Selector("button", "发送今天天气不错", "n:id/x", listOf(0, 0, 1, 1), 0, uniqueAtRecord = true)
        val events = run().toMutableList().apply {
            add(indexOfFirst { it is RunEvent.Verifier }, target(5, "phone_tap", "{}", sel, callId = "x"))
        }
        val t = RouteRecorder.record(goal, events, 1, TOOLS)!!.steps.last().target!!
        assertEquals("", t.name); assertFalse(t.uniqueAtRecord); assertEquals("n:id/x", t.resourceId)
    }

    @Test fun tooManyStepsMeansNoRoute() {
        val many = (1..MAX_ROUTE_STEPS).map { target(3, "phone_back", "{}", callId = "b$it") }.toTypedArray()
        assertNull(RouteRecorder.record(goal, run(*many), 1, TOOLS))
    }

    @Test fun takeoverOrInputOrConfirmationMeansNoRoute() {
        val spoilers = listOf(
            RunEvent.Takeover(3, "login", "skipped", 10, 0),
            RunEvent.State(3, "waiting_input", "哪个?"),
            RunEvent.State(3, "waiting_takeover", "请登录"),
            RunEvent.Confirmation(3, "send", "x", null, null, "declined"),
            RunEvent.Barrier(3, "payment"),
            RunEvent.ToolResult(3, 3, "request_confirmation", """{"ok":false,"error":"payment_requires_takeover"}""", null, null),
            RunEvent.ModelReply(3, 3, "", "web_navigate", "{}", null, null, null),
            target(3, "web_interact", "{}"),
            // 用过沙箱的做法:路线只记屏幕操作
            RunEvent.ToolResult(3, 3, "run_command", """{"ok":true,"exitCode":0}""", null, null),
            RunEvent.ModelReply(3, 3, "", "share_file", "{}", null, null, null),
        )
        assertNotNull(RouteRecorder.record(goal, run(), 1, TOOLS))
        for (e in spoilers) assertNull(e.toString(), RouteRecorder.record(goal, run(e), 1, TOOLS))
    }

    @Test fun passwordInputMeansNoRoute() {
        assertNull(RouteRecorder.record(goal, run(typedResult = """{"ok":true,"typed":6,"secret":true}"""), 1, TOOLS))
        // 端口没说不是密码框:按是处理
        assertNull(RouteRecorder.record(goal, run(typedResult = """{"ok":true,"typed":6}"""), 1, TOOLS))
        assertNull(RouteRecorder.record(goal, run(typed = "***"), 1, TOOLS))
        val shielded = RunEvent.ToolResult(3, 3, "phone_observe", """{"ok":true,"currentApp":"com.notes","protected":true}""", null, null)
        assertNull(RouteRecorder.record(goal, run(shielded), 1, TOOLS))
        assertNull(RouteRecorder.record(goal, run(target(3, "phone_back", "{}", protected = true, callId = "p")), 1, TOOLS))
        // 密码框核对按调用配对:配不上就不记
        val unpaired = run().map { if (it is RunEvent.ActionTarget && it.tool == "phone_type_text") it.copy(callId = "nobody") else it }
        assertNull(RouteRecorder.record(goal, unpaired, 1, TOOLS))
    }

    @Test fun anchorsExcludeNumbersAndTarget() {
        val noisy = Anchors("com.notes", listOf("备忘录", "3条新消息", "新建", "今天天气不错的日子", "一二三四五六七八九十一二三"))
        val events = run().map {
            if (it is RunEvent.ActionTarget && it.tool == "phone_tap") it.copy(before = noisy, after = Anchors("com.notes", listOf("今天天气不错", "新笔记"))) else it
        }
        val tap = RouteRecorder.record(goal, events, 1, TOOLS)!!.steps[1]
        // 数字、目标自己、含输入值的字都不当锚点
        assertEquals(listOf("备忘录"), tap.before.texts)
        assertEquals(listOf("新笔记"), tap.after.texts)
        assertTrue(RouteAnchors.stable("全部笔记"))
        for (s in listOf("12:30", "¥25", "2026-10-23", "", "一二三四五六七八九十一二三")) assertFalse(s, RouteAnchors.stable(s))
    }

    @Test fun failedRoutableActionMeansNoRoute() {
        // 打字没生效(字没进框),后面的成功步骤靠了本该有的变化:回放会缺一步,不记
        assertNull(RouteRecorder.record(goal, run(result(3, "phone_type_text", """{"ok":false,"error":"action_not_applied"}""")), 1, TOOLS))
        // 读屏失败不影响路线
        assertNotNull(RouteRecorder.record(goal, run(RunEvent.ToolResult(2, 2, "phone_observe", """{"ok":false,"error":"timeout"}""", null, null)), 1, TOOLS))
    }

    /** 复合工具内部的滚动失败(source=script)不进 acts,不能把前面的成功步骤一起作废。 */
    @Test fun failedSubActionInsideCompositeDoesNotSpoilRoute() {
        val r = RouteRecorder.record(
            goal,
            run(result(3, "phone_scroll", """{"ok":false,"error":"action_failed"}""", source = "script")),
            1, TOOLS,
        )!!
        assertEquals(listOf("phone_launch_app", "phone_tap", "phone_type_text"), r.steps.map { it.tool })
    }

    /** 查找条件来自原话时绑成槽;界面上的固定标签照原样留。查找本身没找到,整条不记。 */
    @Test fun findConditionBindsOnlyWhenItComesFromTheGoal() {
        fun events(goal: String, text: String, found: Boolean = true) = listOf(
            RunEvent.TaskStarted(0, goal, "m"),
            target(1, "phone_find", """{"text":"$text","direction":"down"}""", callId = "f"),
            result(1, "phone_find", if (found) """{"ok":true,"found":true}""" else """{"ok":false,"found":false}""", callId = "f"),
            RunEvent.TaskEnded(2, "succeeded", "ok"),
        )
        fun condition(r: Route) = Json.parseToJsonElement(r.steps.single().argsJson).jsonObject["text"]!!.jsonPrimitive.content

        assertEquals("{1}", condition(RouteRecorder.record("打开设置里的关于手机", events("打开设置里的关于手机", "关于手机"), 1, TOOLS)!!))
        assertEquals("About phone", condition(RouteRecorder.record("打开设置", events("打开设置", "About phone"), 1, TOOLS)!!))
        assertNull(RouteRecorder.record("打开设置里的关于手机", events("打开设置里的关于手机", "关于手机", found = false), 1, TOOLS))
    }

    @Test fun noEffectiveStepMeansNoRoute() {
        val events = run().map { if (it is RunEvent.ActionTarget) it.copy(effective = false) else it }
        assertNull(RouteRecorder.record(goal, events, 1, TOOLS))
    }

    @Test fun incompleteBatchStepMeansNoRoute() {
        val gap = RunEvent.ActionTarget(3, 3, "phone_scroll", """{"direction":"down"}""", null, Anchors(null, emptyList()), Anchors(null, emptyList()), true, "c3.2",
            source = "batch", incomplete = true)
        assertNull(RouteRecorder.record(goal, run(gap), 1, TOOLS))
        // 批里取到了目标的子步和单步一样记
        val sub = RunEvent.ActionTarget(3, 3, "phone_scroll", """{"direction":"down"}""", null, editor, editor, true, "c3.2", source = "batch")
        assertEquals(listOf("phone_launch_app", "phone_tap", "phone_scroll", "phone_type_text"), RouteRecorder.record(goal, run(sub, result(3, "phone_scroll", """{"ok":true,"changed":true}""", "c3.2")), 1, TOOLS)!!.steps.map { it.tool })
    }

    // 「回到上一级」取决于当时在哪,回放的起点常常不同:同一个回退会退多一级,而它照样返回成功,
    // 后面每一步就都在错的页面上做。实测 files-count 那条路线因此答错了目录(答 11 个文件夹,真实 99 项)。
    @Test fun backIsNotRecordedInRoutes() {
        val back = RunEvent.ActionTarget(2, 2, "phone_back", """{"reason":"返回上一级"}""", null, home, home, true, "c2", source = "model")
        // 带一次回退的整条不记:它挪走过的层级是后面每一步的前提,删掉回退这条路线一样走错
        assertNull(RouteRecorder.record(goal, run(back, result(2, "phone_back", """{"ok":true,"changed":true}""")), 1, TOOLS))
        // 不带回退的照常记
        assertEquals(listOf("phone_launch_app", "phone_tap", "phone_type_text"), RouteRecorder.record(goal, run(), 1, TOOLS)!!.steps.map { it.tool })
    }

    /**
     * 靠 shell 命令得出结论的运行不记路线。设备的实测后果:一条「打开设置 + 6 次系统命令」的运行
     * (结局 succeeded/done)被记成只有 `phone_launch_app` 一步的路线,下次同一句话回放它,
     * 「整条走完」就把工具面收窄到只剩读屏,模型再想用命令也没得用。
     */
    @Test fun runsThatReadTheAnswerFromCommandsAreNotRecorded() {
        for (tool in listOf("phone_system_command", "run_command", "web_run_site_command")) {
            val events = run(RunEvent.ToolResult(3, 3, tool, """{"ok":true,"exitCode":0}""", null, null)) +
                RunEvent.TaskEnded(7, "succeeded", "查到了")
            assertNull("用过 $tool 却记成了路线", RouteRecorder.record(goal, events, 1, TOOLS))
        }
        // 只读屏、不跑命令的照常记
        assertNotNull(RouteRecorder.record(goal, run(), 1, TOOLS))
    }

    /** 打开 App 不点控件,天然没有目标元素:标了 incomplete 也照记,回放按「打开成功即到了」核对。 */
    @Test fun incompleteLaunchStepStillMakesRoute() {
        val launchGap = RunEvent.ActionTarget(1, 1, "phone_launch_app", """{"package":"com.notes"}""", null,
            Anchors(null, emptyList()), Anchors(null, emptyList()), true, "c1", incomplete = true)
        // 原运行里第 1 步换成 incomplete 的启动步
        val swapped = run().map { if (it is RunEvent.ActionTarget && it.step == 1) launchGap else it }
        val route = RouteRecorder.record(goal, swapped, 1, TOOLS)!!
        assertEquals(listOf("phone_launch_app", "phone_tap", "phone_type_text"), route.steps.map { it.tool })
        assertNull(route.steps[0].target)
        assertEquals("com.notes", Json.parseToJsonElement(route.steps[0].argsJson).jsonObject["package"]!!.jsonPrimitive.content)
        assertTrue(route.packages.contains("com.notes"))
        // 非启动步缺目标仍然整条不记
        val tapGap = RunEvent.ActionTarget(3, 3, "phone_tap", """{"ref":"@e2","snapshotId":"s1"}""", null,
            Anchors(null, emptyList()), Anchors(null, emptyList()), true, "c3", incomplete = true)
        assertNull(RouteRecorder.record(goal, run().map { if (it is RunEvent.ActionTarget && it.step == 3) tapGap else it }, 1, TOOLS))
    }
}
