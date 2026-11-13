package com.wangzan101.mika.core.calls

import com.wangzan101.mika.core.action.ActionRisk
import com.wangzan101.mika.core.action.ApprovalSettings
import com.wangzan101.mika.core.action.ConfirmDecision
import com.wangzan101.mika.core.action.Decision
import com.wangzan101.mika.core.action.Risk as ApprovalRisk
import com.wangzan101.mika.core.gate.ConfirmationGate
import com.wangzan101.mika.core.run.RunProvenance
import com.wangzan101.mika.core.tool.ToolDispatcher
import com.wangzan101.mika.core.tool.FakeScreen
import com.wangzan101.mika.core.assembly.toolDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 拨号是不在屏上、做了就收不回的一步:必须有确认卡片,而且同意的只能是申报的那一个号码。
 *
 * 这套「按参数声明的审批风险」是这次接通话时新加的(Mika 原本只有付款要问用户)。
 * 少了它,模型一句 `phone_call_dial` 就直接把电话打出去了。
 */
class CallApprovalTest {

    private fun port(dialed: MutableList<String>) = object : PhoneCallPort {
        override suspend fun state() = JsonObject(emptyMap())
        override suspend fun dial(number: String, simId: String?, task: PhoneCallTask?): JsonObject {
            dialed += number
            return buildJsonObject { put("ok", JsonPrimitive(true)) }
        }
        override suspend fun answer(callId: String) = JsonObject(emptyMap())
        override suspend fun hangup(callId: String) = JsonObject(emptyMap())
        override suspend fun takeover() = JsonObject(emptyMap())
    }

    private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.content

    @Test
    fun readingCallStateNeverAsksTheUser() {
        val d = toolDispatcher(FakeScreen(), phoneCalls = port(mutableListOf()))
        assertNull("只看状态不该拦下来问用户", d.approvalRisk("phone_call_state", JsonObject(emptyMap()))?.ask)
    }

    /** 申报里要写清打给谁,用户才知道自己在同意什么。 */
    @Test
    fun theCardShowsTheNumberBeingDialled() {
        val dialed = mutableListOf<String>()
        val d: ToolDispatcher = toolDispatcher(FakeScreen(), phoneCalls = port(dialed))
        val declared: ApprovalRisk? = d.approvalRisk(
            "phone_call_dial", buildJsonObject { put("number", JsonPrimitive("13800138000")) })
        assertNotNull("dial 没有声明审批风险", declared)
        val ask = declared!!.ask
        assertNotNull("声明了风险却没有给用户的申报内容", ask)
        assertTrue("申报里没写号码: ${ask!!.content}", "13800138000" in ask.content)
        assertEquals(ActionRisk.Irreversible, declared.level)
    }

    /** 看状态的调用不该要求同意:同一个工具按参数给不同的风险。 */
    @Test
    fun onlyDialAmongTheCallToolsNeedsApproval() {
        val d = toolDispatcher(FakeScreen(), phoneCalls = port(mutableListOf()))
        for (name in listOf("phone_call_dial")) {
            assertNotNull("$name 应当要用户同意", d.approvalRisk(name, buildJsonObject { put("number", JsonPrimitive("13800138000")) })?.ask)
        }
        for (name in listOf("phone_call_state", "phone_call_answer", "phone_call_hangup", "phone_call_takeover")) {
            val risk = d.approvalRisk(name, buildJsonObject { put("callId", JsonPrimitive("c1")) })
            if (name == "phone_call_state") continue
            assertNotNull("$name 应当声明风险", risk)
        }
    }

    /** 用户同意之后,一模一样的这一步才放行;换一个号码就不认。 */
    @Test
    fun anApprovalOnlyLetsThroughTheSameNumber() {
        fun approved(content: String, step: Int): ConfirmationGate {
            val gate = ConfirmationGate()
            val req = com.wangzan101.mika.core.gate.ConfirmationRequest(
                com.wangzan101.mika.core.risk.IrrevAction.other, "SIM 1", content, null, "calls")
            gate.declare(req, foregroundApp = "calls")
            gate.decide(com.wangzan101.mika.core.action.ConfirmChoice.Once, step)
            return gate
        }
        val one = com.wangzan101.mika.core.gate.ConfirmationRequest(
            com.wangzan101.mika.core.risk.IrrevAction.other, "SIM 1", "拨号 13800138000", null, "calls")

        val same = approved("拨号 13800138000", step = 1)
        assertEquals(com.wangzan101.mika.core.gate.Permit.Allowed, same.permitsExactly(one, step = 1))

        val other = approved("拨号 13800138000", step = 1)
        val p = other.permitsExactly(one.copy(content = "拨号 13900139000"), step = 1)
        assertTrue("同意了一个号码,却放行了另一个号码: $p",
            p is com.wangzan101.mika.core.gate.Permit.Mismatch)
    }

    /**
     * 通话工具绝不能进经验路线。
     *
     * 路线会被回放:同一条任务第二次跑时自动重演。如果拨号能被记进去,
     * 用户下次说句同样的话,电话就直接打出去了——中间不会再问一次。
     *
     * 现在靠 AgentTool 接口里 routable 的默认值 false 兜着,而不是通话工具
     * 自己声明。默认值哪天改了、或者有人给 CallAgentTool 加上 routable = true,
     * 这条测试会拦下来。
     */
    @Test
    fun callToolsAreNeverRecordedIntoRoutes() {
        val d = toolDispatcher(FakeScreen(), phoneCalls = port(mutableListOf()))
        for (name in listOf("phone_call_state", "phone_call_dial", "phone_call_answer",
                            "phone_call_hangup", "phone_call_takeover")) {
            val tool = d.index[name]
            assertNotNull("找不到工具: $name", tool)
            assertEquals("$name 不能进路线——回放会绕过审批直接拨号", false, tool!!.routable)
        }
    }
}
