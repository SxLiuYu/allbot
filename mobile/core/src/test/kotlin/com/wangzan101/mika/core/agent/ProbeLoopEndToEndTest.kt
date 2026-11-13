package com.wangzan101.mika.core.agent

import com.wangzan101.mika.core.model.Capabilities
import com.wangzan101.mika.core.model.ChatModel
import com.wangzan101.mika.core.model.Message
import com.wangzan101.mika.core.model.ModelReply
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.StopReason
import com.wangzan101.mika.core.model.ToolSpec
import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.record.RunSink
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.SystemCommandResult
import com.wangzan101.mika.core.uistate.UiElement
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.testing.answerReply

/**
 * 「同一个只读工具换着法子问同一件事」这条规则,端到端验一遍:不只看 [StallDetector] 的返回值,
 * 还要看模型在停下之前收到了什么、任务最后的结局是什么。
 *
 * 场景照抄真机上那条:录音机任务连发 11 次 shell 查「现在是不是在录音」,每次换一个 grep,
 * 每次都成功,每屏内容都一样。前几条现有规则一条都拦不住。
 */
class ProbeLoopEndToEndTest {

    /** 只有 shell:读屏永远同一屏,命令永远成功,输出永远一样。 */
    private class ShellOnlyScreen : ScreenPort {
        private val el = UiElement("@e1", "button", "录音", 540, 120, listOf(0, 0, 999, 100), "a:id/rec", true, false, false)
        var commands = mutableListOf<String>()
        override suspend fun snapshot() = ScreenSnapshot("snap", "com.recorder", listOf(el), 1080, 2400)
        override suspend fun peek() = snapshot()
        override suspend fun screenshotPng(): ByteArray? = null
        override suspend fun tapRef(ref: String, snapshotId: String): ActionResult = ActionResult.Ok()
        override suspend fun tapXY(x: Int, y: Int): ActionResult = ActionResult.Ok()
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String): ActionResult = ActionResult.Ok()
        override suspend fun clearText(ref: String?, snapshotId: String?): ActionResult = ActionResult.Ok()
        override suspend fun scroll(ref: String?, snapshotId: String?, down: Boolean): ActionResult = ActionResult.Ok()
        override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): ActionResult = ActionResult.Ok()
        override suspend fun back(): ActionResult = ActionResult.Ok()
        override suspend fun pressKey(keyCode: Int): ActionResult = ActionResult.Ok()
        override suspend fun openApp(packageName: String, cold: Boolean): ActionResult = ActionResult.Ok()
        override suspend fun waitStable(timeoutMs: Long) = true
        override suspend fun listApps() = listOf("com.recorder" to "录音机")
        override suspend fun systemCommand(command: String): SystemCommandResult? {
            commands += command
            return SystemCommandResult(0, "1")
        }
    }

    private class Script(private val replies: MutableList<ModelReply>) {
        val requests = mutableListOf<List<Message>>()
        fun model(): ChatModel = object : ChatModel {
            override val capabilities = Capabilities(
                toolCalls = true, vision = false, contextTokens = 128_000, reasoning = false, groundingVerified = true)
            override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply {
                requests += messages
                return if (replies.size == 1) replies[0] else replies.removeAt(0)
            }
        }
    }

    private var seq = 0

    /** [n] 次各不相同的查法,全部都成功。 */
    private fun probeScript(n: Int): MutableList<ModelReply> {
        val out = mutableListOf<ModelReply>()
        for (i in 1..n) {
            val c = Part.ToolCall("probe${++seq}", "phone_system_command", """{"command":"dumpsys audio | grep -c recording$i"}""")
            out += ModelReply(listOf(c), StopReason.ToolUse, null)
        }
        return out
    }

    private class Recorder : RunSink {
        val events = mutableListOf<RunEvent>()
        override fun event(e: RunEvent) { events += e }
        val states get() = events.filterIsInstance<RunEvent.State>()
        val stalls get() = states.filter { it.name == "stall_detected" }
        val stops get() = states.filter { it.name == "stall_stopped" }
    }

    @Test
    fun theModelIsToldToStopChangingAngleBeforeTheRunEnds() {
        val script = probeScript(12).also { it += answerReply("正在录音") }
        val s = Script(script)
        val sink = Recorder()
        runBlocking {
            AgentLoop(s.model(), toolDispatcher(ShellOnlyScreen()), "B", sink = sink).run("现在是不是在录音")
        }
        val nudges = sink.stalls.map { it.detail }
        assertTrue("没有发出任何 stall_detected", nudges.isNotEmpty())
        // 提醒得说清「同一个工具换了 N 种查法」,模型才知道该直接作答而不是再换一个 grep
        assertTrue("提醒没说到点子上: $nudges", nudges.any { "换" in it && ("查" in it || "同一件事" in it) })
    }

    @Test
    fun stoppingNamesProbeLoopNotAGenericStall() {
        val script = probeScript(20).also { it += answerReply("没查出来") }
        val s = Script(script)
        val sink = Recorder()
        var last: TaskState = TaskState.Running(0, "")
        runBlocking {
            last = AgentLoop(s.model(), toolDispatcher(ShellOnlyScreen()), "B", sink = sink).run("现在是不是在录音")
        }
        val stop = sink.stops.lastOrNull()
        assertTrue("一直到最后都没有 probe_loop 收尾,结局是 $last", stop != null)
        assertEquals("stop 的原因写错了", "probe_loop", stop!!.detail)
    }

    @Test
    fun aFailedProbeIsNotCountedAsAProbe() {
        // 报错的归「同一条错误」管,不能又算一次「换着法子问」
        val script = probeScript(5).also { it += answerReply("问不出来,命令都失败了") }
        val s = Script(script)
        val sink = Recorder()
        runBlocking {
            AgentLoop(s.model(), toolDispatcher(ShellOnlyScreen()), "B", sink = sink).run("现在是不是在录音")
        }
        assertTrue("成功的几条不该在第 6 步之前就说 probe_loop", sink.stops.none { it.detail == "probe_loop" })
    }

    /**
     * 用户看到的收尾那句话要说出是哪条规则。几种不同的问题不能共用一句「任务长时间没有进展」,
     * 否则用户分不清到底哪里卡了。
     */
    @Test
    fun theClosingMessageNamesProbeLoopNotAGenericStall() {
        val script = probeScript(20).also { it += answerReply("没查出来") }
        val sink = Recorder()
        var last: TaskState = TaskState.Running(0, "")
        runBlocking {
            last = AgentLoop(Script(script).model(), toolDispatcher(ShellOnlyScreen()), "B", sink = sink).run("现在是不是在录音")
        }
        val message = (last as? TaskState.Failed)?.reason ?: error("没有以失败收尾,而是 $last")
        assertTrue("收尾说明是通用的「任务长时间没有进展」,没说出真实原因:$message", "长时间没有进展" !in message)
    }
}
