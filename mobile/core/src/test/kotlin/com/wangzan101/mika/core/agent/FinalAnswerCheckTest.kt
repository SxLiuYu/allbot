package com.wangzan101.mika.core.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FinalAnswerCheckTest {
    @Test fun unfinishedRepliesAreRecognized() {
        assertTrue(FinalAnswerSounds.unfinished("没收到能量"))
        assertTrue(FinalAnswerSounds.unfinished("领取失败"))
        assertFalse(FinalAnswerSounds.unfinished("今日共获得 869g 能量"))
    }

    @Test fun screenWithAQuantityAndGoalWordCountsAsEvidence() {
        assertTrue(FinalAnswerContradiction.hasEvidence("收其他人的能量", "当前 App:com.x\n今日获得 869g 能量"))
        assertFalse(FinalAnswerContradiction.hasEvidence("收其他人的能量", "当前 App:com.x\n暂无记录"))
    }
}
