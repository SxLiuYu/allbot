package com.wangzan101.mika.core.record

import org.junit.Assert.assertEquals
import org.junit.Test

/** run.json 的结局跟 UI、评分一致:回答判成没办成时不再留着 succeeded。 */
class RunSummaryOutcomeTest {
    private fun summary(outcome: String) = RunSummary(id = "r", goal = "收能量", startedAtMs = 1, outcome = outcome, answerOrReason = "没收到")
        .with(RunEvent.TaskEnded(100, outcome, "没收到"))

    @Test fun notPossibleOverwritesSucceeded() {
        val r = summary("succeeded").with(RunEvent.OutcomeJudged(200, "not_possible"))
        assertEquals("failed", r.outcome)
        assertEquals("not_possible", r.judged)
    }

    @Test fun partialOverwritesUnverified() {
        val r = summary("unverified").with(RunEvent.OutcomeJudged(200, "partial"))
        assertEquals("failed", r.outcome)
    }

    @Test fun doneAndUnknownKeepTheDeliveredOutcome() {
        assertEquals("succeeded", summary("succeeded").with(RunEvent.OutcomeJudged(200, "done")).outcome)
        assertEquals("succeeded", summary("succeeded").with(RunEvent.OutcomeJudged(200, "unknown")).outcome)
    }

    @Test fun failureStaysFailure() {
        assertEquals("failed", summary("failed").with(RunEvent.OutcomeJudged(200, "partial")).outcome)
    }
}
