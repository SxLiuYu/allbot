package com.wangzan101.mika.core.uistate

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UiTreeJsonTest {
    private fun leaf(ref: String, text: String) = UiTreeNode(
        role = "Button", bounds = listOf(0, 0, 500, 100), ref = ref, text = text,
        clickable = true, checkable = true, checked = false,
    )

    private fun screen(second: String = "查看", extra: Boolean = false): ScreenSnapshot {
        val children = listOf(leaf("@e1", "午餐"), leaf("@e2", second)) +
            if (extra) listOf(leaf("@e3", "新增")) else emptyList()
        val root = UiTreeNode("RecyclerView", listOf(0, 0, 999, 999), scrollable = true, children = children)
        val window = UiWindowTree(7, "application", 2, "订单", "com.example", true, true, listOf(root))
        val elements = children.mapIndexed { i, n ->
            UiElement(n.ref!!, "Button", n.text!!, 100, 100 + i * 100, n.bounds, null, true, false, false)
        }
        return ScreenSnapshot("port", "com.example", elements, 1080, 2400, windows = listOf(window))
    }

    @Test fun completeHierarchyAndStatesAreVisible() {
        val out = UiTreeJson.windows(screen()).single().jsonObject
        assertEquals("订单", out["title"]!!.jsonPrimitive.content)
        val root = out["nodes"]!!.jsonArray.single().jsonObject
        assertEquals("true", root["scrollable"]!!.jsonPrimitive.content)
        val children = root["children"]!!.jsonArray
        assertEquals(2, children.size)
        assertEquals("@e2", children[1].jsonObject["ref"]!!.jsonPrimitive.content)
        assertEquals("false", children[1].jsonObject["checked"]!!.jsonPrimitive.content)
    }

    @Test fun changedChildDoesNotRepeatUnchangedSibling() {
        val before = screen()
        val after = screen(second = "已查看", extra = true)
        val change = UiTreeJson.changes(before, after)
        val updated = change["updated"]!!.jsonArray
        assertEquals(listOf("w7/0/1", "w7/0/2"), updated.map { it.jsonObject["path"]!!.jsonPrimitive.content })
        assertEquals("已查看", updated[0].jsonObject["node"]!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("新增", updated[1].jsonObject["node"]!!.jsonObject["text"]!!.jsonPrimitive.content)
        assertTrue(change["removed"]!!.jsonArray.isEmpty())
    }

    @Test fun actionResultCarriesTreeChangeWithStablePath() {
        val stabilizer = RefStabilizer("p")
        val before = stabilizer.next(screen())
        val next = screen()
        val changedWindows = next.windows.map { window ->
            window.copy(nodes = window.nodes.map { root ->
                root.copy(children = root.children.mapIndexed { i, child ->
                    if (i == 1) child.copy(checked = true) else child
                })
            })
        }
        val after = stabilizer.next(next.copy(windows = changedWindows))
        val result = InterfaceUpdate.between(before, after, baseVisible = true, maxElements = Int.MAX_VALUE)
        assertEquals("false", result["full"]!!.jsonPrimitive.content)
        val updated = result["treeChanges"]!!.jsonObject["updated"]!!.jsonArray.single().jsonObject
        assertEquals("w7/0/1", updated["path"]!!.jsonPrimitive.content)
        assertEquals("true", updated["node"]!!.jsonObject["checked"]!!.jsonPrimitive.content)
    }

    @Test fun stableRefsAlsoMapIntoTree() {
        val port = screen().copy(elements = screen().elements.mapIndexed { i, e -> e.copy(ref = "@e${i + 8}") },
            windows = screen().windows.map { w -> w.copy(nodes = w.nodes.map { root ->
                root.copy(children = root.children.mapIndexed { i, n -> n.copy(ref = "@e${i + 8}") })
            }) })
        val model = RefStabilizer("p").next(port)
        val output = UiTreeJson.windows(model.screen).single().jsonObject["nodes"]!!.jsonArray.single().jsonObject["children"]!!.jsonArray
        assertEquals(model.elements.map { it.ref }, output.map { it.jsonObject["ref"]!!.jsonPrimitive.content })
        assertFalse(output[0].jsonObject.containsKey("children"))
    }

    /** 一屏 Layout 套 Layout 的:很多空壳,少量有文字/ref 的控件。 */
    private fun deepScreen(shells: Int, leaves: Int): ScreenSnapshot {
        var children: List<UiTreeNode> = (1..leaves).map { i ->
            UiTreeNode("TextView", listOf(0, i, 999, i + 1), ref = "@e$i", text = "第 $i 行")
        }
        // 一层层包起来,每层再多加一个空兄弟节点
        repeat(shells) {
            children = listOf(UiTreeNode("LinearLayout", listOf(0, 0, 999, 999), children = children)) +
                listOf(UiTreeNode("FrameLayout", listOf(0, 0, 999, 999)))
        }
        val window = UiWindowTree(1, "application", 0, null, "com.example", true, true, children)
        return ScreenSnapshot("port", "com.example", emptyList(), 1080, 2400, windows = listOf(window))
    }

    private fun JsonArray.allNodes(): List<kotlinx.serialization.json.JsonObject> =
        flatMap { (it as? kotlinx.serialization.json.JsonObject)?.let(::listOf) ?: emptyList() }
            .flatMap { o ->
                val kids = (o["children"] ?: o["nodes"]) as? JsonArray
                listOf(o) + kids?.allNodes().orEmpty()
            }

    @Test fun bigTreesDropShellsBeforeContent() {
        // 要越过 MAX_NODES 才裁剪:每层多一个空兄弟,30 层 => 70 个节点
        val s = deepScreen(shells = 30, leaves = 10)
        val out = UiTreeJson.windows(s)
        val nodes = out.allNodes()
        // 节点数被压在预算内(预算只数节点,窗口外壳另算)
        assertTrue("节点数 ${nodes.size} 超了 ${UiTreeJson.MAX_NODES}", nodes.size <= UiTreeJson.MAX_NODES + s.windows.size)
        // 有内容的控件一个都不能少
        for (i in 1..10) {
            assertTrue("第 $i 行被裁掉了", nodes.any { it["text"]?.jsonPrimitive?.content == "第 $i 行" })
        }
        // 被裁过的窗口要说明还剩多少
        assertTrue(out.any { it is kotlinx.serialization.json.JsonObject && it.containsKey("dropped") })
    }

    @Test fun smallTreesAreUntouched() {
        val s = screen()
        val out = UiTreeJson.windows(s)
        assertEquals(1, out.size)
        val w = out.single().jsonObject
        assertFalse(w.containsKey("dropped"))
        // 树还是原来那副样子:根 + 两个子节点
        val root = w["nodes"]!!.jsonArray.single().jsonObject
        assertEquals(2, root["children"]!!.jsonArray.size)
    }

    @Test fun droppedNoteNamesTheToolThatFillsTheGap() {
        assertTrue("phone_query" in UiTreeJson.droppedNote(12))
        assertTrue("12" in UiTreeJson.droppedNote(12))
    }

    /** 同一块屏,全量读法和差异读法必须把 resourceId 写成同一个样子,否则模型会当成两个控件。 */
    @Test fun bothReadingsTrimResourceIdTheSameWay() {
        fun node(ref: String, id: String, text: String) =
            UiTreeNode("TextView", listOf(0, 0, 999, 99), ref = ref, text = text, resourceId = id)
        fun snap(title: String) = ScreenSnapshot("p", "com.example", emptyList(), 1080, 2400, windows = listOf(
            UiWindowTree(3, "application", 0, null, "com.example", true, true,
                listOf(UiTreeNode("LinearLayout", listOf(0, 0, 999, 999), children = listOf(
                    node("@e1", "com.example:id/title", title),
                    node("@e2", "com.other:id/icon", "图标"),
                )))),
        ))
        val full = UiTreeJson.windows(snap("甲")).single().jsonObject
        val diff = UiTreeJson.changes(snap("甲"), snap("乙"))
        // 两处都说一次前缀是什么
        assertEquals("com.example:id/", full["resourceIdPrefix"]!!.jsonPrimitive.content)
        assertEquals("com.example:id/", diff["resourceIdPrefix"]!!.jsonPrimitive.content)
        // 自己包的收敛成 :id/名字,别人包的保持原样
        val nodes = full["nodes"]!!.jsonArray.single().jsonObject["children"]!!.jsonArray
        assertEquals(":id/title", nodes[0].jsonObject["resourceId"]!!.jsonPrimitive.content)
        assertEquals("com.other:id/icon", nodes[1].jsonObject["resourceId"]!!.jsonPrimitive.content)
        // 差异里改过的那一个是同一种写法
        val changed = diff["updated"]!!.jsonArray.single().jsonObject["node"]!!.jsonObject
        assertEquals(":id/title", changed["resourceId"]!!.jsonPrimitive.content)
        assertEquals("乙", changed["text"]!!.jsonPrimitive.content)
    }
}
