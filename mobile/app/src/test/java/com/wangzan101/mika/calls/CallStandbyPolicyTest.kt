package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 后台常驻与自动接听的准入判断。
 *
 * 这几条决定「什么时候系统可以替用户自动接一个电话」。判宽了就是在用户不知情时接电话,
 * 所以每条都要从「少接」那一侧验：任何一项不满足就不接。
 */
class CallStandbyPolicyTest {

    private fun config(
        enabled: Boolean = true,
        autoAnswer: Boolean = true,
        audioVerified: Boolean = true,
        credentials: Boolean = true,
    ) = CallConfig(
        enabled = enabled, autoAnswer = autoAnswer,
        audioVerified = audioVerified, credentialsConfigured = credentials,
    )

    // ---- 是否值得常驻 ----

    /** 常驻的四个条件缺一不可:开着、要自动接、音频验过、有凭证。 */
    @Test fun standbyNeedsAllFourSwitches() {
        assertTrue(CallStandbyPolicy.optedIn(config(), userUnlocked = true))
        assertFalse("锁着就不常驻", CallStandbyPolicy.optedIn(config(), userUnlocked = false))
        assertFalse(CallStandbyPolicy.optedIn(config(enabled = false), userUnlocked = true))
        assertFalse(CallStandbyPolicy.optedIn(config(autoAnswer = false), userUnlocked = true))
        assertFalse("没验过音频", CallStandbyPolicy.optedIn(config(audioVerified = false), userUnlocked = true))
        assertFalse("没凭证", CallStandbyPolicy.optedIn(config(credentials = false), userUnlocked = true))
    }

    // ---- 前台判定 ----

    @Test fun interactiveForegroundNeedsAllThree() {
        assertTrue(CallStandbyPolicy.interactiveForeground(visible = true, interactive = true, keyguardShowing = false))
        assertFalse("看不见", CallStandbyPolicy.interactiveForeground(visible = false, interactive = true, keyguardShowing = false))
        assertFalse("没交互", CallStandbyPolicy.interactiveForeground(visible = true, interactive = false, keyguardShowing = false))
        assertFalse("锁屏挡着", CallStandbyPolicy.interactiveForeground(visible = true, interactive = true, keyguardShowing = true))
    }

    // ---- 能不能自动接 ----

    /**
     * 自动接听要有一条可靠的路:要么界面就在前台,要么服务在跑且通知可用。
     * 两者都没有就不能接——否则接起来用户既看不见也取消不了。
     */
    @Test fun automaticAnswerNeedsAVisiblePath() {
        assertTrue("界面在前台", CallStandbyPolicy.allowsAutomaticAnswer(
            userUnlocked = true, interactiveForeground = true, serviceRunning = false, notificationsAllowed = false))
        assertTrue("服务在跑且能通知", CallStandbyPolicy.allowsAutomaticAnswer(
            userUnlocked = true, interactiveForeground = false, serviceRunning = true, notificationsAllowed = true))
        assertFalse("服务在跑但通知被关", CallStandbyPolicy.allowsAutomaticAnswer(
            userUnlocked = true, interactiveForeground = false, serviceRunning = true, notificationsAllowed = false))
        assertFalse("什么都没有", CallStandbyPolicy.allowsAutomaticAnswer(
            userUnlocked = true, interactiveForeground = false, serviceRunning = false, notificationsAllowed = false))
        assertFalse("锁着就一律不接", CallStandbyPolicy.allowsAutomaticAnswer(
            userUnlocked = false, interactiveForeground = true, serviceRunning = true, notificationsAllowed = true))
    }

    // ---- 唤醒预算 ----

    /**
     * 拿唤醒锁的时长要盖住整通电话,还要留一点余量收尾。
     * 太少会在通话中途被系统断掉,太多会白耗电。
     */
    @Test fun theWakeBudgetCoversTheCallPlusATail() {
        assertEquals(120_000L + 10_000L, CallStandbyPolicy.activeWakeBudgetMs(120))
        // 上限收到 MAX_SECONDS(600)
        assertEquals(600_000L + 10_000L, CallStandbyPolicy.activeWakeBudgetMs(9_999))
        // 下限收到 15 秒:太短的预算还不如不给
        assertEquals(15_000L + 10_000L, CallStandbyPolicy.activeWakeBudgetMs(1))
        assertEquals(15_000L + 10_000L, CallStandbyPolicy.activeWakeBudgetMs(0))
        assertEquals(15_000L + 10_000L, CallStandbyPolicy.activeWakeBudgetMs(-5))
    }

    // ---- 恢复闸门 ----

    /**
     * 自动恢复只能试一次。失败后不能反复重试——那会变成无限循环。
     * 但界面重新可见时可以再给一次机会(用户可能刚修好了什么)。
     */
    @Test fun automaticRestoreIsAttemptedOnlyOncePerVisibility() {
        val g = CallStandbyResumeGate()
        assertTrue("第一次可见且够条件,该试", g.take(visible = true, eligible = true))
        assertFalse("同一次可见期间不许再试", g.take(visible = true, eligible = true))
        assertFalse(g.take(visible = true, eligible = true))
        // 界面隐藏再回来:重新给机会
        assertFalse(g.take(visible = false, eligible = true))
        assertTrue("重新可见后可以再试一次", g.take(visible = true, eligible = true))
        assertFalse(g.take(visible = true, eligible = true))
    }

    @Test fun ineligibleNeverTriggersARestore() {
        val g = CallStandbyResumeGate()
        assertFalse(g.take(visible = true, eligible = false))
        assertFalse(g.take(visible = true, eligible = false))
        // 之前不够条件不该消耗那一次机会
        assertTrue("够条件了就该试", g.take(visible = true, eligible = true))
    }

    /** 不够条件时不消耗机会,所以修好之后立刻能试。 */
    @Test fun aFailedEligibilityDoesNotBurnTheAttempt() {
        val g = CallStandbyResumeGate()
        repeat(5) { assertFalse(g.take(visible = true, eligible = false)) }
        assertTrue(g.take(visible = true, eligible = true))
    }
}
