package com.wangzan101.mika.core.replay

import com.wangzan101.mika.core.record.Redactor
import com.wangzan101.mika.core.record.RunEvent
import com.wangzan101.mika.core.tool.ToolIndex
import com.wangzan101.mika.core.tool.Verb
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.UUID

/**
 * 把一次办成的运行记成路线。只看 [RunEvent.ActionTarget] 与接管、追问、确认、障碍、结局一类事件;
 * 有任何一项说明这次不该记(要用户出手、付款、密码框、防截屏、用了浏览器工具或沙箱工具),返回 null。
 */
object RouteRecorder {
    /** 用过就说明这次做法离不开用户或别的通道,照着回放不安全。 */
    private val NO_ROUTE_VERBS = setOf(Verb.AskUser, Verb.RequestConfirmation, Verb.HandToUser)

    /**
     * 不看界面、直接跑命令的工具:结果来自命令输出,路线里根本记不下。
     * 一次运行只要用过其中一个,整条不记,否则会留下「只打开 App 一步」的路线,
     * 回放时走完这一步就当成整件事办完、把工具面收窄到只读。
     */
    private val NO_ROUTE_COMMANDS = setOf(Verb.PhoneCommand, Verb.RootCommand, Verb.RunCommand, Verb.RunBundledScript, Verb.SiteCommand)
    private val WAITING_STATES = setOf("waiting_input", "waiting_takeover", "no_answer")
    private val PROTECTED = Regex("\"protected\"\\s*:\\s*true|\"state\"\\s*:\\s*\"protected\"")
    private val NOT_SECRET = Regex("\"secret\"\\s*:\\s*false")

    /** 槽值至少这么长:太短的字在原话里容易碰巧出现。 */
    private const val MIN_SLOT = 2
    /** 工具结果里明确说办成了。 */
    private val OK = Regex("\"ok\"\\s*:\\s*true")

    /**
     * 输入的字只能是本次原话里恰好出现一次的片段(记成槽);不是的(固定词、追问来的、从别处抄来的)整条不记,
     * 路线里永远不存用户没在原话里说过的字。目标元素的名字在原话里出现时也必须绑成槽,回放时按新原话认。
     * 办没办成由调用方按 [com.wangzan101.mika.core.agent.LearnGate] 判过才来记,这里只看路线本身记不记得下。
     */
    fun record(goal: String, events: List<RunEvent>, nowMs: Long, tools: ToolIndex): Route? {
        if (events.lastOrNull { it is RunEvent.TaskEnded }?.let { (it as RunEvent.TaskEnded).outcome } != "succeeded") return null
        if (events.any { spoils(it, tools) }) return null
        // 缺步就不记。启动类动作(打开 App、打开链接)本来就没有目标元素,不算缺步:回放按「到了目标那里」核对。
        if (events.any { it is RunEvent.ActionTarget && it.incomplete && tools.verb(it.tool) !in OPENS }) return null
        // 有一次界面动作没生效(点了没反应、字没打进去):后面成功的那几步可能靠了它本该带来的变化,
        // 照着回放会缺一步(例如搜索框没输入,回放却直接点了搜索)。
        // 复合工具内部的子动作(source=script)本来就不进 acts,它们的失败已经由复合工具自己的结果反映;
        // 这类失败不单独作废整条路线,否则 phone_find 里滚动失败一次,连前面的 launch 都记不下来。
        if (events.any {
                it is RunEvent.ToolResult && it.source != "script" && tools[it.tool]?.routable == true &&
                    !OK.containsMatchIn(it.resultJson)
            }) return null

        // 回退依赖「当时在哪」,不能进路线。这里要单独看原始事件而不是靠 routable 过滤:
        // 它挪走过的层级是后面每一步的前提,把它从步骤里删掉相当于少退一级,路线一样走错。
        // 所以只要这次运行用过回退,整条就不记——不记就每次正常调模型,比记一条看起来走完、其实停在别处的路线好。
        if (events.filterIsInstance<RunEvent.ActionTarget>().any { tools.verb(it.tool) == Verb.Back && it.effective }) return null
        val acts = events.filterIsInstance<RunEvent.ActionTarget>().filter { it.effective && tools[it.tool]?.routable == true }
        if (acts.isEmpty() || acts.size > MAX_ROUTE_STEPS || acts.any { it.protected }) return null
        val results = events.filterIsInstance<RunEvent.ToolResult>()

        // 槽值按第一次用到的先后编号
        val slots = mutableListOf<String>()
        fun bind(v: String): Boolean {
            if (v in slots) return true
            if (v.trim().length < MIN_SLOT || occurrences(goal, v) != 1) return false
            slots += v
            return true
        }
        val args = mutableListOf<JsonObject>()
        val targets = mutableListOf<Selector?>()
        for (a in acts) {
            val o = parse(a.argsJson) ?: return null
            var cleaned = o.filterKeys { it != "ref" && it != "snapshotId" && it != "target" }
            if (tools.verb(a.tool)?.let { it in FINDS } == true) {
                // 查找条件里的字如果是本次原话的一部分,绑成槽,换一句原话也能按新词找;
                // 不是原话里的(例如界面上的英文标签)照原样留着,同一套界面回放仍然可用。
                val text = (o["text"] as? JsonPrimitive)?.contentOrNull
                if (text != null && text in goal) {
                    if (!bind(text)) return null
                    cleaned = cleaned + ("text" to JsonPrimitive("{${slots.indexOf(text) + 1}}"))
                }
            }
            if (tools.verb(a.tool) == Verb.TypeText) {
                val text = (o["text"] as? JsonPrimitive)?.contentOrNull ?: return null
                // 端口没明确说不是密码框的输入一律不记
                if (text == Redactor.MASK) return null
                val r = a.callId?.let { id -> results.lastOrNull { it.callId == id } } ?: return null
                if (!NOT_SECRET.containsMatchIn(r.resultJson)) return null
                if (!bind(text)) return null
                cleaned = cleaned + ("text" to JsonPrimitive("{${slots.indexOf(text) + 1}}"))
            }
            args += JsonObject(cleaned)
            targets += a.target?.let { t ->
                val n = t.name
                when {
                    n.isEmpty() -> t
                    n in goal -> if (bind(n)) t.copy(name = "{${slots.indexOf(n) + 1}}") else return null
                    // 名字里夹着本次的参数(如「发给张三」):不按名字认
                    slots.any { it in n } -> t.copy(name = "", uniqueAtRecord = false)
                    else -> t
                }
            }
        }
        // 槽在原话里的位置不能互相重叠(短的被长的吞掉就没法单独换)
        val ranges = slots.map { v -> goal.indexOf(v).let { it until it + v.length } }
        if (ranges.indices.any { i -> ranges.indices.any { j -> i < j && ranges[i].first <= ranges[j].last && ranges[j].first <= ranges[i].last } }) return null
        var template = goal
        ranges.withIndex().sortedByDescending { it.value.first }.forEach { (i, r) -> template = template.replaceRange(r, "{${i + 1}}") }

        fun anchors(a: Anchors, target: Selector?) = Anchors(a.packageName, a.texts.map(String::trim).filter { s ->
            RouteAnchors.stable(s) && s != target?.name?.trim() && slots.none { it.trim() in s }
        }.distinct().take(RouteAnchors.MAX))

        val steps = acts.mapIndexed { i, a -> RouteStep(a.tool, args[i].toString(), targets[i], anchors(a.before, a.target), anchors(a.after, null)) }
        val packages = (acts.mapNotNull { a -> if (tools.verb(a.tool) == Verb.LaunchApp) parse(a.argsJson)?.get("package")?.let { (it as? JsonPrimitive)?.contentOrNull } else null } +
            acts.flatMap { listOfNotNull(it.before.packageName, it.after.packageName) }).distinct()
        val route = Route(UUID.randomUUID().toString(), template, slots.size, packages, emptyMap(), steps, lastUsedMs = nowMs)
        return route.takeIf { RouteCodec.encode(it).toByteArray().size <= MAX_ROUTE_BYTES }
    }

    private fun occurrences(s: String, v: String): Int {
        var n = 0; var i = s.indexOf(v)
        while (i >= 0) { n++; i = s.indexOf(v, i + 1) }
        return n
    }

    private fun spoils(e: RunEvent, tools: ToolIndex): Boolean = when (e) {
        is RunEvent.Takeover, is RunEvent.Confirmation -> true
        is RunEvent.State -> e.name in WAITING_STATES
        is RunEvent.Barrier -> e.kind == "payment"
        is RunEvent.ModelReply -> e.tool?.let { barred(it, tools) } == true
        is RunEvent.ToolResult -> barred(e.tool, tools) || PROTECTED.containsMatchIn(e.resultJson)
        is RunEvent.ActionTarget -> barred(e.tool, tools)
        else -> false
    }

    /** 路线只记能回放的那种界面上的做法:用过别的能力(网页、沙箱)的工具,照着回放不完整。 */
    private fun barred(tool: String, tools: ToolIndex): Boolean {
        val t = tools[tool] ?: return false
        if (t.verb in NO_ROUTE_VERBS) return true
        // 屏幕外的命令不在路线上:回放不会重跑它们,靠它们得出的答案也就没了。
        // 不记这条,比记一条只剩「打开 App」、却被当成整件事都办过的路线好——后者回放完就把工具面收窄到只读,模型再想用命令也没得用。
        if (t.verb in NO_ROUTE_COMMANDS) return true
        val routed = tools.names.mapNotNull { tools[it]?.takeIf { i -> i.routable }?.capability }.toSet()
        return t.capability != null && t.capability !in routed
    }

    private fun parse(s: String): JsonObject? = try { Json.parseToJsonElement(s) as? JsonObject } catch (e: Exception) { null }
}
