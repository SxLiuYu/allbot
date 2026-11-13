package com.wangzan101.mika.core.suggest

import com.wangzan101.mika.core.memory.MemoryItem
import com.wangzan101.mika.core.memory.MemoryKind

/** 这条建议从哪来:用户做过的、记忆里记下的、还是兜底示例。 */
enum class SuggestionSource { history, memory, fallback }

data class TaskSuggestion(val text: String, val source: SuggestionSource, val score: Int)

/**
 * 空对话里的「建议任务」按用户自己的历史与记忆重算,不再固定那几条示例。
 *
 * 排序只看本地数据,不调模型:
 * 1. 用户最近做过的事(successful 与否从标题看不出来,所以只当作候选,不标成推荐理由);
 * 2. 记忆里的偏好/做法命中候选关键词时加权,让常做的事排在前面;
 * 3. 历史不够或没有时,用记忆里像一句指令的条目补;
 * 4. 仍不够才回落到内置示例。
 */
object SuggestedTasks {
    private val VERBS = listOf(
        "打开", "查", "发", "收", "领", "提醒", "整理", "预约", "买", "看", "听", "记", "帮我", "去", "叫",
    )
    private val TIME = Regex("每天|每周|每月|早上|中午|晚上|下午|工作日|周末")
    private val TRIVIAL = Regex("^(继续|好|可以|嗯|对|不用|算了|行|ok|再试一次)[。!！]?$", RegexOption.IGNORE_CASE)
    private val SPLIT = Regex("[\\s，。！？、,:;：；.!?()（）\\[\\]【】\"'“”]+")
    private val STOP = setOf(
        "帮我", "我的", "一个", "一下", "这个", "那个", "然后", "现在", "已经", "还是", "不要", "可以", "什么",
        "怎么", "给我", "这个月", "今天",
    )

    fun rank(
        history: List<String>,
        memories: List<MemoryItem>,
        fallback: List<String>,
        limit: Int = 6,
    ): List<TaskSuggestion> {
        val active = memories.filter { it.status == MemoryStatusActive }
        // 中文没有空格,按分词比「重叠」会整句算一个词,所以改成:记忆的关键词/切出来的词被这句话包含就算命中
        val memoryWords = active.flatMap { it.keywords + tokens(it.content) }
            .map { it.trim() }
            .filter { it.length >= 2 }
            .distinct()

        val best = LinkedHashMap<String, TaskSuggestion>()
        history.forEachIndexed { index, raw ->
            val text = normalize(raw) ?: return@forEachIndexed
            val recency = (history.size - index).coerceAtLeast(1)
            val overlap = memoryWords.count { text.contains(it) }
            val score = recency * 2 + overlap * 6
            val old = best[text]
            if (old == null || old.score < score) best[text] = TaskSuggestion(text, SuggestionSource.history, score)
        }

        active.filter { it.kind != MemoryKind.fact }.forEach { item ->
            val text = normalize(item.content) ?: return@forEach
            val looksImperative = VERBS.any { text.contains(it) }
            if (!looksImperative) return@forEach
            if (text.length > 28 && !TIME.containsMatchIn(text)) return@forEach
            if (best.keys.any { same(it, text) }) return@forEach
            best[text] = TaskSuggestion(text, SuggestionSource.memory, 12 + item.useCount)
        }

        val ranked = best.values.sortedWith(
            compareByDescending<TaskSuggestion> { it.score }.thenBy { it.source.ordinal },
        ).take(limit).toMutableList()

        if (ranked.size < limit) {
            fallback.mapNotNull(::normalize).forEach { text ->
                if (ranked.size < limit && ranked.none { same(it.text, text) }) {
                    ranked += TaskSuggestion(text, SuggestionSource.fallback, 0)
                }
            }
        }
        return ranked
    }

    private fun normalize(raw: String): String? {
        val text = raw.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
        if (text.length !in 4..60) return null
        if (TRIVIAL.matches(text)) return null
        return text
    }

    private fun same(a: String, b: String) =
        a == b || (a.length >= 8 && b.length >= 8 && (a.contains(b) || b.contains(a)))

    private fun tokens(text: String): List<String> =
        text.split(SPLIT).filter { it.length >= 2 && it !in STOP }
}

/** 记忆状态里的 active;单独写出来,避免和 core 里的枚举名撞。 */
private val MemoryStatusActive = com.wangzan101.mika.core.memory.MemoryStatus.active
