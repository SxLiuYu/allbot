package com.wangzan101.mika.calls

import java.util.UUID

/** Process-local authorization for one confirmed outgoing call after the device is securely locked. */
internal class LockedDialGate(private val nowMs: () -> Long) {
    class Ticket internal constructor(val id: String, val expiresAtMs: Long)

    class Request internal constructor(val number: String, val simId: String, val task: CallTaskBrief) {
        override fun toString(): String = "LockedDialRequest"
    }

    enum class Rejection { NOT_PENDING, EXPIRED, INELIGIBLE }

    sealed interface Decision {
        data object WaitingForLock : Decision
        data class Claimed(val request: Request) : Decision
        data class Rejected(val reason: Rejection) : Decision
    }

    private class Pending(val ticket: Ticket, val request: Request, val armedAtMs: Long) {
        fun withinWindow(now: Long): Boolean = now >= armedAtMs && now < ticket.expiresAtMs
    }

    private var pending: Pending? = null

    /** Called only after user confirmation. Reject unresolved/default SIM choices and overlapping requests. */
    @Synchronized
    fun arm(number: String, simId: String, task: CallTaskBrief): Ticket? {
        val now = nowMs()
        if (pending?.withinWindow(now) == true) return null
        pending = null
        if (now < 0L || now > Long.MAX_VALUE - WAIT_MS) return null
        val normalized = CallPolicy.outgoingNumber(number) ?: return null
        if (!CallPolicy.isRememberedSimId(simId)) return null
        val snapshot = try {
            task.validatedSnapshot()
        } catch (_: IllegalArgumentException) {
            return null
        }
        val ticket = Ticket(UUID.randomUUID().toString(), now + WAIT_MS)
        pending = Pending(ticket, Request(normalized, simId, snapshot), now)
        return ticket
    }

    /** The same ticket cannot be claimed twice. Unknown lock/eligibility must be treated as ineligible. */
    @Synchronized
    fun poll(ticket: Ticket, deviceLocked: Boolean, eligible: Boolean): Decision {
        val current = pending?.takeIf { it.ticket === ticket }
            ?: return Decision.Rejected(Rejection.NOT_PENDING)
        if (!current.withinWindow(nowMs())) {
            pending = null
            return Decision.Rejected(Rejection.EXPIRED)
        }
        if (!eligible) {
            pending = null
            return Decision.Rejected(Rejection.INELIGIBLE)
        }
        if (!deviceLocked) return Decision.WaitingForLock
        // Clear first. The runtime still rechecks the deadline, lock, eligibility and SIM at the Telecom call site.
        pending = null
        return Decision.Claimed(current.request)
    }

    /** After claim, system queries can consume the last milliseconds of the owner's window. */
    fun submissionRejection(ticket: Ticket, stillEligible: () -> Boolean): Rejection? {
        if (nowMs() >= ticket.expiresAtMs) return Rejection.EXPIRED
        if (!stillEligible()) return Rejection.INELIGIBLE
        return Rejection.EXPIRED.takeIf { nowMs() >= ticket.expiresAtMs }
    }

    @Synchronized
    fun cancel(ticket: Ticket): Boolean {
        if (pending?.ticket !== ticket) return false
        pending = null
        return true
    }

    companion object {
        private const val WAIT_MS = 45_000L

        /**
         * 还剩几秒,给界面上的倒计时用。
         *
         * 向上取整:只剩 1 毫秒也要显示「1 秒」而不是「0 秒」。显示 0 会被读成
         * 「已经过期」,而实际还在窗口内——用户可能因此放弃一次本来能成功的拨号。
         * 反过来,过期之后一律显示 0,不能出现负数。
         *
         * 放在这里是为了能测:原来是 CallRuntime 的私有函数,绑在 Android 上。
         */
        fun remainingSeconds(expiresAtMs: Long, nowMs: Long): Int =
            ((expiresAtMs - nowMs).coerceAtLeast(0L) + 999L).div(1_000L).toInt()
    }
}
