package com.wangzan101.mika.core.record

import org.junit.Assert.assertEquals
import org.junit.Test

class OutcomePolicyTest {
    @Test fun judgedNotDoneTurnsSuccessIntoFailure() {
        assertEquals("failed", OutcomePolicy.effective("succeeded", "partial"))
        assertEquals("failed", OutcomePolicy.effective("unverified", "not_possible"))
        assertEquals("failed", OutcomePolicy.effective("cancelled", "partial"))
    }

    @Test fun explicitFailureKindWins() {
        assertEquals("failed", OutcomePolicy.effective("succeeded", null, "tool_error"))
        assertEquals("failed", OutcomePolicy.effective(null, "done", "model_error"))
    }

    @Test fun everythingElseKeepsItsOwnWord() {
        assertEquals("succeeded", OutcomePolicy.effective("succeeded", "done"))
        assertEquals("unverified", OutcomePolicy.effective("unverified", null))
        assertEquals("failed", OutcomePolicy.effective("failed", null))
        assertEquals("cancelled", OutcomePolicy.effective("cancelled", "done"))
    }

    @Test fun missingBothIsUnknown() {
        assertEquals("unknown", OutcomePolicy.effective(null, null))
        assertEquals("unknown", OutcomePolicy.effective("", null))
    }
}
