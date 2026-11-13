package com.wangzan101.mika.core.uistate

import com.wangzan101.mika.core.guard.elementsHash
import com.wangzan101.mika.core.guard.screenElementsOf
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.tool.FakeScreen
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.wangzan101.mika.core.assembly.toolDispatcher

/**
 * 手机上一条全量读屏只发 tree:元素表是同一批控件的平铺副本(refs 100% 重合),
 * 实测占一次全量 screen 的四成。这里钉住三件事:
 * 一、有 tree 时不再发 elements,网页(没有 tree)照旧发;
 * 二、守卫的指纹仍能从 tree 取到,不会因为少了 elements 就判不出画面变没变;
 * 三、走真实 observe 时模型照样拿得到 ref。
 */
class ScreenElementsDedupTest {
    private fun snapshot(id: String, vararg texts: String, withTree: Boolean = true) = ScreenSnapshot(
        id, "com.x",
        texts.mapIndexed { i, t -> UiElement("@e${i + 1}", "TextView", t, 500, 100, listOf(0, 0, 10, 10), null, false, false, false) },
        1080, 2400,
        windows = if (withTree) listOf(
            UiWindowTree(1, "application", 0, null, "com.x", true, true,
                texts.mapIndexed { i, t -> UiTreeNode("TextView", listOf(0, 10 + i * 20, 999, 20 + i * 20), ref = "@e${i + 1}", text = t) }),
        ) else emptyList(),
    )

    private fun window(vararg nodes: JsonObject) = buildJsonArray {
        add(buildJsonObject { put("nodes", JsonArray(nodes.toList())) })
    }

    private fun node(role: String, ref: String? = null, text: String? = null, children: JsonArray? = null) = buildJsonObject {
        put("role", role)
        ref?.let { put("ref", it) }
        text?.let { put("text", it) }
        put("bounds", JsonArray(listOf(0, 0, 999, 999).map { kotlinx.serialization.json.JsonPrimitive(it) }))
        children?.let { put("children", it) }
    }

    private fun collectRefs(tree: JsonArray): Set<String> {
        val out = mutableSetOf<String>()
        fun walk(nodes: JsonArray) {
            for (n in nodes) {
                val o = n as? JsonObject ?: continue
                (o["ref"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.let(out::add)
                (o["children"] as? JsonArray)?.let(::walk)
            }
        }
        for (w in tree) ((w as? JsonObject)?.get("nodes") as? JsonArray)?.let(::walk)
        return out
    }

    /** 模型手里的一屏:带上它的元素表(编号不做映射,测试里两边一致)。 */
    private fun model(id: String, vararg texts: String, withTree: Boolean = true): ModelSnapshot {
        val s = snapshot(id, *texts, withTree = withTree)
        return ModelSnapshot(id, s, s.elements, s.elements.associate { it.ref to it.ref })
    }

    /** 有 tree 时全量结果只有 tree,没有平铺的那一份。 */
    @Test fun fullReadOnPhoneSendsTheTreeOnly() = runTest {
        val current = model("p1", "设置", "WLAN")
        val full = InterfaceUpdate.between(null, current, baseVisible = false, maxElements = Int.MAX_VALUE)
        assertEquals("true", full["full"]!!.jsonPrimitive.content)
        assertNull("有 tree 时不该再发 elements", full["elements"])
        assertNotNull(full["tree"])
        assertEquals(setOf("@e1", "@e2"), collectRefs(full["tree"]!! as JsonArray))
    }

    /** 网页端口(没有 windows)照旧只发 elements。 */
    @Test fun webReadStillSendsElements() = runTest {
        val current = model("p1", "登录", withTree = false)
        val full = InterfaceUpdate.between(null, current, baseVisible = false, maxElements = Int.MAX_VALUE)
        assertNotNull("没有 tree 时必须发 elements", full["elements"])
        assertNull(full["tree"])
    }

    /**
     * 守卫的指纹:结果里只有 tree 时也要能算出画面指纹,否则「画面没变」判不出来。
     * 从 tree 平铺出来的那份,和真正带 elements 的结果算出来的是同一个值——两条路是同一批控件。
     */
    @Test fun fingerprintWorksFromTreeAlone() {
        val content = buildJsonObject { put("tree", window(node("TextView", "@e1", "设置"), node("TextView", "@e2", "WLAN"))) }
        val fromTree = screenElementsOf(content)
        assertNotNull(fromTree)
        assertEquals(2, fromTree!!.size)
        assertNotNull("从 tree 平铺出来的元素要能算指纹", elementsHash(fromTree))
        val explicit = buildJsonObject { put("elements", fromTree) }
        assertEquals(elementsHash(screenElementsOf(explicit)), elementsHash(fromTree))
    }

    /** 树里的子节点也要平铺出来,不能只看第一层。 */
    @Test fun nestedNodesAreFlattened() {
        val content = buildJsonObject {
            put("tree", window(node("LinearLayout", children = buildJsonArray { add(node("TextView", "@e9", "深一层的字")) })))
        }
        val flat = screenElementsOf(content)!!
        val refs = flat.mapNotNull { (it as JsonObject)["ref"]?.jsonPrimitive?.content }
        assertTrue("@e9 应当从树的子节点里平铺出来,实际拿到 $refs", "@e9" in refs)
    }

    /** 既没有 elements 也没有 tree(比如只报了个错):返回 null,调用方照旧回落到别的判据。 */
    @Test fun nothingToFlattenGivesNull() {
        assertNull(screenElementsOf(buildJsonObject { put("ok", true) }))
    }

    /**
     * 走一遍真实的 observe:手机屏(带 tree)的结果里没有 elements,
     * 但模型照样拿得到 ref(从 tree 里读),读屏编号也在。
     */
    @Test fun observeOnPhoneKeepsRefsWithoutElements() = runTest {
        val port = object : ScreenPort by FakeScreen() {
            override suspend fun snapshot() = snapshot("p1", "设置", "WLAN")
        }
        val d = toolDispatcher(port, stableRefs = true, inlineScreen = true)
        val o = d.executeRead(Part.ToolCall("c1", "phone_observe", "{}")).content
        assertNull("手机上不该再发平铺的元素表", o["elements"])
        assertEquals(setOf("@e1", "@e2"), collectRefs(o["tree"]!! as JsonArray))
        assertEquals("p1", o["snapshotId"]!!.jsonPrimitive.content)
    }
}
