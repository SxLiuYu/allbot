package com.wangzan101.mika.core.replay

import com.wangzan101.mika.core.model.Author
import com.wangzan101.mika.core.knowledge.KnowledgeStore
import com.wangzan101.mika.core.model.ChatModel
import com.wangzan101.mika.core.model.Message
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.Role
import com.wangzan101.mika.core.prompt.Prompts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** 选中的路线和本次原话里的槽值(按 `{1}`、`{2}` 的顺序)。 */
data class RouteChoice(val route: Route, val slots: List<String>)

/**
 * 任务开始时找一条以往成功的路线:先按 App 与字面相似度取候选,再用一次模型调用(没有候选就不调)选定并抽出槽值。
 * 代码再核一遍:槽值个数要对,且每个都是本次原话里逐字出现的一段。[store] 也供循环更新路线计数。
 */
class RouteMatcher(private val model: ChatModel, val store: RouteStore, private val knowledge: KnowledgeStore?) {

    fun candidates(goal: String, limit: Int = 5): List<Route> {
        val apps = knowledge?.matchTask(goal, Int.MAX_VALUE)?.flatMap { it.packages }?.toSet().orEmpty()
        val g = bigrams(goal)
        return store.all().filter { !it.disabled }
            .map { it to jaccard(g, bigrams(SLOT.replace(it.template, "\u0000"))) }
            .filter { (r, sim) -> sim >= MIN_SIMILARITY || r.packages.any(apps::contains) }
            .sortedByDescending { it.second }
            .take(limit)
            .map { it.first }
    }

    suspend fun choose(goal: String): RouteChoice? {
        val list = candidates(goal)
        if (list.isEmpty()) return null
        // 有一个候选的模板就是这次原话、又没有槽:模型只能回「选它,slots:[]」。
        // 这一次往返只是为了得到一句常量,直接省掉(每次任务省约 1 秒,且少一次调用的 token)。
        // 同一 App 的其他路线也会被 [candidates] 按包名带进来,所以不能只认「唯一候选」。
        list.filter { it.slots == 0 && squash(it.template) == squash(goal) }.singleOrNull()
            ?.let { return RouteChoice(it, emptyList()) }
        // 同义改写(同一句话换个说法)也走捷径:候选里只有一个相似度够高、又没有槽、还被别的候选明显抛开。
        // 相似度低一点就交给模型:一字之差能改掉要办的事(「第一个分类的名字」对「第一个通知是什么」),二元组分不出来。
        shortcut(goal, list)?.let { return RouteChoice(it, emptyList()) }
        val text = list.withIndex().joinToString("\n", "用户原话:$goal\n\n做法模板:\n") { (i, r) -> "${i + 1}. ${r.template}" }
        val reply = try {
            withTimeoutOrNull(TIMEOUT_MS) { model.complete(PROMPT, listOf(Message(Role.User, listOf(Part.Text(text)), Author.Mika)), emptyList()) } ?: return null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        return parse(reply.parts.filterIsInstance<Part.Text>().joinToString("") { it.text }, list, goal)
    }

    companion object {
        const val MIN_SIMILARITY = 0.3

        /** 同义改写走捷径要过的那道门槛,比 [MIN_SIMILARITY] 高:过 0.3 只是「值得问模型」,不是「确定是这条」。 */
        const val SHORTCUT_SIMILARITY = 0.35

        /** 第一名要比第二名高出这么多,否则两个都像,交给模型分。 */
        const val SHORTCUT_MARGIN = 0.10
        const val TIMEOUT_MS = 20_000L
        private val SLOT = Regex("\\{\\d+\\}")
        private val SLOT_N = Regex("\\{(\\d+)\\}")

        private fun squash(s: String) = s.filterNot { it.isWhitespace() }

        /**
         * 同义改写能不能直接选:[list] 里只有一条无槽路线过 [SHORTCUT_SIMILARITY],且比第二名高 [SHORTCUT_MARGIN]。
         * 只要有两条够像就返回 null:那时谁更对只有模型说得清,省一次调用不值得赌。
         */
        internal fun shortcut(goal: String, list: List<Route>): Route? {
            val g = bigrams(goal)
            val scored = list.map { it to jaccard(g, bigrams(SLOT.replace(it.template, "\u0000"))) }
                .sortedByDescending { it.second }
            val (best, sim) = scored.firstOrNull() ?: return null
            if (best.slots != 0 || sim < SHORTCUT_SIMILARITY) return null
            val runnerUp = scored.getOrNull(1)?.second ?: 0.0
            return best.takeIf { sim - runnerUp >= SHORTCUT_MARGIN }
        }

        private fun occurrences(s: String, v: String): Int {
            var n = 0; var i = s.indexOf(v)
            while (i >= 0) { n++; i = s.indexOf(v, i + 1) }
            return n
        }

        val PROMPT: String by lazy { Prompts.role("route_match") }

        internal fun parse(text: String, list: List<Route>, goal: String): RouteChoice? {
            val start = text.indexOf('{'); val end = text.lastIndexOf('}')
            if (start < 0 || end <= start) return null
            val o = try { Json.parseToJsonElement(text.substring(start, end + 1)) as? JsonObject } catch (e: Exception) { null } ?: return null
            val pick = o["route"]
            if (pick == null || pick is JsonNull) return null
            val idx = (pick as? JsonPrimitive)?.intOrNull ?: return null
            val route = list.getOrNull(idx - 1) ?: return null
            val slots = (o["slots"] as? JsonArray ?: JsonArray(emptyList())).map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull ?: return null }
            if (slots.size != route.slots) return null
            // 每个槽值在原话里恰好出现一次,且把槽值填回模板要正好得到原话:槽的边界和模板的固定文字对齐
            // (「张三」不能从「张三丰」里抠出来)
            if (slots.any { it.isBlank() || occurrences(goal, it) != 1 }) return null
            var unknown = false
            val filled = SLOT_N.replace(route.template) { m -> slots.getOrNull(m.groupValues[1].toInt() - 1) ?: run { unknown = true; "" } }
            if (unknown || squash(filled) != squash(goal)) return null
            return RouteChoice(route, slots)
        }

        /** 字符二元组;占位符(\u0000)切断前后。 */
        internal fun bigrams(s: String): Set<String> =
            s.lowercase().filterNot { it.isWhitespace() }.windowed(2).filter { '\u0000' !in it }.toSet()

        internal fun jaccard(a: Set<String>, b: Set<String>): Double =
            if (a.isEmpty() || b.isEmpty()) 0.0 else a.intersect(b).size.toDouble() / a.union(b).size
    }
}
