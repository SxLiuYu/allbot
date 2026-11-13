package com.wangzan101.mika.core.agent

import com.wangzan101.mika.core.model.ChatModel
import com.wangzan101.mika.core.model.Message
import com.wangzan101.mika.core.model.ModelReply
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.Role
import com.wangzan101.mika.core.model.StopReason
import com.wangzan101.mika.core.model.ToolSpec
import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.replay.Anchors
import com.wangzan101.mika.core.replay.Events
import com.wangzan101.mika.core.replay.MemRoutes
import com.wangzan101.mika.core.replay.Notes
import com.wangzan101.mika.core.replay.PagedScreen
import com.wangzan101.mika.core.replay.RouteMatcher
import com.wangzan101.mika.core.replay.RouteStep
import com.wangzan101.mika.core.replay.ui
import com.wangzan101.mika.core.verify.Verifier
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wangzan101.mika.core.assembly.toolDispatcher

class AgentLoopReplayTest {
    private var seq = 0
    private fun call(name: String, args: String = "{}") = ModelReply(listOf(Part.ToolCall("m${++seq}", name, args)), StopReason.ToolUse, null)
    private fun text(s: String) = ModelReply(listOf(Part.Text(s)), StopReason.EndTurn, null)
    private val finish = text("写好了,屏上有新笔记")
    private val pick = """{"route": 1, "slots": ["今天天气不错"]}"""
    private val pass = """{"checks": [{"criterion": "t", "status": "met", "quote": "新笔记"}], "verdict": "pass", "reason": "屏上有"}"""
    private val goal = "在备忘录里写今天天气不错"

    private class Run(val sink: Events, val main: FakeModel, val store: MemRoutes, val screen: PagedScreen)

    private fun run(
        screen: PagedScreen = Notes.screen(), store: MemRoutes = MemRoutes(Notes.route()), main: FakeModel = FakeModel(finish),
        matcher: ChatModel = FakeModel(text(pick)), flags: SpeedFlags = SpeedFlags(replay = true), verifier: Verifier? = null,
        task: String = goal,
        /** 交出回答后判的结局(产品里在结果交给用户之后才判);路线只在办成时记成功。 */
        outcome: RunOutcome = RunOutcome.Done,
    ): Run {
        val sink = Events()
        runBlocking {
            val agent = AgentLoop(main, toolDispatcher(screen), "BASE", sink = sink, flags = flags, verifier = verifier,
                routes = RouteMatcher(matcher, store, null))
            agent.run(task)
            agent.noteOutcome(outcome)
        }
        return Run(sink, main, store, screen)
    }

    /** 交还时补进对话的全部文字:说明、以及读屏那对调用的结果。 */
    private fun firstPrompt(r: Run) = r.main.requests.first().drop(1).flatMap { it.parts }.joinToString("") {
        when (it) {
            is Part.Text -> it.text
            is Part.ToolResult -> it.content
            else -> ""
        }
    }

    @Test fun goalsThatNameTheWebAreNotReplayed() {
        val matcher = FakeModel(text(pick))
        val r = run(matcher = matcher, task = "用网页$goal")
        assertTrue(r.sink.all.filterIsInstance<RunEvent.Replay>().isEmpty())
        assertTrue(matcher.requests.isEmpty())
    }

    @Test fun divergedHandsBackWithSummaryAndFullScreen() {
        val s = Notes.screen()
        s.pages["home"] = listOf(ui("@e4", "text", "请先登录", listOf(0, 0, 999, 60), clickable = false))
        val r = run(screen = s)
        val msg = firstPrompt(r)
        assertTrue(msg, msg.contains("1 of 3 steps were run automatically, following a way that worked before"))
        assertTrue(msg, msg.contains("1. phone_launch_app com.notes"))
        assertTrue(msg, msg.contains("Step 2 expected"))
        assertTrue(msg, msg.contains("请先登录"))
        // 带着一份全量读屏(编号与 snapshotId),模型可直接接着做
        assertTrue(msg, msg.contains("\"snapshotId\"") && msg.contains("\"ref\":\"@e4\""))
        // 读屏是一对调用与结果(助手的调用在前,结果紧跟),各家接口的配对要求都满足
        val h = r.main.requests.first().withoutRuntime()
        val callAt = h.indexOfFirst { m -> m.role == Role.Assistant && m.parts.any { it is Part.ToolCall && it.id == "replay_handback" && it.name == "phone_list_elements" } }
        assertTrue(callAt > 0)
        assertEquals("replay_handback", (h[callAt + 1].parts.single() as Part.ToolResult).callId)
        assertEquals(callAt + 2, h.size)
        assertEquals(listOf(true, false), r.sink.all.filterIsInstance<RunEvent.Replay>().map { it.matched })
        assertEquals(1, r.store.m["r1"]!!.consecutiveMisses)
        assertFalse(r.store.m["r1"]!!.disabled)
    }

    @Test fun executedButUnchangedStepToldToModel() {
        val s = Notes.screen().apply { links.clear() }
        val msg = firstPrompt(run(screen = s))
        assertTrue(msg, msg.contains("Step 2 was run, but the expected change did not show"))
    }

    @Test fun unreadableHandbackScreenStillContinues() {
        val s = Notes.screen().apply { failReads = true }
        val r = run(screen = s)
        val msg = firstPrompt(r)
        assertTrue(msg, msg.contains("The current screen could not be read"))
        assertEquals("succeeded", r.sink.all.filterIsInstance<RunEvent.TaskEnded>().single().outcome)
    }

    /** 冷启动:回放走完时窗口树还没填充,交还前等到了元素就补一份可读的全量读屏。 */
    @Test fun completedWaitsForReadableHandbackScreen() {
        val s = Notes.screen().apply { emptyHandbackReads = 1 }
        val msg = firstPrompt(run(screen = s))
        assertTrue(msg, msg.contains("\"snapshotId\""))
        assertTrue(msg, msg.contains("备忘录") || msg.contains("新笔记"))
        assertFalse(msg, msg.contains("The current screen could not be read"))
    }

    @Test fun completedHandsBackWithOnlyReadingTools() {
        // 整条路线走完:手机已到目标,交还那一轮不该再给改变界面的动作
        val ok = run(main = FakeModel(text("写好了,在「新笔记」里")))
        val offered = ok.main.offeredTools.first()
        // 读屏、问用户、放弃还在
        assertTrue(offered.contains("phone_observe"))
        assertTrue(offered.contains("ask_user"))
        assertTrue(offered.contains("end_not_done"))
        // 改变界面的动作都不在
        for (t in listOf("phone_tap", "phone_type_text", "phone_launch_app", "phone_scroll", "do_steps", "phone_run")) {
            assertFalse("$t 不该在收窄后的工具里", offered.contains(t))
        }
        // 工具面确实小了一个量级
        assertTrue("剩余工具应有 15 个以内,实际 ${offered.size}", offered.size <= 15)
    }

    /**
     * 整条路线只有「打开 App」这一步时,不算整条走完,工具面不能收窄。
     * 设备上真出现过这种路线(模板是整句原话,成功次数 0):回放完就把动作工具收掉,
     * 模型于是反复说「没有 phone_system_command 这个工具」,任务一次次失败。
     */
    @Test fun aRouteThatOnlyOpensAnAppDoesNotNarrowTheTools() {
        fun onlyOpens() = MemRoutes(
            Notes.route(listOf(RouteStep("phone_launch_app", """{"package":"com.notes"}""", null,
                Anchors(null, emptyList()), Notes.homeA))))
        val r = run(store = onlyOpens())
        val offered = r.main.offeredTools.first()
        assertTrue("只打开了 App 就把动作工具收掉了", offered.contains("phone_tap"))
        assertTrue(offered.contains("phone_type_text"))
        // 也没有说是「整条路线走完了」:这件事一步都没做完
        assertFalse(firstPrompt(r).contains("All steps of the earlier way of doing this were run"))
        // 但要说清现在在哪、剩下的怎么办
        assertTrue(firstPrompt(r).contains("only opened the app"))

        // 用户要的事没做到(判成 partial):这种路线照样记失误、照样能停用
        val miss = onlyOpens()
        run(store = miss, outcome = RunOutcome.Partial)
        assertEquals(1, miss.m["r1"]!!.consecutiveMisses)
        // 用户就只是要打开 App(判成 done):记成功,别冤枉它
        val ok = onlyOpens()
        run(store = ok)
        assertEquals(1, ok.m["r1"]!!.successes)
        assertEquals(0, ok.m["r1"]!!.consecutiveMisses)
    }

    @Test fun divergedKeepsFullToolset() {
        // 中途对不上:模型要接着做,工具面不能收窄
        val s = Notes.screen()
        s.pages["home"] = listOf(ui("@e4", "text", "请先登录", listOf(0, 0, 999, 60), clickable = false))
        val r = run(screen = s)
        val offered = r.main.offeredTools.first()
        assertTrue(offered.contains("phone_tap"))
        assertTrue(offered.contains("phone_type_text"))
    }

    @Test fun completedStillRequiresAnAnswer() {
        // 走完了也要模型自己回答;回答核实过才算路线的一次成功:这个回答引用的「新笔记」读到过(字面核对对上了,不用另请核查)
        val ok = run(main = FakeModel(text("写好了,在「新笔记」里")), verifier = Verifier(FakeModel(text(pass)), null))
        assertTrue(firstPrompt(ok).contains("All steps of the earlier way of doing this were run"))
        assertEquals(1, ok.main.requests.size)
        assertTrue(ok.sink.all.none { it is RunEvent.Verifier })
        assertEquals(1, ok.store.m["r1"]!!.successes)

        val gaveUp = run(main = FakeModel(call("end_not_done", """{"message":"没写上"}""")), verifier = Verifier(FakeModel(text(pass)), null))
        assertTrue(gaveUp.sink.all.none { it is RunEvent.Verifier })
        assertEquals(0, gaveUp.store.m["r1"]!!.successes)

        // 回答里没有可核对的值、也没请核查:判下来办成就记成功(学习看结局,不看核查)
        assertEquals(1, run().store.m["r1"]!!.successes)
        // 核对过却没对上(退回一次后仍标成未确认):不记成功
        val doubtful = run(main = FakeModel(text("写好了,在「旧草稿 42 号」里"), text("写好了,在「旧草稿 42 号」里")))
        assertEquals(0, doubtful.store.m["r1"]!!.successes)
    }

    @Test fun routeSuccessOnlyWhenJudgedDone() {
        // 回答核实过,但判下来只办了一部分、没办成或没判成:都不记成功
        for (o in listOf(RunOutcome.Partial, RunOutcome.NotPossible, RunOutcome.Unknown)) {
            val r = run(main = FakeModel(text("写好了,在「新笔记」里")), verifier = Verifier(FakeModel(text(pass)), null), outcome = o)
            assertEquals(o.wire, 0, r.store.m["r1"]!!.successes)
        }
    }

    /**
     * 走完了却没办成:这条路线没覆盖用户的请求,要算失误,连着两次就停用。
     * 原来这种情况既不记成功也不记失误,路线永远淘汰不掉——设备上真出现过一条只有「打开设置」一步的路线,
     * 每次回放都「整条走完」,然后收窄工具、答不出要的东西。
     */
    @Test fun completedButNotDoneCountsAsAMissAndDisablesTheRoute() {
        val store = MemRoutes(Notes.route())
        run(store = store, main = FakeModel(text("写好了,在「新笔记」里")), outcome = RunOutcome.Partial)
        assertEquals(1, store.m["r1"]!!.consecutiveMisses)
        assertEquals(3, store.m["r1"]!!.missStep!!)
        assertFalse(store.m["r1"]!!.disabled)
        run(store = store, main = FakeModel(text("写好了,在「新笔记」里")), outcome = RunOutcome.Partial)
        assertTrue("走完两次都没办成,路线该停用了", store.m["r1"]!!.disabled)
        // 停用之后不再是候选:匹配模型不会被调用
        val m = FakeModel()
        run(store = store, matcher = m)
        assertTrue(m.requests.isEmpty())

        // 判成「没判出来」(模型出错、超时)不算路线的错,不扣分
        val unknown = MemRoutes(Notes.route())
        run(store = unknown, outcome = RunOutcome.Unknown)
        assertEquals(0, unknown.m["r1"]!!.consecutiveMisses)
        assertFalse(unknown.m["r1"]!!.disabled)
        // 办成了就把失误清掉
        run(store = store.also { it.m["r1"] = it.m["r1"]!!.copy(disabled = false, consecutiveMisses = 1, missStep = 3) })
        assertEquals(0, store.m["r1"]!!.consecutiveMisses)
        assertEquals(1, store.m["r1"]!!.successes)
    }

    @Test fun twoMissesAtSameStepDisableRoute() {
        val store = MemRoutes(Notes.route())
        fun broken() = Notes.screen().apply { pages["home"] = listOf(ui("@e4", "text", "请先登录", listOf(0, 0, 999, 60), clickable = false)) }
        run(screen = broken(), store = store)
        assertFalse(store.m["r1"]!!.disabled)
        run(screen = broken(), store = store)
        assertTrue(store.m["r1"]!!.disabled)
        // 停用之后不再是候选:匹配模型不会被调用
        val m = FakeModel()
        run(store = store, matcher = m)
        assertTrue(m.requests.isEmpty())
    }

    // 这一屏没读可靠(页面还在动/窗口读不到)不是路线的错:不扣分,也不能因为连续几次读不稳就被停用
    @Test fun unreliableScreenDoesNotCountAsMiss() {
        val store = MemRoutes(Notes.route())
        fun shaky() = Notes.screen().apply { alwaysUnstable = true }
        val r = run(screen = shaky(), store = store)
        assertEquals(0, store.m["r1"]!!.consecutiveMisses)
        assertFalse(store.m["r1"]!!.disabled)
        assertTrue(r.screen.taps.isEmpty())
        // 连着再来几次仍然不动计数
        repeat(3) { run(screen = shaky(), store = store) }
        assertEquals(0, store.m["r1"]!!.consecutiveMisses)
        assertFalse("读不稳不该把一条好路线停掉", store.m["r1"]!!.disabled)
    }

    @Test fun unreliableHandbackSaysItIsNotTheRoutesFault() {
        val r = run(screen = Notes.screen().apply { alwaysUnstable = true })
        val msg = firstPrompt(r)
        assertTrue(msg, msg.contains("could not be read reliably"))
        assertTrue(msg, msg.contains("This is not a sign that the way no longer works"))
        // 不能说成「第 N 步期望…实际读到…」:那会让模型以为页面对不上
        assertFalse(msg, msg.contains("Step 1 expected"))
    }

    @Test fun replayOffNoMatcherCall() {
        val m = FakeModel()
        val r = run(matcher = m, flags = SpeedFlags.OFF)
        assertTrue(m.requests.isEmpty())
        assertTrue(r.sink.all.none { it is RunEvent.Replay })
        assertTrue(r.screen.typed.isEmpty())
    }

    @Test fun noModelCallsDuringReplay() {
        val s = Notes.screen()
        var typedWhenFirstAsked: List<String>? = null
        // 主模型一被调用就记下当时端口收到的输入:回放全程不碰主模型
        val main = object : ChatModel by FakeModel() {
            override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply {
                if (typedWhenFirstAsked == null) typedWhenFirstAsked = s.typed.toList()
                return finish
            }
        }
        val sink = Events()
        val matcher = FakeModel(text(pick))
        runBlocking {
            AgentLoop(main, toolDispatcher(s), "BASE", sink = sink, flags = SpeedFlags(replay = true),
                routes = RouteMatcher(matcher, MemRoutes(Notes.route()), null)).run(goal)
        }
        assertEquals(listOf("今天天气不错"), typedWhenFirstAsked)
        assertEquals(1, matcher.requests.size)
        val firstReply = sink.all.indexOfFirst { it is RunEvent.ModelReply }
        assertTrue(sink.all.withIndex().filter { it.value is RunEvent.Replay }.all { it.index < firstReply })
    }
}
