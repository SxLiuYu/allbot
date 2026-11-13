package com.wangzan101.mika.core.record

/**
 * 结局只有一个口径:办成了就是 succeeded/unverified,没办成就是 failed。
 *
 * 记录里会同时出现三层说法——任务自己收尾时的 outcome(可能仍是 succeeded)、回答交出后的 judged
 * (partial / not_possible)、以及明确的失败种类 failKind。展示和汇总一律先过这里,磁盘上的原文件不改。
 */
object OutcomePolicy {
    val SCHEMA = 2

    const val FAILED = "failed"
    private val NOT_DONE = setOf("partial", "not_possible")

    fun effective(outcome: String?, judged: String?, failKind: String? = null): String = when {
        !failKind.isNullOrBlank() -> FAILED
        judged in NOT_DONE -> FAILED
        !outcome.isNullOrBlank() -> outcome
        else -> "unknown"
    }
}
