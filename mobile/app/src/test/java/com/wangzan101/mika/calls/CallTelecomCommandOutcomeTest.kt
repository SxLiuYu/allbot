package com.wangzan101.mika.calls

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 用 shell 改通话管理权限之后,怎么判断那条命令到底成没成。
 *
 * 这是「电话伴侣模式」能不能开起来的第一道关。三种结果要分清,
 * 因为它们给用户的下一步完全不同:
 *
 *   OK                 命令成功(还不算数,prepare() 会再回读一次确认)
 *   SHELL_APP_OPS_DENIED  ADB 自己被限权,缺 MANAGE_APP_OPS_MODES
 *                        → 换命令、重试、换 USB 都没用,这条路封死了
 *   FAILED              命令失败,原因不明 → 可能是设备忙、参数错,值得再试
 *
 * 把后两者混在一起,用户会一直重试一条注定失败的路径。
 */
class CallTelecomCommandOutcomeTest {

    private fun classify(exitCode: Int, output: String) =
        CallTelecomCommandOutcome.classify(exitCode, output)

    @Test fun aCleanRunIsOk() {
        assertEquals(CallTelecomCommandOutcome.OK, classify(0, ""))
        assertEquals(CallTelecomCommandOutcome.OK, classify(0, "  \n "))
    }

    /** 缺 MANAGE_APP_OPS_MODES 是单独的结局,不能算普通失败。 */
    @Test fun theShellLackingAppOpsIsItsOwnOutcome() {
        val real = "java.lang.SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES"
        assertEquals(CallTelecomCommandOutcome.SHELL_APP_OPS_DENIED, classify(0, real))
        assertEquals("就算退出码是 0 也要认出来", CallTelecomCommandOutcome.SHELL_APP_OPS_DENIED, classify(0, real))
        assertEquals("退出码非 0 同时带这段,仍算被限权", CallTelecomCommandOutcome.SHELL_APP_OPS_DENIED, classify(1, real))
    }

    /** 不带 java.lang. 前缀、大小写不同、前面有空格,都要认。 */
    @Test fun theAppOpsDenialIsRecognizedInItsVariants() {
        for (text in listOf(
            "SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES",
            "  java.lang.SecurityException:  uid   2000   does not have   android.permission.MANAGE_APP_OPS_MODES",
            "JAVA.LANG.SECURITYEXCEPTION: UID 2000 DOES NOT HAVE ANDROID.PERMISSION.MANAGE_APP_OPS_MODES",
        )) {
            assertEquals("没认出来: ${text.take(50)}", CallTelecomCommandOutcome.SHELL_APP_OPS_DENIED, classify(1, text))
        }
    }

    /** 别的 SecurityException(比如缺别的权限)不算这一种,应当是普通失败。 */
    @Test fun aDifferentSecurityExceptionIsJustAFailure() {
        val other = "java.lang.SecurityException: uid 2000 does not have android.permission.WRITE_SECURE_SETTINGS"
        assertEquals(CallTelecomCommandOutcome.FAILED, classify(1, other))
    }

    @Test fun aNonZeroExitIsAFailure() {
        assertEquals(CallTelecomCommandOutcome.FAILED, classify(1, ""))
        assertEquals(CallTelecomCommandOutcome.FAILED, classify(255, ""))
    }

    /** 退出码 0 但输出里有错误字样,也不能当成功。 */
    @Test fun errorTextOnStdoutMeansFailure() {
        for (text in listOf(
            "Error: unknown op MANAGE_ONGOING_CALLS",
            "unknown command: appops",
            "Exception in thread main",
            "permission denial",
            "command[1]: error something",
        )) {
            assertEquals("没认出错误: $text", CallTelecomCommandOutcome.FAILED, classify(0, text))
        }
    }

    /**
     * 两条提示不能互相顶替:SHELL_APP_OPS_DENIED 要明说「ADB 被限制」,
     * 让用户别再试;FAILED 是泛泛的「未授予」。
     */
    @Test fun theTwoFailuresGiveDifferentAdvice() {
        val denied = CallTelecomCommandOutcome.SHELL_APP_OPS_DENIED.appOpsFailureMessage
        val failed = CallTelecomCommandOutcome.FAILED.appOpsFailureMessage
        assertEquals(true, denied.contains("ADB"))
        assertEquals(true, denied.contains("MANAGE_APP_OPS_MODES"))
        assertEquals("两条提示不能一样,否则用户分不清该不该重试", false, denied == failed)
    }
}
