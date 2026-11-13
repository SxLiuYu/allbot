package com.wangzan101.mika.core.uistate

enum class ScreenState(val wire: String) {
    NORMAL("normal"),
    /** 没有窗口或没有可读元素。 */
    BLANK("blank"),
    /** 界面在持续变化,还没加载完。 */
    LOADING("loading"),
    /** 防截屏页面:画面全黑但有窗口。 */
    PROTECTED("protected"),
    /** 登录、验证码、支付等需要用户亲自处理的页面。 */
    NEEDS_HUMAN("needs_human"),
    /** 屏上明说连不上网:再点、再输地址都打不开,重试没有意义。 */
    OFFLINE("offline"),
}

/**
 * [takeoverReason] 是建议 hand_to_user 使用的 reason;[cause] 是判定依据的简短说明。
 * 例外:[ScreenDiagnosis.UNSUPPORTED_BROWSER](网站拒绝内置浏览器)不需要人,state 为 NORMAL、needsHuman 为 false,该换路线。
 */
data class ScreenCheck(
    val state: ScreenState,
    val currentApp: String?,
    val needsHuman: Boolean,
    val takeoverReason: String? = null,
    val cause: String? = null,
)

/**
 * 端口采集到的事实。[blackFrames] 是每次界面安静时画面是否全黑的结果,按时间顺序;拿不到画面时为空。
 * [hasWindow] 是有读得到根节点的 App 窗口;[anyWindow] 是有 App 窗口(根节点读不到也算)。
 * [foregroundApp] 是窗口读不到时按焦点窗口或最上面的任务得知的前台 App;不知道为 null。
 */
data class ScreenFacts(
    val currentApp: String?,
    val hasWindow: Boolean,
    val readableElements: Int,
    val changing: Boolean,
    val blackFrames: List<Boolean>,
    val texts: List<String>,
    val passwordField: Boolean,
    val anyWindow: Boolean = hasWindow,
    val foregroundApp: String? = null,
)

object ScreenDiagnosis {
    /** 屏上一个 App 窗口都没有(虚拟屏刚建好时就是这样)。 */
    const val NO_WINDOW = "no window"
    const val UNREADABLE_WINDOW = "unreadable window"
    /** 网页:网站不支持内置浏览器(要求换浏览器或下载 App)。 */
    const val UNSUPPORTED_BROWSER = "unsupported_browser"

    private val CAPTCHA = listOf(
        "captcha", "人机验证", "安全验证", "滑块验证", "拖动滑块", "向右滑动完成", "请完成验证", "verify you are human", "not a robot",
    )
    private val PAYMENT = listOf(
        "支付密码", "确认支付", "确认付款", "立即支付", "输入密码支付", "payment password", "confirm payment", "pay now",
    )
    private val SMS_CODE = listOf(
        "获取验证码", "发送验证码", "短信验证码", "get code", "send code", "verification code",
    )

    /**
     * 浏览器整个错误页上那一条原文(整条就是它,而不是夹在别的提示里的一句)。实测 Chrome 打不开页面时
     * 屏上只有一句「No internet connection」,别的控件照常都在,光看元素数量判成 normal,模型就会反复
     * 点返回、改地址重输(见 2026-11-04 的那次运行:第 10 步到第 16 步空转)。
     * 只认整条相等:App 里一次请求失败弹的「网络异常，请稍后重试」不是整屏断网,按它停下会把能救回的任务判死。
     */
    private val OFFLINE = listOf(
        "no internet connection", "no internet", "check your internet connection",
        "无法连接互联网", "未连接到互联网", "无法连接到互联网", "没有网络连接", "网络连接不可用", "网络不可用",
        "网页无法打开", "无法访问此网站", "网络异常", "网络错误", "检查网络连接", "请检查网络连接", "请检查您的网络连接",
    )

    /** 浏览器错误页正文里的错误码(整屏就是这个错误时才出现)。 */
    private val OFFLINE_CODES = listOf(
        "err_internet_disconnected", "err_name_not_resolved", "err_connection_timed_out",
        "err_proxy_connection_failed", "err_address_unreachable", "err_network_changed",
        "err_connection_refused", "err_connection_closed", "err_connection_reset",
    )

    /** 屏上文字里第一个付款字样(确认支付、支付密码一类);没有为 null。 */
    fun paymentText(texts: List<String>): String? {
        val text = Hant.fold(texts.joinToString("\n")).lowercase()
        return PAYMENT.firstOrNull { it in text }
    }

    /**
     * 这一屏自己说连不上网时的原话;没有为 null。读屏和动作结果用它当场提醒,
     * 不必等模型自己想到去诊断:2026-11-04 那次运行里这句在四次动作结果里都出现了,
     * 模型仍然点返回、清地址、重输网址,一直到第 16 步才放弃。
     * 页面还在变时不判:加载中的过渡页也可能短暂挂着这句。
     */
    fun offlineText(s: ScreenSnapshot): String? {
        if (s.protected || s.changedDuringRead || !s.hasWindow) return null
        return offlineIn(s.elements.map { it.name })
    }

    /** 屏上这些条目里有没有整屏报断网的那一条;返回原话(留给 cause 说依据)。 */
    private fun offlineIn(texts: List<String>): String? {
        val lines = texts.map { Hant.fold(it).trim().lowercase().trimEnd('.', '。', '!', '！') }.filter { it.isNotEmpty() }
        lines.firstOrNull { it in OFFLINE }?.let { return it }
        return OFFLINE_CODES.firstOrNull { code -> lines.any { it == code || it.endsWith(":$code") || it.startsWith("$code ") } }
    }

    fun classify(f: ScreenFacts): ScreenCheck {
        val text = Hant.fold(f.texts.joinToString("\n")).lowercase()
        fun hit(words: List<String>) = words.firstOrNull { it in text }
        fun human(reason: String, cause: String) = ScreenCheck(ScreenState.NEEDS_HUMAN, f.currentApp, true, reason, cause)

        // 页面切换时画面也可能短暂全黑:界面还在变就按加载中处理
        if (f.changing && f.blackFrames.any { it }) {
            return ScreenCheck(ScreenState.LOADING, f.currentApp, false, cause = "black frame while the screen keeps changing")
        }
        val human = when {
            hit(CAPTCHA) != null -> "captcha" to "captcha text: ${hit(CAPTCHA)}"
            hit(PAYMENT) != null -> "payment" to "payment text: ${hit(PAYMENT)}"
            f.passwordField -> "login" to "password field"
            hit(SMS_CODE) != null -> "login" to "verification code text: ${hit(SMS_CODE)}"
            else -> null
        }
        // 两次安静时都全黑才算防截屏,一次黑可能只是还没画出来
        if (f.hasWindow && f.blackFrames.size >= 2 && f.blackFrames.all { it }) {
            return ScreenCheck(ScreenState.PROTECTED, f.currentApp, true, human?.first ?: "other", "secure window: the frame stays black")
        }
        human?.let { (reason, cause) -> return human(reason, cause) }
        if (f.changing) return ScreenCheck(ScreenState.LOADING, f.currentApp, false, cause = "screen keeps changing")
        // 安静下来才判:加载中的页面也可能短暂挂着这句
        offlineIn(f.texts)?.let { return ScreenCheck(ScreenState.OFFLINE, f.currentApp, false, cause = "offline text: $it") }
        if (!f.hasWindow || f.readableElements == 0) {
            val cause = when {
                f.hasWindow -> "no readable elements"
                f.anyWindow || f.foregroundApp != null -> UNREADABLE_WINDOW
                else -> NO_WINDOW
            }
            return ScreenCheck(ScreenState.BLANK, f.currentApp ?: f.foregroundApp, false, cause = cause)
        }
        return ScreenCheck(ScreenState.NORMAL, f.currentApp, false)
    }
}
