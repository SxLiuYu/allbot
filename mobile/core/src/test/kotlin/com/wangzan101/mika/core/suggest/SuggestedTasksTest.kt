package com.wangzan101.mika.core.suggest

import com.wangzan101.mika.core.memory.MemoryItem
import com.wangzan101.mika.core.memory.MemoryKind
import com.wangzan101.mika.core.memory.MemorySource
import com.wangzan101.mika.core.memory.MemoryStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SuggestedTasksTest {
    private fun memory(
        content: String,
        kind: MemoryKind = MemoryKind.preference,
        keywords: List<String> = emptyList(),
        status: MemoryStatus = MemoryStatus.active,
        useCount: Int = 0,
    ) = MemoryItem(
        id = content, kind = kind, content = content, keywords = keywords,
        source = MemorySource("manual", atMs = 0), status = status,
        createdAt = 0, updatedAt = 0, useCount = useCount,
    )

    private val fallback = listOf("给张三发一条消息", "打开设置看看电池", "查一下明天天气", "整理今天的笔记", "设置一个闹钟", "看看有什么新消息")

    @Test fun recentHistoryComesFirstAndWinsOverFallback() {
        // history 按「最近的在前」传进来
        val out = SuggestedTasks.rank(
            history = listOf("去支付宝收蚂蚁森林能量", "打开番茄小说领金币", "给妈妈发一条微信"),
            memories = emptyList(),
            fallback = fallback,
            limit = 4,
        )
        assertEquals("去支付宝收蚂蚁森林能量", out.first().text)
        assertEquals(SuggestionSource.history, out.first().source)
        assertTrue(out.take(3).all { it.source == SuggestionSource.history })
        assertEquals(out.size, out.map { it.text }.distinct().size)
    }

    @Test fun oneOffChatterIsNotSuggested() {
        val out = SuggestedTasks.rank(
            history = listOf("继续", "好", "打开冰箱", "去支付宝收蚂蚁森林能量"),
            memories = emptyList(),
            fallback = fallback,
        )
        assertFalse(out.any { it.text == "继续" || it.text == "好" })
        assertTrue(out.any { it.text == "去支付宝收蚂蚁森林能量" })
    }

    @Test fun memoryPreferenceLiftsMatchingHistory() {
        val out = SuggestedTasks.rank(
            history = listOf("打开番茄小说领金币", "去支付宝收蚂蚁森林能量"),
            memories = listOf(memory("每天中午在支付宝收能量", keywords = listOf("支付宝", "能量"))),
            fallback = fallback,
        )
        // 命中记忆关键词的那条排第一
        assertEquals("去支付宝收蚂蚁森林能量", out.first().text)
    }

    @Test fun memoryOnlyFillsWhenHistoryIsThin() {
        val out = SuggestedTasks.rank(
            history = emptyList(),
            memories = listOf(
                memory("每天早上提醒我吃药", keywords = listOf("提醒")),
                memory("用户是程序员", kind = MemoryKind.fact),
            ),
            fallback = fallback,
            limit = 4,
        )
        assertEquals("每天早上提醒我吃药", out.first().text)
        assertEquals(SuggestionSource.memory, out.first().source)
        assertFalse(out.any { it.text.contains("程序员") })
        assertEquals(4, out.size)
    }

    @Test fun pendingMemoryIsIgnored() {
        val out = SuggestedTasks.rank(
            history = emptyList(),
            memories = listOf(memory("每天帮我收金币", status = MemoryStatus.pending)),
            fallback = fallback,
            limit = 3,
        )
        assertTrue(out.all { it.source == SuggestionSource.fallback })
    }
}
