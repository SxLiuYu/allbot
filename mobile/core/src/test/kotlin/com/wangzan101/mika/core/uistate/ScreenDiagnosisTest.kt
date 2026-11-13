package com.wangzan101.mika.core.uistate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenDiagnosisTest {
    private fun facts(
        hasWindow: Boolean = true, readable: Int = 10, changing: Boolean = false, black: List<Boolean> = listOf(false, false),
        texts: List<String> = listOf("设置", "WLAN"), password: Boolean = false,
    ) = ScreenFacts("com.x", hasWindow, readable, changing, black, texts, password)

    @Test fun normalScreen() {
        val c = ScreenDiagnosis.classify(facts())
        assertEquals(ScreenState.NORMAL, c.state); assertFalse(c.needsHuman)
    }

    @Test fun blankWithoutWindowOrElements() {
        assertEquals(ScreenState.BLANK, ScreenDiagnosis.classify(facts(hasWindow = false, readable = 0, black = emptyList())).state)
        val c = ScreenDiagnosis.classify(facts(readable = 0, texts = emptyList()))
        assertEquals(ScreenState.BLANK, c.state); assertFalse(c.needsHuman)
    }

    @Test fun unreadableWindowIsNotNoWindow() {
        val none = ScreenFacts(null, false, 0, false, emptyList(), emptyList(), false, anyWindow = false)
        assertEquals(ScreenDiagnosis.NO_WINDOW, ScreenDiagnosis.classify(none).cause)
        assertEquals(ScreenDiagnosis.UNREADABLE_WINDOW, ScreenDiagnosis.classify(none.copy(anyWindow = true)).cause)
    }

    @Test fun blackFrameWithWindowIsProtected() {
        val c = ScreenDiagnosis.classify(facts(black = listOf(true, true)))
        assertEquals(ScreenState.PROTECTED, c.state); assertTrue(c.needsHuman); assertEquals("other", c.takeoverReason)
        assertEquals("payment", ScreenDiagnosis.classify(facts(black = listOf(true, true), texts = listOf("确认支付"))).takeoverReason)
        assertEquals("captcha", ScreenDiagnosis.classify(facts(black = listOf(true, true), texts = listOf("安全验证"))).takeoverReason)
        assertEquals("login", ScreenDiagnosis.classify(facts(black = listOf(true, true), password = true)).takeoverReason)
        // 没有窗口时的黑屏只是空白
        assertEquals(ScreenState.BLANK, ScreenDiagnosis.classify(facts(hasWindow = false, readable = 0, black = listOf(true, true))).state)
    }

    @Test fun oneBlackFrameIsNotProtected() {
        assertEquals(ScreenState.NORMAL, ScreenDiagnosis.classify(facts(black = listOf(true))).state)
        assertEquals(ScreenState.NORMAL, ScreenDiagnosis.classify(facts(black = listOf(false, true))).state)
    }

    @Test fun blackWhileChangingIsLoading() {
        val c = ScreenDiagnosis.classify(facts(changing = true, black = listOf(true, true)))
        assertEquals(ScreenState.LOADING, c.state); assertFalse(c.needsHuman)
    }

    @Test fun changingScreenIsLoading() {
        val c = ScreenDiagnosis.classify(facts(changing = true))
        assertEquals(ScreenState.LOADING, c.state); assertFalse(c.needsHuman)
    }

    @Test fun humanOnlyPages() {
        assertEquals("captcha", ScreenDiagnosis.classify(facts(texts = listOf("请拖动滑块完成安全验证"))).takeoverReason)
        assertEquals("payment", ScreenDiagnosis.classify(facts(texts = listOf("请输入支付密码"))).takeoverReason)
        assertEquals("login", ScreenDiagnosis.classify(facts(password = true)).takeoverReason)
        assertEquals("login", ScreenDiagnosis.classify(facts(texts = listOf("手机号", "获取验证码"))).takeoverReason)
        assertTrue(ScreenDiagnosis.classify(facts(texts = listOf("Verify you are human"))).needsHuman)
        // 普通设置页里的「密码」字样不算
        assertFalse(ScreenDiagnosis.classify(facts(texts = listOf("密码与安全", "隐私"))).needsHuman)
    }

    /**
     * 浏览器自己说连不上网时判 offline:屏上控件照常在,不判出来模型就会反复点返回、改地址重输。
     * 这句要真出现在 2026-11-04 那次运行里(Chrome 打不开支付宝官网,第 10 步到第 16 步空转)。
     */
    @Test fun networkErrorPageIsOfflineNotNormal() {
        val chrome = listOf("Web View", "No internet connection", "Open the home page", "alipay.com")
        val c = ScreenDiagnosis.classify(facts(texts = chrome))
        assertEquals(ScreenState.OFFLINE, c.state)
        assertFalse(c.needsHuman)
        assertTrue(c.cause.orEmpty().contains("no internet connection"))
        // 各家的原话都认
        for (text in listOf("未连接到互联网", "ERR_INTERNET_DISCONNECTED", "无法访问此网站", "Check your internet connection")) {
            assertEquals(text, ScreenState.OFFLINE, ScreenDiagnosis.classify(facts(texts = listOf(text))).state)
        }
        // App 里一次请求失败的一句话不算整屏断网:这类页面还能刷新救回来
        assertEquals(ScreenState.NORMAL, ScreenDiagnosis.classify(facts(texts = listOf("网络异常，请稍后重试"))).state)
        assertEquals(ScreenState.NORMAL, ScreenDiagnosis.classify(facts(texts = listOf("加载失败：网络错误，点击重试"))).state)
        // 还在变(页面正加载)时先按加载中,不急着下结论
        assertEquals(ScreenState.LOADING, ScreenDiagnosis.classify(facts(changing = true, texts = chrome)).state)
        // 登录、验证码这类要人处理的优先,不被这句盖过去
        assertEquals("login", ScreenDiagnosis.classify(facts(texts = chrome + "获取验证码")).takeoverReason)
    }

    /**
     * 屏幕上自己说连不上网:读屏和动作结果都要当场说,不能只把这句话埋在元素名里。
     * 2026-11-04 那次运行里,它在四次动作结果的元素名里各出现一次,模型仍然点返回、改地址重输,
     * 到第 16 步才放弃——判定是对的,但模型从没被提醒过。
     */
    @Test fun offlineTextComesFromTheScreenItself() {
        fun snap(vararg names: String) = ScreenSnapshot(
            "p1", "com.android.chrome",
            names.mapIndexed { i, n -> UiElement("@e${i + 1}", "TextView", n, 500, 100, listOf(0, 0, 10, 10), null, false, false, false) },
            1080, 2400,
        )
        assertEquals("no internet connection", ScreenDiagnosis.offlineText(snap("Web View", "No internet connection", "alipay.com")))
        assertEquals("未连接到互联网", ScreenDiagnosis.offlineText(snap("未连接到互联网")))
        // 错误码也在:Chrome 的离线页把 ERR_ 码单独作为一行
        assertEquals("err_internet_disconnected", ScreenDiagnosis.offlineText(snap("ERR_INTERNET_DISCONNECTED")))
        // 普通页面没有这句
        assertNull(ScreenDiagnosis.offlineText(snap("设置", "WLAN")))
        // App 里一次请求失败弹的一句话不算整屏断网:按它停下会把本来能救回的任务判死
        assertNull(ScreenDiagnosis.offlineText(snap("网络异常，请稍后重试")))
        assertNull(ScreenDiagnosis.offlineText(snap("加载失败：网络错误，点击重试")))
        assertNull(ScreenDiagnosis.offlineText(snap("请检查网络连接后刷新")))
        // 页面还在变、受保护、没窗口时不下结论:加载中的过渡页也可能短暂挂着这句
        assertNull(ScreenDiagnosis.offlineText(snap("No internet connection").copy(changedDuringRead = true)))
        assertNull(ScreenDiagnosis.offlineText(snap("No internet connection").copy(protected = true)))
        assertNull(ScreenDiagnosis.offlineText(snap("No internet connection").copy(hasWindow = false)))
    }
}
