package com.wangzan101.mika.core.guard

import com.wangzan101.mika.core.tool.Verb
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray

/** 读屏、看图、诊断屏幕一类:守卫按工具计重复,不按参数。 */
internal val DIAGNOSTIC_VERBS = setOf(Verb.Observe, Verb.ListElements, Verb.Screenshot, Verb.Describe, Verb.Diagnose, Verb.ViewPastScreens)
/** 只读不动的看页面一类:页面没变时反复用它们读,由 [OperationGuards.read] 管。 */
internal val PAGE_READ_VERBS = DIAGNOSTIC_VERBS + setOf(Verb.ReadPage, Verb.EvaluateJs, Verb.SiteCommand)

/** 工具结果的指纹(不含每次都换的读屏编号)。 */
internal fun resultFingerprint(content: JsonObject): Long {
    val text = JsonObject(content - "snapshotId" - "guard" - "advice").toString()
    var h = -0x340d631b7bdddcdbL
    for (b in text.toByteArray(Charsets.UTF_8)) h = (h xor (b.toLong() and 0xff)) * 0x100000001b3L
    return h
}

/** 画面指纹:元素列表文本的 64 位 FNV-1a。纯文本模型没有截图,也能判断「画面没变」。 */
internal fun elementsHash(elements: JsonArray?): Long? {
    elements ?: return null
    // 不含编号:稳定编号开着时同一屏里重复的同名元素每次读都换新编号,不该被当成换了一屏
    val text = JsonArray(elements.map { e -> (e as? JsonObject)?.let { JsonObject(it - "ref") } ?: e }).toString()
    var h = -0x340d631b7bdddcdbL
    for (b in text.toByteArray(Charsets.UTF_8)) {
        h = (h xor (b.toLong() and 0xff)) * 0x100000001b3L
    }
    return h
}

/**
 * 从读屏结果里取「这一屏有哪些控件」:元素表优先,没有时把窗口树里的节点平铺出来。
 * 手机上一条全量结果只有 tree(元素表是它的副本,不再重复发),指纹和整页读取都得从树里取。
 */
internal fun screenElementsOf(content: JsonObject): JsonArray? {
    (content["elements"] as? JsonArray)?.let { return it }
    val tree = content["tree"] as? JsonArray ?: return null
    return buildJsonArray {
        fun walk(nodes: JsonArray) {
            for (n in nodes) {
                val o = n as? JsonObject ?: continue
                add(o)
                (o["children"] as? JsonArray)?.let(::walk)
            }
        }
        for (w in tree) ((w as? JsonObject)?.get("nodes") as? JsonArray)?.let(::walk)
    }
}
