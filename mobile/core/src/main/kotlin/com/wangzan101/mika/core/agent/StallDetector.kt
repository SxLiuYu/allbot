package com.wangzan101.mika.core.agent

/** 一步的进展信号:这一步结束后看到的屏、工具结果和有没有改到界面。 */
data class ProgressSignal(
    val step: Int,
    /** 这一步之后那块屏的指纹;没接屏或还没读过为 null(这时不判「同一屏」)。 */
    val screenFingerprint: Long?,
    val observedHash: Long?,
    val tool: String,
    val ok: Boolean,
    val errorCode: String?,
    val changed: Boolean?,
    val atMs: Long = 0,
    /** 正在等某个目标出现(`phone_wait_for` 一类):这段时间不算「没进展」。 */
    val waiting: Boolean = false,
    /** 这次调用的参数指纹;同工具同错误但参数不同,不算「同一条错误」反复。 */
    val argsHash: Long? = null,
    /** 这一步之后在哪(App 名或站点名);不知道为 null(只影响提醒里怎么说)。 */
    val place: String? = null,
    /**
     * 这一步之后那页上看到的字(去掉空白后的哈希);读不到为 null。
     * 判「回到同一页」用它,不用 [screenFingerprint]:后者含每个元素的 bounds,滚动一下就不一样了,
     * 同一页翻来覆去看会被当成不同页(笔记那条列表页出现 9 次,指纹一次都没重复)。
     */
    val pageTextHash: Long? = null,
    /**
     * 这一步页面文字里**以前没出现过**的片段数;读不到为 null。
     * 页面一直在换、却全是看过的内容,就是这个数连续为 0:翻来翻去没有新信息,该收了。
     * 比「同一页」细——同一个 App 里换页也算,只要新页面上的字都是见过的。
     */
    val newWords: Int? = null,
    /**
     * 这一步正常执行完了(没报错、不在等)。判「同一个只读工具换着法子问」时用:
     * 失败的另有一条规则管,正在等的不算。
     */
    val ready: Boolean = true,
)

/** 长任务要不要提醒或收尾。 */
sealed interface ProgressDecision {
    data object Continue : ProgressDecision
    /** 发一条带原因的提醒,让模型自己换做法。 */
    data class Nudge(val reasons: List<String>) : ProgressDecision
    /** 收尾;原因写进结局([outcome])。 */
    data class Stop(val reason: String, val outcome: String) : ProgressDecision
}

/** 长任务的预算;用户明确要长时间批量跑时可放宽步数。 */
data class TaskBudget(
    val maxSteps: Int = 80,
    val maxWallMs: Long = 20 * 60_000,
    val maxInputTokens: Long = 2_000_000,
)

/**
 * 只盯「有没有进展」,不按动作签名拦重复(那条路会误伤脚本里合法的重复点击)。
 * 四个条件各自「先说一次、再说一次就收」:
 * - 连续 [sameScreenLimit] 步看屏和结果都没变;
 * - 连续 [noChangeLimit] 步没有任何一次 changed == true;
 * - 同工具同错误码连续 [errorLimit] 次;
 * - 同一个地方([ProgressSignal.place])反复回到 [revisitLimit] 次。
 * 最后一条对付的是「有进展但一直在原地打转」:每步都点到了东西、界面一直在变,前三条全不触发,
 * 但任务就是收不了尾(余额宝那条进了三次余额宝、点了五次同一个关不掉的弹窗,45 步 204 秒)。
 * 按「回到同一个地方」而不是按动作签名判,批量点击和列表来回翻不会误伤。
 * 脚本、回放路径不喂信号,所以它们的行为不变;等用户/接管期间调用方不喂。
 */
class StallDetector(
    private val budget: TaskBudget = TaskBudget(),
    private val sameScreenLimit: Int = 5,
    private val noChangeLimit: Int = 15,
    private val errorLimit: Int = 3,
    private val revisitLimit: Int = 3,
    private val noNewInfoLimit: Int = 5,
    private val probeLimit: Int = 6,
) {
    /** 最近一次提醒的原因,给运行记录用。 */
    var lastNudge: List<String> = emptyList()
        private set

    /** 到最近一步为止,同工具同错误(同参数)连续出现了几次;最近一步没错为 0。 */
    var lastErrorStreak: Int = 0
        private set

    /**
     * 上一步的收尾是「没进展」类的([StopReasons.CAN_STILL_ANSWER] 那些)。
     *
     * 这类收尾不走直接失败:调用方先给模型最后一轮,让它把已经读到的结果用文字交出来。
     * 实测反例:笔记那条第 3 步 phone_find 找不到就判 no_progress,直接把已经读到的
     * 「只有 3 条笔记」一起丢了,judged 也留不下来。
     */
    var stoppedButCanStillAnswer: Boolean = false
        private set

    private var lastFingerprint: Long? = null
    private var lastObserved: Long? = null
    private var sameScreens = 0
    private var nudgedSameScreen = false
    private var noChangeSteps = 0
    private var nudgedNoChange = false
    private var lastError: Triple<String, String?, Long?>? = null
    private var errorStreak = 0
    private var nudgedError = false
    /** 每个页面(屏指纹)最后一次在哪一步;同一步只算一次(批里的子步不重复计数)。 */
    private val lastVisitStep = HashMap<Long, Int>()
    /** 每个页面回到过几次(第一次到不算「回到」)。 */
    private val revisits = HashMap<Long, Int>()
    /** 指纹 → 当时的 App 名,只为提醒里说人话。 */
    private val pageLabels = HashMap<Long, String>()
    /** 上一步在哪一页;相邻两步在同一页不算「回来」。 */
    private var lastPage: Long? = null
    private var nudgedRevisit = false
    /** 连续几步页面都没带来新字。 */
    private var noNewInfoSteps = 0
    private var nudgedNoNewInfo = false
    /** 同一个只读工具连着问了几次、问了哪些不同的参数。 */
    private var probeTool: String? = null
    private var probeSteps = 0
    private val probeArgs = HashSet<Long>()
    private var nudgedProbe = false

    fun onStep(s: ProgressSignal): ProgressDecision {
        // 端口说这一步改动了界面时,指纹可能是旧的:不拿它判「同一屏」
        val same = s.changed != true && s.screenFingerprint != null && s.screenFingerprint == lastFingerprint && s.observedHash == lastObserved
        lastFingerprint = s.screenFingerprint
        lastObserved = s.observedHash
        sameScreens = if (same && !s.waiting) sameScreens + 1 else 0

        // 只认端口明确说「没改动」的写操作;读屏(不知道)、正在等目标都不算没进展
        noChangeSteps = if (s.changed == false && !s.waiting) noChangeSteps + 1 else 0

        val error = if (!s.ok && !s.waiting) Triple(s.tool, s.errorCode, s.argsHash) else null
        if (error != null && error == lastError) errorStreak++ else errorStreak = if (error == null) 0 else 1
        lastError = error
        lastErrorStreak = errorStreak

        // 「回到同一页」:判的是「去过几次」而不是「连续几次」——打转的特征正是中间夹着别的页面。
        // 页面用屏指纹认,不用 place:place 只到 App(包名),App 内来回翻页它看不出来
        // (笔记那条在同一个 App 里进出 11 次,place 全程没变)。
        // 同一步里的子步不算新的一次;相邻两步在同一页也不算「回来」。
        // 页面只认「那页上的字」:没读到字(纯点击、输入这类动作读不到整屏)就沿用上一页,
        // 不退回屏指纹——指纹含每个元素的 bounds,滚动、点不同位置都会变,拿它判会把同一页当成不同的页
        // (测试里「点不同位置但屏幕不变」就是这样,被误判成来回打转)。
        val textPage = s.pageTextHash?.takeIf { !s.waiting }
        val page = textPage ?: if (s.waiting) null else lastPage
        if (page != null && page != lastPage) {
            if (lastVisitStep.containsKey(page)) revisits[page] = (revisits[page] ?: 0) + 1
            lastVisitStep[page] = s.step
            // 记一份「指纹 → 当时的 App 名」,只为提醒里说人话
            s.place?.let { pageLabels[page] = it }
        }
        if (page != null) lastPage = page
        val worstRevisit = revisits.maxByOrNull { it.value }
        // 「打转」的前提是真换过页面。屏一直不变是另一回事,归「同一屏」那一条判:
        // 那条会判「no_progress / stall」,比这里说「反复回到同一页」准确,而且它是先有的行为。
        val sawSeveralPages = lastVisitStep.size > 1

        // 「一直在换页面,但全是看过的字」:翻来翻去找同一个东西,页面变了却没有新信息。
        // 余额宝是「反复回同一页」;笔记那条更细——在同一个 App 里换页找搜索框,页面一直变,
        // 每次读到的还是那三篇笔记和那几个标签,24 步才因为别的原因被拦下。
        noNewInfoSteps = if (s.newWords == 0 && !s.waiting) noNewInfoSteps + 1 else 0

        // 「同一个只读工具换着法子问」:每步参数都不同、都不报错,所以前几条一条都拦不住,
        // 但一直在问同一件事。录音机那条连发 11 次 shell 查「现在是不是在录音」,每次换一个角度
        // (音频输入线程、麦克风占用、今天的录音记录),17 次模型调用花掉 48 万 token,
        // 答案是一个是非题。只数只读的、不动界面的:连续点击、滚动是正常操作,不算。
        if (s.tool in PROBE_TOOLS && s.ready) {
            if (s.tool != probeTool) { probeTool = s.tool; probeSteps = 0; probeArgs.clear() }
            probeSteps++
            s.argsHash?.let { probeArgs += it }
        } else if (s.ready) {
            probeTool = null; probeSteps = 0; probeArgs.clear()
        }

        val reasons = mutableListOf<String>()
        var stop: ProgressDecision.Stop? = null
        if (sameScreens >= sameScreenLimit) {
            if (nudgedSameScreen) stop = ProgressDecision.Stop("stall", "partial")
            else { nudgedSameScreen = true; sameScreens = 0; reasons += "连续 $sameScreenLimit 步读屏和工具结果都没变,先确认是不是卡在同一屏,换个做法" }
        }
        if (noChangeSteps >= noChangeLimit) {
            if (nudgedNoChange) stop = ProgressDecision.Stop("no_change", "not_possible")
            else { nudgedNoChange = true; noChangeSteps = 0; reasons += "连续 $noChangeLimit 步没有改动任何界面,说明办法不对;说清现在的进展和卡在哪" }
        }
        if (errorStreak >= errorLimit) {
            if (nudgedError) stop = ProgressDecision.Stop("error_streak", "not_possible")
            else { nudgedError = true; errorStreak = 0; reasons += "同一个工具同样报错连续 $errorLimit 次,换一条路(见报错里的说明),不要原样重试" }
        }
        if (sawSeveralPages && worstRevisit != null && worstRevisit.value >= revisitLimit) {
            // 打转的收尾按 partial 算:模型多半已经读到要用的一半,别整段判成 not_possible 丢掉
            if (nudgedRevisit) {
                stop = ProgressDecision.Stop("revisit", "partial")
            } else {
                nudgedRevisit = true
                worstRevisit.key.let { revisits[it] = 0 }
                val where = pageLabels[worstRevisit.key]?.let { "「$it」里" } ?: ""
                reasons += "已经第 ${worstRevisit.value + 1} 次回到${where}同一个页面,每步都在动但任务没收尾。" +
                    "先把已经读到的结果直接回答给用户(说明还差什么),不要再进同一页去找"
            }
        }
        if (noNewInfoSteps >= noNewInfoLimit) {
            if (nudgedNoNewInfo) {
                stop = ProgressDecision.Stop("no_new_info", "partial")
            } else {
                nudgedNoNewInfo = true
                noNewInfoSteps = 0
                reasons += "连续 $noNewInfoLimit 步页面在换,但看到的都是已经看过的内容,没有新信息。" +
                    "换个做法,或者把已经确认的结果直接回答给用户(说清还差什么)"
            }
        }
        if (probeSteps >= probeLimit) {
            if (nudgedProbe) {
                stop = ProgressDecision.Stop("probe_loop", "partial")
            } else {
                nudgedProbe = true
                val tried = probeArgs.size
                probeSteps = 0; probeArgs.clear()
                reasons += "已经用 ${s.tool} 换了 $tried 种查法查同一件事,每次都成功但没有一个给出新结论。" +
                    "把已经读到的直接回答给用户;还缺的就明说缺什么,不要再换角度问同一件事"
            }
        }

        // 任何「没进展」收尾都给模型最后一轮,而不是直接判失败把读到的内容丢掉。
        lastNudge = reasons
        if (stop != null) stoppedButCanStillAnswer = true
        return stop ?: if (reasons.isEmpty()) ProgressDecision.Continue else ProgressDecision.Nudge(reasons.toList())
    }

    /** 总步数、总时长、累计输入超预算就直接收尾。 */
    fun checkBudget(step: Int, elapsedMs: Long, inputTokens: Long): ProgressDecision {
        val stop = when {
            step > budget.maxSteps -> ProgressDecision.Stop("budget_steps", "not_possible")
            elapsedMs > budget.maxWallMs -> ProgressDecision.Stop("budget_time", "not_possible")
            inputTokens > budget.maxInputTokens -> ProgressDecision.Stop("budget_tokens", "not_possible")
            else -> null
        }
        return stop ?: ProgressDecision.Continue
    }

    /** 新任务(或用户接管回来)时清空。 */
    fun reset() {
        lastFingerprint = null; lastObserved = null; sameScreens = 0; nudgedSameScreen = false
        noChangeSteps = 0; nudgedNoChange = false; lastError = null; errorStreak = 0; nudgedError = false
        lastVisitStep.clear(); revisits.clear(); pageLabels.clear(); lastPage = null; nudgedRevisit = false; stoppedButCanStillAnswer = false
        noNewInfoSteps = 0; nudgedNoNewInfo = false
        probeTool = null; probeSteps = 0; probeArgs.clear(); nudgedProbe = false
        lastNudge = emptyList()
    }

    private companion object {
        /**
         * 只问不做的工具:它们不动界面,连着换参数问同一件事就只是烧上下文。
         * 点击、滚动、输入不在里面——连续点是正常操作(列表里挨个点)。
         */
        val PROBE_TOOLS = setOf(
            "phone_system_command", "phone_query", "phone_observe", "phone_list_elements",
            "phone_extract", "phone_list_apps", "phone_screenshot", "phone_find", "phone_wait",
            // 通话状态是纯读(Risk.Read、不写日志、只调 port.state()),和上面几个同类。
            // 接入通话功能时漏了这一项,导致模型反复查「电话现在什么状态」不会触发提醒——
            // 实测一轮里 phone_call_state 被调了 8 次,这条规则一次都没管。
            "phone_call_state",
        )
    }
}
