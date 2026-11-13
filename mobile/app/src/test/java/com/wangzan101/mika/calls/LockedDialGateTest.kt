package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 锁屏之后拨出电话的那道闸门。它管的是一件很具体的事:
 * 用户已经在手机上确认过「打给谁」,但那一刻屏幕锁着,拨号要等解锁后由系统那边执行。
 * 这中间不能让别的请求插进来,也不能让同一张通行证被用两次。
 */
class LockedDialGateTest {

    private var now = 1_000_000L
    private fun gate() = LockedDialGate { now }

    private val task = CallTaskBrief("问明天几点开门")

    @Test fun anArmedTicketCanBeClaimedExactlyOnce() {
        val g = gate()
        val t = g.arm("13800138000", "sim-1", task)!!
        assertEquals(LockedDialGate.Decision.WaitingForLock, g.poll(t, deviceLocked = false, eligible = true))
        val claimed = g.poll(t, deviceLocked = true, eligible = true)
        assertTrue("$claimed", claimed is LockedDialGate.Decision.Claimed)
        assertEquals("13800138000", (claimed as LockedDialGate.Decision.Claimed).request.number)
        // 同一张票不能再用一次
        val again = g.poll(t, deviceLocked = true, eligible = true)
        assertEquals(LockedDialGate.Decision.Rejected(LockedDialGate.Rejection.NOT_PENDING), again)
    }

    /** 过期之后即使从来没用过也不能认。 */
    @Test fun anExpiredTicketIsRejected() {
        val g = gate()
        val t = g.arm("13800138000", "sim-1", task)!!
        now += 45_001
        assertEquals(LockedDialGate.Decision.Rejected(LockedDialGate.Rejection.EXPIRED),
            g.poll(t, deviceLocked = true, eligible = true))
    }

    /** 说不上来能不能拨(eligibility 未知)就当不能:含糊不清不能变成放行。 */
    @Test fun unknownEligibilityIsRejectedNotWaitedOn() {
        val g = gate()
        val t = g.arm("13800138000", "sim-1", task)!!
        assertEquals(LockedDialGate.Decision.Rejected(LockedDialGate.Rejection.INELIGIBLE),
            g.poll(t, deviceLocked = false, eligible = false))
        // 拒过一次就作废了,后面解锁也不认
        assertEquals(LockedDialGate.Decision.Rejected(LockedDialGate.Rejection.NOT_PENDING),
            g.poll(t, deviceLocked = true, eligible = true))
    }

    /** 号码和 SIM 在排队时就要校验:紧急号码、短号、猜出来的 SIM 一律不发通行证。 */
    @Test fun invalidNumbersOrSimsNeverGetATicket() {
        val g = gate()
        for (bad in listOf("110", "*100#", "10086", "13800138000,123")) {
            assertNull("不该发通行证: $bad", g.arm(bad, "sim-1", task))
        }
        assertNull("SIM 不是记忆里的那种", g.arm("13800138000", "whatever", task))
        assertNull("空 SIM", g.arm("13800138000", "", task))
    }

    @Test fun anInvalidTaskNeverGetsATicket() {
        val g = gate()
        assertNull("空目标", g.arm("13800138000", "sim-1", CallTaskBrief(" ")))
        assertNull("目标超长", g.arm("13800138000", "sim-1", CallTaskBrief("x".repeat(401))))
    }

    /** 已经在排队的请求不能被后来的顶掉:那样用户确认的那一通就悄悄换了号码。 */
    @Test fun aSecondArmWhileOneIsPendingIsRefused() {
        val g = gate()
        val first = g.arm("13800138000", "sim-1", task)!!
        assertNull("又来一个请求", g.arm("13900139000", "sim-1", task))
        // 原来那张还能用
        assertTrue(g.poll(first, deviceLocked = true, eligible = true) is LockedDialGate.Decision.Claimed)
    }

    /** 上一个过期之后,新请求可以进。 */
    @Test fun aNewArmIsAllowedOnceTheOldOneExpired() {
        val g = gate()
        g.arm("13800138000", "sim-1", task)!!
        now += 45_001
        assertNotNull("旧请求已过期,新请求该能进", g.arm("13900139000", "sim-1", task))
    }

    @Test fun aCancelledTicketCannotBeClaimed() {
        val g = gate()
        val t = g.arm("13800138000", "sim-1", task)!!
        assertTrue(g.cancel(t))
        assertEquals(LockedDialGate.Decision.Rejected(LockedDialGate.Rejection.NOT_PENDING),
            g.poll(t, deviceLocked = true, eligible = true))
    }

    /** 时钟异常(负数或接近溢出)时宁可不排队。 */
    @Test fun aBrokenClockNeverArms() {
        val g = LockedDialGate { -1L }
        assertNull(g.arm("13800138000", "sim-1", task))
        val huge = LockedDialGate { Long.MAX_VALUE }
        assertNull(huge.arm("13800138000", "sim-1", task))
    }

    /**
     * 认领之后到真正拨出之间系统还要查几样东西,可能把最后的时间耗完。
     * 提交前一定要再看一眼期限和资格。
     */
    @Test fun submissionRechecksTheDeadlineAndEligibility() {
        val g = gate()
        val t = g.arm("13800138000", "sim-1", task)!!
        g.poll(t, deviceLocked = true, eligible = true)
        assertNull("刚刚认领,还有时间", g.submissionRejection(t) { true })
        assertNull("快到期但还够", run { now += 44_000; g.submissionRejection(t) { true } })
        assertEquals("资格没了", LockedDialGate.Rejection.INELIGIBLE, g.submissionRejection(t) { false })
        now += 2_000
        assertEquals("过期了", LockedDialGate.Rejection.EXPIRED, g.submissionRejection(t) { true })
    }

    // ---- 界面上的倒计时 ----

    /**
     * 剩几秒要向上取整,不能向下。
     *
     * 只剩 1 毫秒时显示 0 秒会被读成「已经过期」,但实际还在窗口内——
     * 用户可能因此放弃一次本来能拨的号。
     */
    @Test fun theCountdownRoundsUpSoTheLastMomentStillShowsOne() {
        val expires = 100_000L
        assertEquals("满 45 秒", 45, LockedDialGate.remainingSeconds(expires, expires - 45_000L))
        assertEquals("剩 1.5 秒算 2 秒", 2, LockedDialGate.remainingSeconds(expires, expires - 1_500L))
        assertEquals("剩 1 毫秒也要显示 1 秒,不能显示 0", 1, LockedDialGate.remainingSeconds(expires, expires - 1L))
        assertEquals("刚好到期是 0", 0, LockedDialGate.remainingSeconds(expires, expires))
    }

    /** 过期之后一律 0,不能出现负数——界面上「还剩 -3 秒」会让人困惑。 */
    @Test fun theCountdownNeverGoesNegative() {
        val expires = 100_000L
        assertEquals(0, LockedDialGate.remainingSeconds(expires, expires + 1L))
        assertEquals(0, LockedDialGate.remainingSeconds(expires, expires + 60_000L))
    }

    /** 整秒边界:正好剩 2 秒显示 2,不要因为取整变成 3。 */
    @Test fun wholeSecondsDoNotOvershoot() {
        val expires = 100_000L
        assertEquals(2, LockedDialGate.remainingSeconds(expires, expires - 2_000L))
        assertEquals(1, LockedDialGate.remainingSeconds(expires, expires - 1_000L))
    }
}
