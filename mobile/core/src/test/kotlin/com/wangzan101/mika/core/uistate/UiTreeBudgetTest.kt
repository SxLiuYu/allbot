package com.wangzan101.mika.core.uistate

import com.wangzan101.mika.core.agent.TokenEstimate
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 拿模拟器上真实那一屏(设置首页:68 个节点、38 个空壳)复算裁掉多少。
 * 数来自 2026-11-02 那次运行的 events.jsonl:tree 8309 字节、elements 4175 字节,整条结果 11584 字节。
 */
class UiTreeBudgetTest {
    /** 按真实那屏的形状造:1 个 ScrollView + 一堆 Layout 套 Layout + 30 个有 ref 的元素。 */
    private fun settingsLike(): ScreenSnapshot {
        fun leaf(i: Int) = UiTreeNode("TextView", listOf(0, i * 10, 999, i * 10 + 10), ref = "@e$i", text = "分类 $i")
        var inner: List<UiTreeNode> = (1..30).map(::leaf)
        // 23 LinearLayout + 8 RelativeLayout + 4 FrameLayout 那种层层嵌套
        repeat(20) { inner = listOf(UiTreeNode("LinearLayout", listOf(0, 0, 999, 999), children = inner)) }
        repeat(8) { inner = listOf(UiTreeNode("RelativeLayout", listOf(0, 0, 999, 999), children = inner)) }
        repeat(4) { inner = listOf(UiTreeNode("FrameLayout", listOf(0, 0, 999, 999), children = inner)) }
        val root = UiTreeNode("ScrollView", listOf(0, 0, 999, 999), scrollable = true, children = inner)
        val window = UiWindowTree(1, "application", 0, "设置", "com.android.settings", true, true, listOf(root))
        return ScreenSnapshot("p", "com.android.settings", emptyList(), 1080, 2400, windows = listOf(window))
    }

    private fun count(nodes: JsonArray): Int = nodes.sumOf { e ->
        val o = e as JsonObject
        1 + (((o["children"] ?: o["nodes"]) as? JsonArray)?.let(::count) ?: 0)
    }

    @Test fun realWorldScreenShrinksSubstantially() {
        val s = settingsLike()
        // 改造前的样子:每个节点原样写出(旧实现就是全量)
        val before = JsonArray(s.windows.map { w ->
            JsonObject(mapOf("id" to JsonPrimitive(w.id), "nodes" to JsonArray(w.nodes.map(::legacy))))
        }).toString()
        val after = UiTreeJson.windows(s).toString()
        println("tree before=${before.length} after=${after.length} ratio=${"%.2f".format(after.length.toDouble() / before.length)}")
        println("tokens before=${TokenEstimate.of(before)} after=${TokenEstimate.of(after)}")
        // 这一屏里 30 个叶子是内容,字节基本压不掉(每个约 68 字节:role+ref+text+bounds);
        // 能省的是 33 个单子节点的包装层。要保住 30 个 ref,整棵树最多只能缩到四成多。
        assertTrue("只从 ${before.length} 缩到 ${after.length}", after.length * 3 <= before.length * 2)
        // 内容节点(有 ref 的)一个都不少
        val kept = after.split("\"ref\"").size - 1
        assertTrue("ref 只剩 $kept 个", kept >= 30)
        // 节点总数被压住
        assertTrue("节点 ${count(UiTreeJson.windows(s))}", count(UiTreeJson.windows(s)) <= UiTreeJson.MAX_NODES + 1)
    }

    /** 改造前的全量写法,只用来算对照。 */
    private fun legacy(n: UiTreeNode): JsonObject = JsonObject(
        buildMap {
            put("role", JsonPrimitive(n.role))
            n.ref?.let { put("ref", JsonPrimitive(it)) }
            n.text?.let { put("text", JsonPrimitive(it)) }
            put("bounds", JsonArray(n.bounds.map(::JsonPrimitive)))
            if (n.children.isNotEmpty()) put("children", JsonArray(n.children.map(::legacy)))
        },
    )
}
