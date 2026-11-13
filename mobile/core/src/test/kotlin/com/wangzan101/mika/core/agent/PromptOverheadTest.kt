package com.wangzan101.mika.core.agent

import com.wangzan101.mika.core.model.ToolSpec
import com.wangzan101.mika.core.tool.FakeScreen
import com.wangzan101.mika.core.assembly.toolDispatcher
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 提示词的固定开销(系统提示词 + 工具定义)是每步都要重发的,本地小模型对它的长度很敏感:
 * 32k 输入要几十秒,45k 要一分多钟,再长就等于是挂了。这里把这个开销钉住,免得改着改着又长回去。
 * 数字来自 core/src/test/resources/prompt-surface/layers,口径见 TokenEstimate。
 */
class PromptOverheadTest {
    private fun tokens(s: String) = TokenEstimate.of(s)

    private fun specsCost(tools: List<ToolSpec>): Int =
        tokens(SystemPrompt.identity()) + tools.sumOf { tokens(it.name + it.description + it.parametersJsonSchema) }

    @Test fun phoneTaskOverheadStaysWithinLocalModelBudget() {
        val d = toolDispatcher(FakeScreen())
        val all = specsCost(d.offeredNow(all = true))
        // 手机一组全展开时的固定开销。本地 4B 在 45k 输入上要一分多钟,这里留出读屏与历史的余地。
        assertTrue("phone 全展开的固定开销 ${all} token 太大", all <= 23_000)
    }

    @Test fun foldedPhoneGroupCostsFarLessThanOpened() {
        val d = toolDispatcher(FakeScreen())
        val folded = specsCost(d.offeredNow())
        val opened = specsCost(d.offeredNow(all = true))
        // 收着只有入口工具:至少省下一半,折叠才有意义
        assertTrue("收着 $folded vs 展开 $opened:折叠没省下多少", folded * 2 <= opened)
    }
}
