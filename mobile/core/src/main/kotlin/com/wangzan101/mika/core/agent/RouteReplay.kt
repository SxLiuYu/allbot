package com.wangzan101.mika.core.agent

import com.wangzan101.mika.core.observation.Place
import com.wangzan101.mika.core.observation.tag
import com.wangzan101.mika.core.action.ActionExecutor
import com.wangzan101.mika.core.model.Author
import com.wangzan101.mika.core.model.Message
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.Role
import com.wangzan101.mika.core.prompt.Feedback
import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.record.RunSink
import com.wangzan101.mika.core.replay.OPENS
import com.wangzan101.mika.core.replay.ReplayOutcome
import com.wangzan101.mika.core.replay.Replayer
import com.wangzan101.mika.core.replay.Route
import com.wangzan101.mika.core.replay.RouteMatcher
import com.wangzan101.mika.core.tool.ToolDispatcher
import com.wangzan101.mika.core.tool.Verb
import com.wangzan101.mika.core.uistate.interfaces
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private val REPLAY_SOURCE: String get() = Feedback["replay_source"]
private val REPLAY_SCREEN_HEADER: String get() = Feedback["replay_screen_header"]
private val REPLAY_NO_SCREEN: String get() = Feedback["replay_no_screen"]

/**
 * 经验回放:第一次模型调用之前,有合适的路线就先照着做,做完或对不上都交还模型;任务结束后按结局更新路线的计数。
 * 路线出了问题(匹配、读写路线)都不影响任务。每个任务开始时 [reset]。
 */
internal class RouteReplay(
    private val routes: RouteMatcher,
    private val tools: ToolDispatcher,
    private val gate: suspend () -> Unit,
    /** 对外显示回放进度(也是关卡等完之后恢复的状态)。 */
    private val show: (TaskState.Running) -> Unit,
    private val emit: (RunEvent) -> Unit,
    private val clock: () -> Long,
) {
    /** 本次任务回放过的路线与结果。 */
    private var replayed: Pair<Route, ReplayOutcome>? = null

    /**
     * 这次任务整条路线走完了,不需要再动手机,只剩把结果读出来交给用户:
     * 之后这一轮的工具面可以收窄到「读屏 + 结束」([HANDOVER_VERBS]),省下十几个 token 量的工具定义。
     */
    var completedWholeRoute: Boolean = false
        private set

    fun reset() { replayed = null; completedWholeRoute = false }

    /** 交还时读屏用最近操作的那块屏的读元素工具(回放的路线落在哪块屏就读哪块)。 */
    private val dumpTool: String get() = tools.index.nameOf(Verb.ListElements, tools.surface)!!

    /**
     * 找路线并回放;回放过就把经过(做了哪几步、在哪对不上)和一份当前全量读屏交给模型,返回读屏里的前台 App。
     */
    suspend fun run(task: String, history: MutableList<Message>, executor: ActionExecutor, ctx: ContextBuilder, track: StepTrack): Place? {
        val choice = try {
            withContext(Dispatchers.IO) { routes.choose(task) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return null
        val total = choice.route.steps.size
        var running = TaskState.Running(0, REPLAY_NOTE, progress = RunProgress.Replay(1, total))
        show(running)
        val replayer = Replayer(
            tools, executor, gate = gate,
            sink = object : RunSink {
                override fun event(e: RunEvent) {
                    emit(e)
                    // 一步对上了就显示下一步
                    if (e is RunEvent.Replay && e.matched && e.step < e.total) {
                        running = running.copy(progress = RunProgress.Replay(e.step + 1, e.total))
                        show(running)
                    }
                }
                override fun media(mediaId: Int, png: ByteArray) = Unit
            },
            clock = clock,
        )
        val out = replayer.run(choice)
        replayed = choice.route to out
        // 走完的只是一串「打开 App」的话,不算整条走完:那一步之后什么界面动作都没做过,
        // 请求要做的事全落在模型身上,收掉动作工具它就只能放弃。
        // 设备上真出现过这种一步路线(模板是整句原话,成功次数 0),每次回放完都收窄工具,
        // 模型于是反复说「没有 phone_system_command 这个工具」。
        val openedOnly = choice.route.steps.all { tools.index[it.tool]?.verb in OPENS }
        completedWholeRoute = out is ReplayOutcome.Completed && !openedOnly
        update(choice.route.id) { r ->
            when (out) {
                is ReplayOutcome.Diverged -> {
                    // 这一屏没读完、读不稳：不是路线的错，不扣分（页面在动时读到的「没有这个元素」多半只是还没画出来）
                    if (out.unreliable) r.copy(lastUsedMs = clock()) else {
                        val misses = if (r.missStep == out.done) r.consecutiveMisses + 1 else 1
                        r.copy(consecutiveMisses = misses, missStep = out.done, disabled = r.disabled || misses >= ROUTE_MISSES_TO_DISABLE, lastUsedMs = clock())
                    }
                }
                else -> r.copy(lastUsedMs = clock())
            }
        }
        val steps = choice.route.steps
        val doneLines = steps.take(out.done).mapIndexed { i, st -> "${i + 1}. ${Replayer.describe(st, choice.slots)}" }.joinToString("\n")
        val head = when (out) {
            is ReplayOutcome.Completed -> if (openedOnly) Feedback.format("replay.opened_only", "total" to steps.size, "steps" to doneLines)
                else Feedback.format("replay.completed", "total" to steps.size, "steps" to doneLines)
            is ReplayOutcome.Diverged -> {
                if (out.unreliable) Feedback["replay.unreadable"]
                else {
                    val error = out.error?.let { Feedback.format("replay.error_code", "code" to it) }.orEmpty()
                    val next = if (out.executed) Feedback.format("replay.diverged_executed", "step" to (out.done + 1), "expected" to out.expected, "seen" to out.seen, "error" to error)
                    else Feedback.format("replay.diverged_skipped", "step" to (out.done + 1), "expected" to out.expected, "seen" to out.seen, "error" to error)
                    Feedback.format("replay.progress", "done" to out.done, "total" to steps.size, "steps" to doneLines.ifEmpty { Feedback["replay.no_steps"] }, "next" to next)
                }
            }
            is ReplayOutcome.StoppedForConfirmation -> Feedback.format("replay.progress", "done" to out.done, "total" to steps.size, "steps" to doneLines.ifEmpty { Feedback["replay.no_steps"] },
                "next" to Feedback.format("replay.stopped", "step" to (out.done + 1), "action" to Replayer.describe(steps[out.done], choice.slots)))
        }
        // 当前全量读屏:模型从这里拿编号接着做;读不到就只交说明,任务照常继续。
        // 路线整条走完时,冷启动的窗口树可能还没填充;用轻量 peek 探到有内容再正式读一次,
        // 不反复调 observe(它自己会等稳定,重复调用会把等待叠起来)。
        val looked = try {
            var r = tools.executeRead(Part.ToolCall("replay_handback", dumpTool, "{}"), 0).takeIf { it.content["ok"] == JsonPrimitive(true) }
            if (out is ReplayOutcome.Completed && r != null && !readable(r.content) && awaitReadableScreen()) {
                r = tools.executeRead(Part.ToolCall("replay_handback_retry", dumpTool, "{}"), 0)
                    .takeIf { it.content["ok"] == JsonPrimitive(true) } ?: r
            }
            r
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val read = looked?.content
        if (read != null) {
            // 读屏做成一对工具调用与结果:裁剪和「模型看得到哪几屏」按读屏工具认它,各家接口对调用和结果的配对要求也都满足
            val id = "replay_handback"
            history += Message(Role.Assistant, listOf(Part.Text(Feedback.format("replay.handback", "head" to head, "note" to REPLAY_SCREEN_HEADER)), Part.ToolCall(id, dumpTool, "{}")), Author.Mika)
            history += Message(Role.Tool, listOf(Part.ToolResult(id, read.toString(), isError = false, looked?.observations.orEmpty().map { it.tag })), Author.Mika)
            // 能看图的主模型:交还时和动作之后一样看到此刻的画面
            tools.imageNow()?.let { (png, shotId) -> history += Message(Role.User, listOf(Part.Text(Feedback["action_frame_note"]), tools.modelImage(png, shotId)), Author.Mika) }
        } else {
            history += ctx.notice(REPLAY_SOURCE, Feedback.format("replay.handback", "head" to head, "note" to REPLAY_NO_SCREEN))
        }
        // 交还之后的一步按恢复步算(大小模型分工时交给主模型)
        track.markRecovery()
        return looked?.place
    }

    /**
     * 回放走完且这次运行算办成了([LearnGate],[outcome] 是交出回答后判的结局):成功计数 +1、清掉连续失误。
     * 走完了却判下来只办了一部分 / 办不成,说明这条路线没覆盖用户的请求(少记了步、或者做法已经过时):
     * 按失误记,连续几次就停用。不记的话这种路线既不成功也不失误,会一直被回放下去——实测就有一条只有
     * 「打开设置」一步的路线,每次都「整条走完」,却每次都答不出用户要的东西。
     * [RunOutcome.Unknown] 不算:那是没判成(模型出错、超时)或旧记录,不能拿来扣路线的分。
     */
    suspend fun noteResult(end: TaskState, outcome: RunOutcome) {
        val (route, out) = replayed ?: return
        if (out !is ReplayOutcome.Completed) return
        when {
            LearnGate.done(end, outcome) ->
                update(route.id) { it.copy(successes = it.successes + 1, consecutiveMisses = 0, missStep = null) }
            outcome == RunOutcome.Partial || outcome == RunOutcome.NotPossible ->
                update(route.id) { r ->
                    val misses = if (r.missStep == route.steps.size) r.consecutiveMisses + 1 else 1
                    r.copy(consecutiveMisses = misses, missStep = route.steps.size,
                        disabled = r.disabled || misses >= ROUTE_MISSES_TO_DISABLE)
                }
        }
    }

    /** 交还读屏有没有可用的界面内容:显式标不可读、或既没窗口树也没有元素表,都算空屏。 */
    private fun readable(content: JsonObject): Boolean {
        if (content["readable"] == JsonPrimitive(false)) return false
        val screen = content["screen"] as? JsonObject
        if (screen?.get("readable") == JsonPrimitive(false)) return false
        val tree = screen?.get("tree") as? JsonArray
        val elements = (screen?.get("elements") ?: content["elements"]) as? JsonArray
        return !tree.isNullOrEmpty() || !elements.isNullOrEmpty() || content["visibleText"] != null
    }

    /** 等到窗口树里有可交互节点;受保护页面、明确读不到窗口都不白等。次数上限见 [HANDBACK_POLLS]。 */
    private suspend fun awaitReadableScreen(): Boolean {
        repeat(HANDBACK_POLLS) {
            val s = tools.interfaces.peek() ?: return false
            if (s.protected) return false
            // 只要此刻有内容就值得正式重读一次:第一次交还读到的可能是启动瞬间的空屏
            if (s.elements.any { it.meaningful } || s.windows.isNotEmpty()) return true
            delay(HANDBACK_POLL_MS)
        }
        return false
    }

    private suspend fun update(id: String, change: (Route) -> Route) {
        val store = routes.store
        try {
            // 读改写一次完成:并行的另一个任务同时改这条路线时计数不会丢
            withContext(Dispatchers.IO) { store.update(id, change) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // 路线计数写不进去不影响任务
        }
    }

    companion object {
        /** 回放期间界面上这一步的说明。 */
        const val REPLAY_NOTE = "按以往的做法操作"
        /** 同一步连续对不上这么多次就停用路线。 */
        const val ROUTE_MISSES_TO_DISABLE = 2
        /** 冷启动后窗口树可能要过一会儿才填得上;最多探这么多次,总上限约 2 秒。 */
        private const val HANDBACK_POLLS = 13
        private const val HANDBACK_POLL_MS = 150L

        /**
         * 整条路线走完后交还模型时给的工具:读屏确认结果 + 结束/交接。不含任何改变界面的动作——
         * 这一步的目的就是看清楚再说话。多给一样工具就多一份定义开销,而这时用不上。
         */
        val HANDOVER_VERBS = setOf(
            Verb.Observe, Verb.ListElements, Verb.Query, Verb.Collect, Verb.PhoneFind,
            Verb.Screenshot, Verb.ViewPastScreens, Verb.Describe, Verb.FindVisually,
            Verb.AskUser, Verb.EndNotDone,
        )
    }
}
