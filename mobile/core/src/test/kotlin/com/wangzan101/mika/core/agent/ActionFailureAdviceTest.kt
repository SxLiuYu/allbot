package com.wangzan101.mika.core.agent

import com.wangzan101.mika.core.model.Capabilities
import com.wangzan101.mika.core.model.ChatModel
import com.wangzan101.mika.core.model.Message
import com.wangzan101.mika.core.model.ModelReply
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.StopReason
import com.wangzan101.mika.core.model.ToolSpec
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.UiElement
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wangzan101.mika.core.assembly.toolDispatcher
import com.wangzan101.mika.core.testing.answerReply

/**
 * 动作失败之后,模型到底看没看到「该怎么补救」。判据在 [com.wangzan101.mika.core.tool.ToolErrorPolicy]
 * (纯函数,另有单测),这里验的是它有没有真的进到模型的上下文里。
 *
 * 原来失败只回 `The action failed: action_failed`,模型只能自己猜;现在第二次同样的错要说清换什么。
 */
class ActionFailureAdviceTest {

    /** 返回键不生效:连着两次 action_failed。 */
    private class DeadBackButton : ScreenPort {
        private val el = UiElement("@e1", "button", "好", 540, 120, listOf(0, 0, 999, 100), "a:id/ok", true, false, false)
        var backs = 0
        override suspend fun snapshot() = ScreenSnapshot("snap", "com.x", listOf(el), 1080, 2400)
        override suspend fun peek() = snapshot()
        override suspend fun screenshotPng(): ByteArray? = null
        override suspend fun tapRef(ref: String, snapshotId: String) = ActionResult.Ok()
        override suspend fun tapXY(x: Int, y: Int) = ActionResult.Ok()
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String) = ActionResult.Ok()
        override suspend fun clearText(ref: String?, snapshotId: String?) = ActionResult.Ok()
        override suspend fun scroll(ref: String?, snapshotId: String?, down: Boolean) = ActionResult.Ok()
        override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) = ActionResult.Ok()
        override suspend fun back(): ActionResult { backs++; return ActionResult.Failed("action_failed") }
        override suspend fun pressKey(keyCode: Int) = ActionResult.Ok()
        override suspend fun openApp(packageName: String, cold: Boolean) = ActionResult.Ok()
        override suspend fun waitStable(timeoutMs: Long) = true
        override suspend fun listApps() = listOf("com.x" to "X")
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
    private fun back() = ModelReply(listOf(Part.ToolCall("b${++seq}", "phone_back", "{}")), StopReason.ToolUse, null)

    /** 模型在第二次返回失败之后、下一步之前能看到的所有文字。 */
    private fun textSeenBeforeStep(model: Script, step: Int): String =
        model.requests[step].map { m -> m.parts.filterIsInstance<Part.Text>().joinToString(" ") { it.text } }.joinToString("\n")

    @Test
    fun theSecondDeadBackTellsTheModelToUseTheSystemKey() {
        val s = Script(mutableListOf(back(), back(), answerReply("退不出去")))
        runBlocking {
            AgentLoop(s.model(), toolDispatcher(DeadBackButton()), "B").run("退回到上一页")
        }
        // requests[2] 是第三步之前模型看到的内容:第二次返回已经把提示放进去了
        val seen = textSeenBeforeStep(s, 2)
        assertTrue("没告诉模型换什么做法,它看到的只是原始错误:\n$seen", "phone_system_command" in seen)
    }

    @Test
    fun theFirstFailureDoesNotRepeatItselfIntoTheContext() {
        // 第一次错先让模型自己看结果,不要一上来就补一段话;第二次同样的错才提醒
        val s = Script(mutableListOf(back(), answerReply("退不出去")))
        runBlocking {
            AgentLoop(s.model(), toolDispatcher(DeadBackButton()), "B").run("退回到上一页")
        }
        val seen = textSeenBeforeStep(s, 1)
        assertTrue("第一次失败就给补救提示,模型还没机会自己反应:\n$seen", "phone_system_command" !in seen)
    }
}
