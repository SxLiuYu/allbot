package com.wangzan101.mika.core.agent

/**
 * 收尾硬校验用的两条窄规则。只判「回答自己说没办成」和「屏上确有能核对的结果」,
 * 不判断事实真假,也不替代交出回答之后那次结局判定([OutcomeJudge])。
 */
internal object FinalAnswerSounds {
    private val UNFINISHED = Regex(
        "没(?:有)?(?:收到|领取|领到|抢到|办成|完成|成功|找到|看到|加上|加上去|打开|发出|发送|提交|保存|设置好|查到)|" +
            "无法(?:完成|领取|收到|找到|打开|发送|提交|保存)|未能(?:完成|领取|收到|找到|发送|提交|保存)|" +
            "失败|找不到|领不了|收不了|没有(?:能量|收益|成功)|领取失败|收不到|未收到|未完成"
    )

    fun unfinished(answer: String): Boolean = UNFINISHED.containsMatchIn(answer)
}

internal object FinalAnswerContradiction {
    /** 屏上写着可核对的量(数、金额、百分比、带单位的量);纯文字状态不拿来逼模型改口。 */
    private val QUANTITY = Regex("\\d+(?:[.,]\\d+)?\\s*(?:[gG克][^\\d\\n]{0,8}|元|块|万|亿|千|%|％|分|个|次|人|条|笔)")

    /** 目标里的关键词在屏上也出现了(如「能量」「收益」),配上一个量才算有结果可核。 */
    private val GOAL_WORDS = Regex("[\\p{IsHan}]{2,}|[A-Za-z]{3,}")

    fun hasEvidence(goal: String, screen: String): Boolean {
        if (!QUANTITY.containsMatchIn(screen)) return false
        // 中文目标是一整串词,屏上往往只出现其中的一小段:按两字窗口找,别拿整句去比
        val words = GOAL_WORDS.findAll(goal).flatMap { m ->
            val w = m.value
            if (w.all { it.code in 0x4e00..0x9fff } && w.length > 2) (0..w.length - 2).map { w.substring(it, it + 2) }
            else listOf(w)
        }.distinct().take(20).toList()
        return words.isEmpty() || words.any { screen.contains(it) }
    }
}
