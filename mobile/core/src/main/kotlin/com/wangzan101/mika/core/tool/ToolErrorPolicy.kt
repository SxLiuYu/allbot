package com.wangzan101.mika.core.tool

/**
 * 一次工具失败之后怎么走。纯判断,不执行:调用方拿结论去刷读屏、换工具或停手。
 */
sealed interface ErrorAction {
    /** 等一会原样再试;[maxAttempts] 是这条错误最多自动试几次(含第一次)。 */
    data class RetryAfter(val delayMs: Long, val maxAttempts: Int = 2) : ErrorAction

    /** 重新读一屏(目标可能换了),再按新快照重试。 */
    data object RefreshScreenThenRetry : ErrorAction

    /** 换一条路:[tool] 是替代工具,[reason] 说明为什么换。 */
    data class Fallback(val tool: String, val reason: String) : ErrorAction

    /** 不再自动重试,把说明交回模型(不是结束任务)。 */
    data class Stop(val reason: String) : ErrorAction
}

/**
 * 工具失败后的恢复策略。规则来自真机运行记录:1891 次工具结果里 164 次 `ok:false`,
 * 集中在 phone_back(action_failed 53)、phone_tap(element_not_found 15、invalid_arguments 12、
 * opened_elsewhere 6、ref_expired 6)、phone_system_command 14、phone_type_text 9。
 *
 * 目标是把「同一条错误重复到熔断」变成「先刷新、再换路、最后才停」,并且停的时候说清楚为什么。
 */
object ToolErrorPolicy {
    /** 这些错误刷新一屏多半就好了:目标按新快照重新解析。 */
    private val STALE = setOf("element_not_found", "ref_expired", "target_unresolved", "snapshot_missing")

    /** 这些错误重试没有意义:模型给的参数不对,原样再发只会再错一次。 */
    private val ARGUMENT = setOf("invalid_arguments", "unknown_tool", "use_phone_tool", "bad_arguments")

    /** 目标不在当前窗口(被别的应用盖住、弹窗跳到别处):先把目标窗口拉回来,别再点。 */
    private const val OPENED_ELSEWHERE = "opened_elsewhere"

    /** 界面没准备好/应用没开:先启动或读屏,而不是继续连发动作。 */
    private val NOT_READY = setOf("phone_unavailable", "no_app_open", "screen_unavailable", "no_screen")

    /**
     * @param streak 同一个错误码连续出现了几次(含这一次);[available] 是本任务现在提供的工具名。
     */
    fun decide(tool: String, code: String?, streak: Int, available: Set<String>): ErrorAction {
        if (code == null) return ErrorAction.Stop("no_error_code")
        if (code in ARGUMENT) {
            return ErrorAction.Stop("arguments: 参数不合法,按工具说明补齐字段后再调用,不要原样重试")
        }
        if (code == OPENED_ELSEWHERE) {
            return if ("phone_observe" in available) {
                ErrorAction.Fallback("phone_observe", "目标在别的窗口:先读屏确认是哪个窗口,再决定要不要拉回前台")
            } else {
                ErrorAction.Stop("目标在别的窗口,本任务读不了屏")
            }
        }
        if (code in NOT_READY) {
            val next = when {
                "phone_launch_app" in available -> "phone_launch_app"
                "phone_observe" in available -> "phone_observe"
                else -> return ErrorAction.Stop("界面或应用不可用,也没有能先读屏/启动的工具")
            }
            return ErrorAction.Fallback(next, "界面/应用还没准备好:先$next,不要继续发动作")
        }
        if (code == "confirmation_required") return ErrorAction.Stop("等用户确认,交给确认关卡")
        if (code in STALE) {
            // 刷新一次;连着两次还找不到,说明确实不在这一屏,换看图或停手
            if (streak <= 1) return ErrorAction.RefreshScreenThenRetry
            if ("phone_find_visually" in available) {
                return ErrorAction.Fallback("phone_find_visually", "刷新后仍找不到目标:按画面找一次")
            }
            return ErrorAction.Stop("刷新后仍找不到目标,本任务也没有看图定位")
        }
        if (tool.endsWith("_back") && code == "action_failed") {
            // 返回没生效:第一次先读屏看是不是弹窗挡住了,第二次改按系统返回键,第三次停手
            return when {
                streak <= 1 -> ErrorAction.RefreshScreenThenRetry
                streak == 2 && "phone_system_command" in available ->
                    ErrorAction.Fallback("phone_system_command", "返回键没生效:用 shell 发 keyevent 4")
                else -> ErrorAction.Stop("返回连续没生效,界面可能被挡住;把看到的一屏和想退出的地方告诉用户")
            }
        }
        return if (code == "action_failed" || code == "timeout" || code == "busy") {
            ErrorAction.RetryAfter(delayMs = 500, maxAttempts = 2)
        } else {
            ErrorAction.Stop("未归类的错误:$code")
        }
    }
}
