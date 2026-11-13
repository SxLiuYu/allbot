package com.wangzan101.mika.core.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StallDetectorTest {
    private var t = 0L
    private var n = 0
    /** [fp] 省略时每步用一个新指纹(只看别的条件)。[page] 是那页上的文字哈希,判「回到同一页」用它。[fresh] 是这页上新字的个数。 */
    private fun step(fp: Long = -1, changed: Boolean? = null, tool: String = "phone_tap", ok: Boolean = true,
                     error: String? = null, observed: Long = 0, waiting: Boolean = false, args: Long? = null,
                     place: String? = null, page: Long? = null, fresh: Int? = null, ready: Boolean = true): ProgressSignal {
        val id = ++n
        return ProgressSignal(step = id, screenFingerprint = if (fp < 0) id.toLong() else fp, observedHash = observed,
            tool = tool, ok = ok, errorCode = error, changed = changed, atMs = t, waiting = waiting, argsHash = args, place = place,
            pageTextHash = page, newWords = fresh, ready = ready)
    }

    @Test fun sameScreenNudgesOnceThenStops() {
        val d = StallDetector()
        // 第一屏只是基线;之后连续 5 步一样才算
        repeat(5) { assertEquals(ProgressDecision.Continue, d.onStep(step(1))) }
        // 第 6 次:先说一次
        val nudge = d.onStep(step(1))
        assertTrue(nudge is ProgressDecision.Nudge)
        assertTrue((nudge as ProgressDecision.Nudge).reasons.single().contains("同一屏"))
        // 又连续 5 次才收尾
        repeat(4) { assertEquals(ProgressDecision.Continue, d.onStep(step(1))) }
        assertEquals(ProgressDecision.Stop("stall", "partial"), d.onStep(step(1)))
    }

    @Test fun screenChangeResetsTheStreak() {
        val d = StallDetector()
        repeat(3) { d.onStep(step(1)) }
        d.onStep(step(2))
        repeat(3) { assertEquals(ProgressDecision.Continue, d.onStep(step(2))) }
    }

    @Test fun waitingDoesNotCountAsNoProgress() {
        val d = StallDetector()
        repeat(20) { assertEquals(ProgressDecision.Continue, d.onStep(step(9, waiting = true))) }
    }

    @Test fun manyStepsWithoutAChangeGetNudgedThenStopped() {
        val d = StallDetector()
        repeat(14) { d.onStep(step(changed = false)) }
        assertTrue(d.onStep(step(changed = false)) is ProgressDecision.Nudge)
        repeat(14) { d.onStep(step(changed = false)) }
        assertEquals(ProgressDecision.Stop("no_change", "not_possible"), d.onStep(step(changed = false)))
    }

    @Test fun aChangeResetsTheNoChangeCounter() {
        val d = StallDetector()
        repeat(10) { d.onStep(step(changed = false)) }
        d.onStep(step(changed = true))
        repeat(10) { assertEquals(ProgressDecision.Continue, d.onStep(step(changed = false))) }
    }

    @Test fun sameErrorThreeTimesSwitchesPath() {
        val d = StallDetector()
        fun failing() = d.onStep(step(tool = "phone_tap", ok = false, error = "element_not_found"))
        failing(); failing()
        val nudge = failing()
        assertTrue((nudge as ProgressDecision.Nudge).reasons.single().contains("换一条路"))
        repeat(2) { failing() }
        assertEquals(ProgressDecision.Stop("error_streak", "not_possible"), failing())
    }

    @Test fun differentOrSuccessfulCallsBreakTheErrorStreak() {
        val d = StallDetector()
        fun failing() = d.onStep(step(tool = "phone_tap", ok = false, error = "element_not_found"))
        failing(); failing()
        d.onStep(step(tool = "phone_tap"))
        failing(); failing()
        assertTrue(failing() is ProgressDecision.Nudge)
    }

    @Test fun sameErrorWithDifferentArgumentsIsNotARepeat() {
        val d = StallDetector()
        repeat(3) { i -> assertTrue(d.onStep(step(tool = "phone_system_command", ok = false, error = "command_failed", args = i.toLong())) !is ProgressDecision.Stop) }
    }

    // 「有进展但一直在原地打转」:每步都在动、界面一直在变,前三条全不触发,只能靠「回到同一页」看出来。
    // 余额宝那条:进了三次余额宝、点了五次同一个关不掉的弹窗,45 步 204 秒,前三条一次没响。
    // 页面按那页的文字认,不按元素的 bounds:后者滚动一下就变,同一页会被当成不同页
    // (笔记那条列表页出现 9 次,屏指纹一次都没重复)。
    @Test fun revisitingTheSamePageNudgesThenStops() {
        val d = StallDetector()
        var nudgeAt = -1
        var stop: ProgressDecision? = null
        // 列表页(文字哈希 1)↔ 详情页(2)来回走;屏指纹每步都不同(像滚动过),文字没变
        for (i in 0 until 24) {
            val decision = d.onStep(step(fp = (i + 50).toLong(), changed = true, place = "com.miui.notes", page = if (i % 2 == 0) 1L else 2L))
            if (decision is ProgressDecision.Nudge) { assertEquals(-1, nudgeAt); nudgeAt = i }
            if (decision is ProgressDecision.Stop) { stop = decision; break }
        }
        // 第 3 次回到同一页(i = 6)先说一次,不立刻收尾
        assertEquals(6, nudgeAt)
        assertEquals(ProgressDecision.Stop("revisit", "partial"), stop)
        assertTrue(d.stoppedButCanStillAnswer)
    }

    @Test fun stayingOnOnePageIsNotARevisit() {
        val d = StallDetector()
        // 一直在同一页做事:相邻每步都在同一处,不算「回到」
        repeat(20) { assertEquals(ProgressDecision.Continue, d.onStep(step(fp = 7L, changed = true, place = "com.android.fileexplorer", page = 9L))) }
    }

    @Test fun differentPagesAreNotRevisits() {
        val d = StallDetector()
        // 一路往前走,每次都是新页面
        repeat(20) { i -> assertEquals(ProgressDecision.Continue, d.onStep(step(fp = (i + 100).toLong(), changed = true, place = "com.miui.notes", page = (i + 200).toLong()))) }
    }

    // 同一个 App 里来回翻:place 全程不变,要按页面的文字才看得出来
    @Test fun revisitsInsideOneAppAreCaught() {
        val d = StallDetector()
        var stopped = false
        for (i in 0 until 24) {
            // 列表页(1)↔ 文件夹页(2)↔ 待办页(3),全程都在 com.miui.notes
            val page = listOf(1L, 2L, 1L, 3L)[i % 4]
            if (d.onStep(step(fp = (i + 300).toLong(), changed = true, place = "com.miui.notes", page = page)) is ProgressDecision.Stop) { stopped = true; break }
        }
        assertTrue(stopped)
    }

    // 比「回到同一页」更细的一种打转:页面一直换,但每个新页上的字都是看过的。
    // 笔记那条就是这样找搜索框的——换页 24 次,每次读到的还是那三篇笔记和那几个标签。
    @Test fun pagesWithNoNewTextAreCaught() {
        val d = StallDetector()
        var nudgeAt = -1
        var stop: ProgressDecision? = null
        // 每步都是新页面(指纹不同),但一个新字都没有
        for (i in 0 until 20) {
            val decision = d.onStep(step(fp = (i + 400).toLong(), changed = true, place = "com.miui.notes", page = (i + 500).toLong(), fresh = 0))
            if (decision is ProgressDecision.Nudge) { if (nudgeAt < 0) nudgeAt = i }
            if (decision is ProgressDecision.Stop) { stop = decision; break }
        }
        assertEquals(4, nudgeAt) // 第 5 步先说一次
        assertEquals(ProgressDecision.Stop("no_new_info", "partial"), stop)
        assertTrue(d.stoppedButCanStillAnswer)
    }

    @Test fun pagesWithNewTextKeepsGoing() {
        val d = StallDetector()
        // 每步都有新内容:正常往下翻,不该提醒
        repeat(20) { i ->
            assertTrue(d.onStep(step(fp = (i + 600).toLong(), changed = true, page = (i + 700).toLong(), fresh = 3)) !is ProgressDecision.Stop)
        }
    }

    @Test fun aFreshPageResetsTheNoNewInfoStreak() {
        val d = StallDetector()
        repeat(4) { i -> d.onStep(step(fp = (i + 800).toLong(), changed = true, page = (i + 900).toLong(), fresh = 0)) }
        // 第 5 步来了新内容:之前的连续空转清零,不该因为前面 4 步就提醒
        assertEquals(ProgressDecision.Continue, d.onStep(step(fp = 850L, changed = true, page = 950L, fresh = 2)))
        repeat(3) { i -> assertTrue(d.onStep(step(fp = (i + 860).toLong(), changed = true, page = (i + 960).toLong(), fresh = 0)) !is ProgressDecision.Stop) }
    }

    // 「同一个只读工具换着法子问同一件事」:每步参数都不同、都成功,前几条一条都拦不住。
    // 录音机那条连发 11 次 shell 查「现在是不是在录音」,每次换一个角度,17 次模型调用
    // 花掉 48 万 token,答案只是一个是非题。
    @Test fun repeatedReadOnlyProbesAreCaught() {
        val d = StallDetector()
        var nudgeAt = -1
        var stop: ProgressDecision? = null
        for (i in 0 until 16) {
            // 每次参数都不同(换一个查法),每步都是新页面,都成功
            val decision = d.onStep(step(fp = (i + 1000).toLong(), changed = null, tool = "phone_system_command",
                args = i.toLong(), page = (i + 1100).toLong(), fresh = 2))
            if (decision is ProgressDecision.Nudge && nudgeAt < 0) nudgeAt = i
            if (decision is ProgressDecision.Stop) { stop = decision; break }
        }
        // 第 6 步先说一次
        assertEquals(5, nudgeAt)
        assertEquals(ProgressDecision.Stop("probe_loop", "partial"), stop)
        assertTrue(d.stoppedButCanStillAnswer)
    }

    // 连续点击是正常操作(列表里挨个点),不能算「换着法子问」
    @Test fun repeatedTapsAreNotProbes() {
        val d = StallDetector()
        repeat(20) { i ->
            assertTrue(d.onStep(step(fp = (i + 1200).toLong(), changed = true, tool = "phone_tap",
                args = i.toLong(), page = (i + 1300).toLong(), fresh = 2)) !is ProgressDecision.Stop)
        }
    }

    /**
     * 反复查通话状态也要算探针。
     *
     * phone_call_state 是纯读(Risk.Read、不写日志、只调 port.state()),和
     * phone_system_command 同类。接入通话功能时漏了它:实测一轮里被调了 8 次,
     * 这条规则一次都没管过。
     */
    @Test fun repeatedCallStateChecksAreProbes() {
        val d = StallDetector()
        var nudgeAt = -1
        var stop: ProgressDecision? = null
        for (i in 0 until 16) {
            val decision = d.onStep(step(fp = (i + 1400).toLong(), changed = null, tool = "phone_call_state",
                args = i.toLong(), page = (i + 1500).toLong(), fresh = 2))
            if (decision is ProgressDecision.Nudge && nudgeAt < 0) nudgeAt = i
            if (decision is ProgressDecision.Stop) { stop = decision; break }
        }
        assertEquals("第 6 次要提醒", 5, nudgeAt)
        assertEquals(ProgressDecision.Stop("probe_loop", "partial"), stop)
    }

    /** 但挂断/拨号/接听不是只读,不能算探针——它们真的改设备状态。 */
    @Test fun callControlActionsAreNotProbes() {
        for (tool in listOf("phone_call_dial", "phone_call_answer", "phone_call_hangup", "phone_call_takeover")) {
            val fresh = StallDetector()
            repeat(16) { i ->
                assertTrue(
                    "$tool 不该被当成只读探针",
                    fresh.onStep(step(fp = (i + 1600).toLong(), changed = null, tool = tool,
                        args = i.toLong(), page = (i + 1700).toLong(), fresh = 2)) !is ProgressDecision.Stop,
                )
            }
        }
    }

    // 换了工具就不再是「同一个只读工具」;读屏内容确实有新东西时也不该拦
    @Test fun switchingToolsOrACloserLookResetsProbeCount() {
        val d = StallDetector()
        repeat(4) { i -> d.onStep(step(tool = "phone_system_command", args = i.toLong(), changed = true)) }
        assertEquals(ProgressDecision.Continue, d.onStep(step(tool = "phone_observe", args = 99L, changed = true)))
        repeat(4) { i -> assertTrue(d.onStep(step(tool = "phone_system_command", args = (i + 200).toLong(), changed = true)) !is ProgressDecision.Stop) }
    }

    // 报错的不算:那是另一条规则(同一条错误)管的
    @Test fun failedProbesAreNotCountedHere() {
        val d = StallDetector(errorLimit = 99)
        repeat(10) { i ->
            assertTrue(d.onStep(step(tool = "phone_system_command", ok = false, error = "command_failed", args = i.toLong())) !is ProgressDecision.Stop)
        }
    }

    @Test fun budgetStopsAtEachLimit() {        val d = StallDetector(TaskBudget(maxSteps = 80, maxWallMs = 60_000, maxInputTokens = 1_000))
        assertEquals(ProgressDecision.Continue, d.checkBudget(80, 59_000, 999))
        assertEquals(ProgressDecision.Stop("budget_steps", "not_possible"), d.checkBudget(81, 0, 0))
        assertEquals(ProgressDecision.Stop("budget_time", "not_possible"), d.checkBudget(1, 60_001, 0))
        assertEquals(ProgressDecision.Stop("budget_tokens", "not_possible"), d.checkBudget(1, 0, 1_001))
    }

    @Test fun resetStartsOver() {
        val d = StallDetector()
        repeat(4) { d.onStep(step(1)) }
        d.reset()
        repeat(4) { assertEquals(ProgressDecision.Continue, d.onStep(step(1))) }
    }
}
