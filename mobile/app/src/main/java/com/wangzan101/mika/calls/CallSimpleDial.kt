package com.wangzan101.mika.calls

/**
 * 简单拨号：一个号码 + 一句「这次要谈什么」。
 *
 * 复杂外呼继续用 [CallTaskBrief] 的四个字段，但常见场景（打个电话问一句）不该逼用户填
 * 五栏。这里做的是**确定性映射**，不在 App 内用模型拆字段：
 *
 * - 用户写的整句原样进 `goal`。不做摘要，也不猜哪些字该进 questions/constraints——
 *   拆错的代价是漏掉限制条件，比多给模型一点文字严重得多。
 * - 没有单独填的字段就是空，不用默认文案填充，否则模型会以为机主额外授权过什么。
 * - 空要求返回 null：表示「只按号码打，不附带本次任务」，走现有无任务外呼的保守话术。
 */
internal object CallSimpleDial {

    /**
     * 一句要求的长度上限。直接跟 [CallTaskBrief.MAX_GOAL_CHARS] 走：上限写在两处迟早
     * 会分叉，而 `validatedSnapshot()` 已经按那个值校验，这里只是提前置灰按钮。
     */
    const val MAX_REQUEST_CHARS = CallTaskBrief.MAX_GOAL_CHARS

    /**
     * @param request 用户填的「这次要谈什么」；空白表示不附带任务。
     * @return 可拨号的任务快照；超出长度上限时返回 null（界面据此置灰按钮）。
     */
    fun brief(request: String): CallTaskBrief? {
        val text = request.trim()
        if (text.isEmpty()) return null
        if (text.length > MAX_REQUEST_CHARS) return null
        return CallTaskBrief(goal = text).runCatching { validatedSnapshot() }.getOrNull()
    }

    /** 是否能提交：号码合法（拨号前仍会再校验一次）且要求不超长。 */
    fun canDial(number: String?, request: String): Boolean =
        CallPolicy.outgoingNumber(number.orEmpty()) != null &&
            request.trim().length <= MAX_REQUEST_CHARS
}
