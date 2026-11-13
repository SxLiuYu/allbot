package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 静音租约:AI 接管通话声音期间要把设备麦克风静音(防止 AI 的声音被对方听到混杂),
 * 交还时再恢复用户原来的状态。
 *
 * 这里出错的两个方向都很糟:
 * - 该静音没静音,对方会听到 AI 的语音;
 * - 该恢复没恢复,用户的电话被永久静音,而且用户可能察觉不到。
 */
class TelecomMuteLeaseTest {

    /** 基线:两个来源都说得一致才认,否则根本立不了租约。 */
    @Test fun aLeaseNeedsBothSourcesToAgree() {
        assertNotNull(TelecomMuteLease.fromBaseline(telecomMuted = false, hardwareMuted = false))
        assertNotNull(TelecomMuteLease.fromBaseline(telecomMuted = true, hardwareMuted = true))
        assertNull("两个来源不一致,不知道原来是什么状态", TelecomMuteLease.fromBaseline(false, true))
        assertNull(TelecomMuteLease.fromBaseline(true, false))
        assertNull("读不到 Telecom 状态", TelecomMuteLease.fromBaseline(null, false))
        assertNull(TelecomMuteLease.fromBaseline(false, null))
    }

    /** 原来没静音才需要请求静音;原来就静音了不必再请求。 */
    @Test fun aMuteRequestIsOnlyNeededWhenStartingUnmuted() {
        assertTrue(TelecomMuteLease.fromBaseline(false, false)!!.needsMuteRequest)
        assertFalse("本来就静着", TelecomMuteLease.fromBaseline(true, true)!!.needsMuteRequest)
    }

    /** 只有确实需要请求时才允许标记;重复标记会打断调用方的状态机。 */
    @Test fun markMuteRequestedIsOneShotAndOnlyWhenNeeded() {
        val alreadyMuted = TelecomMuteLease.fromBaseline(true, true)!!
        var threw = false
        try { alreadyMuted.markMuteRequested() } catch (_: IllegalStateException) { threw = true }
        assertTrue("本来不需要请求却允许标记", threw)

        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        var again = false
        try { lease.markMuteRequested() } catch (_: IllegalStateException) { again = true }
        assertTrue("重复标记没被拦住", again)
    }

    /**
     * 请求了静音、Telecom 认了,才算确认。
     * 只要任何一项还没到,就不能认为「已经安全静音」而开始放 AI 的声音。
     */
    @Test fun confirmationRequiresTelecomAndHardwareBothMuted() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        assertFalse("还没请求就不能算确认", lease.isConfirmed(telecomMuted = true, hardwareMuted = true))
        lease.markMuteRequested()
        assertFalse("请求了但 Telecom 还没回", lease.isConfirmed(telecomMuted = null, hardwareMuted = true))
        assertFalse("Telecom 说静了但硬件没静", lease.isConfirmed(telecomMuted = true, hardwareMuted = false))
        assertFalse("Telecom 说没静", lease.isConfirmed(telecomMuted = false, hardwareMuted = true))
        assertFalse("两个都读不到", lease.isConfirmed(null, null))
        // Telecom 回过一次静音,状态机才认
        assertFalse("Telecom 还没回调", lease.observeTelecomMute(true))
        assertTrue("两个都静了", lease.isConfirmed(telecomMuted = true, hardwareMuted = true))
    }

    /**
     * 已经静音之后 Telecom 又说不静了,说明用户或系统把控制权拿回去了。
     * 这时候要交还,而且不能再假装自己在管静音。
     */
    @Test fun theUserTakingBackControlIsDetected() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        assertFalse(lease.observeTelecomMute(true))
        assertTrue("Telecom 又取消静音 = 用户拿回控制权", lease.observeTelecomMute(false))
        assertFalse("交还之后不能再声称已确认", lease.isConfirmed(telecomMuted = true, hardwareMuted = true))
        // 再观察一次不会重复报
        assertFalse(lease.observeTelecomMute(false))
    }

    /** 已经交还之后,后续的静音回调都不该再被当成自己的。 */
    @Test fun observationIsIgnoredAfterRelinquishing() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        lease.observeTelecomMute(true)
        lease.observeTelecomMute(false)   // 交还
        assertFalse(lease.observeTelecomMute(true))
        assertFalse(lease.observeTelecomMute(false))
    }

    // ---- 交还方式 ----

    @Test fun releasePreservesTheOriginalStateWhenNothingWasRequested() {
        val lease = TelecomMuteLease.fromBaseline(true, true)!!
        assertEquals(TelecomMuteLease.Release.PRESERVE, lease.beginRelease(sameCall = true))
    }

    /** 我们请求过静音,还是同一通电话:要主动取消静音。 */
    @Test fun releaseUnmutesWhenWeAskedForItOnTheSameCall() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        assertEquals(TelecomMuteLease.Release.REQUEST_UNMUTE, lease.beginRelease(sameCall = true))
    }

    /** 换了一通电话(原来那通已经结束):只能核对,不能对着新通话发取消静音。 */
    @Test fun releaseOnlyVerifiesOnAnotherCall() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        assertEquals(TelecomMuteLease.Release.VERIFY_UNMUTED, lease.beginRelease(sameCall = false))
    }

    /** 用户中途拿回过控制权:同样只核对。 */
    @Test fun releaseVerifiesOverrideAfterTheUserTookBack() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        lease.observeTelecomMute(true)
        lease.observeTelecomMute(false)
        assertEquals(TelecomMuteLease.Release.VERIFY_OVERRIDE, lease.beginRelease(sameCall = true))
    }

    /** 重复调用 beginRelease 不能第二次发取消静音。 */
    @Test fun beginReleaseIsIdempotentForTheUnmuteRequest() {
        val lease = TelecomMuteLease.fromBaseline(false, false)!!
        lease.markMuteRequested()
        assertEquals(TelecomMuteLease.Release.REQUEST_UNMUTE, lease.beginRelease(sameCall = true))
        assertEquals("第二次就只能核对", TelecomMuteLease.Release.VERIFY_UNMUTED, lease.beginRelease(sameCall = true))
    }

    // ---- 交还后的核对 ----

    @Test fun releaseConfirmationSemantics() {
        // PRESERVE / VERIFY_OVERRIDE:同一通电话要两个来源都读到且一致
        assertTrue(TelecomMuteLease.Release.PRESERVE.confirmed(sameCall = false, telecomMuted = null, hardwareMuted = null))
        assertTrue(TelecomMuteLease.Release.PRESERVE.confirmed(true, true, true))
        assertFalse("读不到就不算确认", TelecomMuteLease.Release.PRESERVE.confirmed(true, null, true))
        assertFalse("两个不一致", TelecomMuteLease.Release.PRESERVE.confirmed(true, true, false))
        // REQUEST_UNMUTE / VERIFY_UNMUTED:硬件必须明确是「没静音」
        assertTrue(TelecomMuteLease.Release.REQUEST_UNMUTE.confirmed(true, false, false))
        assertFalse("硬件还静着", TelecomMuteLease.Release.REQUEST_UNMUTE.confirmed(true, false, true))
        assertFalse("硬件读不到", TelecomMuteLease.Release.REQUEST_UNMUTE.confirmed(true, false, null))
        // 已经不是同一通了,只要硬件没静音就算
        assertTrue(TelecomMuteLease.Release.REQUEST_UNMUTE.confirmed(false, null, false))
    }

    // ---- 静音状态去重 ----

    /**
     * Android 14+ 有专门的静音回调,之后来的旧式音频快照不该覆盖它。
     * 覆盖的后果是静音状态在两个来源间来回弹。
     */
    @Test fun theLegacySnapshotIsIgnoredOnceTheDedicatedCallbackIsLive() {
        val s = TelecomMuteState(dedicatedMuteCallback = true)
        assertNull("初始是未知,不是 false", s.value)
        assertEquals(TelecomMuteState.Update.CHANGED, s.update(TelecomMuteState.Source.MUTE_CALLBACK, true))
        assertTrue(s.value!!)
        // 旧式快照来说没静音:忽略
        assertEquals(TelecomMuteState.Update.IGNORED_LEGACY, s.update(TelecomMuteState.Source.LEGACY_AUDIO, false))
        assertTrue("被旧快照改了", s.value!!)
        // 重复的同一个值不算变化
        assertEquals(TelecomMuteState.Update.DUPLICATE, s.update(TelecomMuteState.Source.MUTE_CALLBACK, true))
    }

    /** 没有专门回调时(旧系统),旧式快照就是唯一来源,必须认。 */
    @Test fun theLegacySnapshotIsAuthoritativeWithoutADedicatedCallback() {
        val s = TelecomMuteState(dedicatedMuteCallback = false)
        assertEquals(TelecomMuteState.Update.CHANGED, s.update(TelecomMuteState.Source.LEGACY_AUDIO, true))
        assertEquals(TelecomMuteState.Update.CHANGED, s.update(TelecomMuteState.Source.LEGACY_AUDIO, false))
        assertFalse(s.value!!)
    }

    /** 还没收到任何值的时候,旧式快照即使有专门回调也该被采纳作为初值。 */
    @Test fun theLegacySnapshotSeedsTheInitialValue() {
        val s = TelecomMuteState(dedicatedMuteCallback = true)
        assertEquals(TelecomMuteState.Update.CHANGED, s.update(TelecomMuteState.Source.LEGACY_AUDIO, true))
        assertTrue(s.value!!)
    }

    @Test fun resetForgetsTheValue() {
        val s = TelecomMuteState(dedicatedMuteCallback = false)
        s.update(TelecomMuteState.Source.LEGACY_AUDIO, true)
        s.reset()
        assertNull(s.value)
    }

    // ---- 诊断文案 ----

    /**
     * 内置助手的原始报错要映射成固定的中文说明。白名单之外的一律不返回,
     * 这样原始 shell 字符串不会漏到用户眼前(里面可能有路径、设备名)。
     */
    @Test fun knownShellOutcomesMapToFixedChinese() {
        assertEquals("设备麦克风静音已解除，AI 已交还通话", shellAudioStopDiagnostic("Handset microphone was unmuted."))
        assertEquals("运营商通话音频模式已结束，电话由系统处理", shellAudioStopDiagnostic("Cellular audio mode ended."))
        assertEquals("运营商通话音频模式已结束，电话由系统处理", shellAudioStopDiagnostic("Cellular audio ended."))
        assertEquals("安卓停止向 AI 提供通话声音，已交还系统", shellAudioStopDiagnostic("Android silenced the cellular audio capture."))
        assertEquals("内置助手已释放电话音频，电话由系统处理", shellAudioStopDiagnostic("Helper released."))
        assertEquals("内置助手已释放电话音频，电话由系统处理", shellAudioStopDiagnostic("Call audio owner died."))
    }

    @Test fun prefixedOutcomesMapByPrefix() {
        assertEquals("设备无法读取运营商下行音频，电话由系统处理", shellAudioStopDiagnostic("Downlink read failed (5)"))
        assertEquals("设备无法写入运营商上行音频，电话由系统处理", shellAudioStopDiagnostic("Uplink write failed (7)"))
        assertEquals("设备无法清空运营商上行音频，电话由系统处理", shellAudioStopDiagnostic("Uplink flush failed: timeout"))
        assertEquals("设备上行未路由至运营商通话，电话由系统处理",
            shellAudioStopDiagnostic("Uplink did not route to the telephony device (2)"))
        assertEquals("设备下行未路由至运营商通话，电话由系统处理",
            shellAudioStopDiagnostic("Downlink unexpectedly routed to device type 3"))
    }

    /** 白名单之外:不返回任何东西,原始字符串不外泄。 */
    @Test fun unknownShellOutputNeverLeaksThrough() {
        for (raw in listOf(
            "/data/local/tmp/some/path: permission denied",
            "com.example.app crashed",
            "random stuff",
            "",
            "   ",
        )) {
            val d = shellAudioStopDiagnostic(raw)
            if (raw.isNotBlank()) assertNull("不该把原文回给用户: [$raw] -> $d", d)
        }
        assertNull("null 进 null 出", shellAudioStopDiagnostic(null))
    }
}
