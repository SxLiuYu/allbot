package com.wangzan101.mika.core.cap.phone

/**
 * 系统命令在做专门工具做的事(点、滑、打字、按键、打开 App)时,结果里提醒换回那个工具:专门工具在 Mika 的屏上做,
 * 做完会核实效果,shell 发的输入不核实。第一次只提醒、照样执行;本任务提醒过之后,再做这几类事的命令不执行,
 * 只回那句提醒([refuses])。用 shell 分享文字一律不执行,指向分享文字的工具。查状态、读设置一类的命令不受影响。
 *
 * 另外拦一类不会「做事」但会很慢的:用 shell 探网络通不通(ping、curl 这类)。它们没有超时,一挂就是命令的
 * 10 秒上限,而屏上自己就写着能不能上网(见 [com.wangzan101.mika.core.uistate.ScreenDiagnosis])。
 */
internal object CommandSteer {
    enum class Purpose(val feedbackKey: String) {
        Gesture("system_command.use_tap"), Type("system_command.use_type"), Key("system_command.use_key"), Launch("system_command.use_launch"),
        Share("system_command.use_share"), Network("system_command.use_diagnose"),
    }

    /**
     * [purpose] 的命令这回不执行:分享一律不执行;探网络也不执行(它没有副作用,执行只会白等满 10 秒上限);
     * 其余在本任务已提醒过([steered])之后不执行。
     */
    fun refuses(purpose: Purpose?, steered: Boolean): Boolean =
        purpose == Purpose.Share || purpose == Purpose.Network || (purpose != null && steered)

    /** 命令里每一段 `input …` 的子命令(前面可带输入源和 -d 屏号)。 */
    private val INPUT = Regex("""(?:^|[;&|(\s])input\s+(?:(?:touchscreen|touchpad|keyboard|mouse|stylus|trackball|dpad|gamepad|joystick|rotaryencoder|touchnavigation)\s+)?(?:-d\s+\S+\s+)?([a-z]+)""")
    private val LAUNCH = Regex("""(?:^|[;&|(\s])(?:am\s+(?:start|start-activity)\b|cmd\s+activity\s+start(?:-activity)?\b|monkey\s+(?:.*\s)?-p\s)""")
    private val GESTURES = setOf("tap", "swipe", "draganddrop", "motionevent", "press", "roll")
    /** 启动的是分享:动作写全(android.intent.action.SEND)或只写 -a SEND。 */
    private val SHARE = Regex("""(?:android\.intent\.action\.SEND|-a\s+["']?SEND)(?![A-Za-z_])""")
    /** 分享的是文件(带 STREAM):分享文字的工具做不了,按一般的启动算。 */
    private const val STREAM = "android.intent.extra.STREAM"

    /**
     * 探网络通不通的命令:ping、curl、wget、nslookup、telnet,以及 `cmd connectivity`/`dumpsys connectivity` 之外的
     * 那点常识性检查。这些没有超时,连着不通就是等满命令的 10 秒上限(实测 2026-11-04 那次白等 10 秒),
     * 而真正该看的是这一屏自己怎么写:屏上明说连不上网时,换命令重试也不会好。
     */
    private val NETWORK = Regex(
        """(?:^|[;&|(\s])(?:ping|ping6|curl|wget|nslookup|dig|telnet|nc|netcat|traceroute|tracert)\s""",
        RegexOption.IGNORE_CASE,
    )

    /** `cmd connectivity` / `dumpsys connectivity` 这类只读状态的查询:不算探测。 */
    private val NETWORK_STATUS = Regex("""(?:cmd|dumpsys)\s+connectivity\b""", RegexOption.IGNORE_CASE)

    /**
     * 命令在模仿哪一类专门工具;都不是为 null。打字和点同在一条命令里时按打字算(要说的是打字该用什么);
     * 分享文字排在最前:它一律不执行。探网络排在模仿类之前:它就是慢,不因为顺手点了下屏就放过去。
     */
    fun purpose(command: String): Purpose? {
        val subs = INPUT.findAll(command).map { it.groupValues[1] }.toSet()
        val launches = LAUNCH.containsMatchIn(command)
        return when {
            launches && SHARE.containsMatchIn(command) && STREAM !in command -> Purpose.Share
            // 只读状态的查询不算探测(它们本来就快)
            NETWORK.containsMatchIn(NETWORK_STATUS.replace(command, " ")) -> Purpose.Network
            "text" in subs -> Purpose.Type
            subs.any { it in GESTURES } -> Purpose.Gesture
            subs.any { it == "keyevent" || it == "keycombination" } -> Purpose.Key
            launches -> Purpose.Launch
            else -> null
        }
    }
}
