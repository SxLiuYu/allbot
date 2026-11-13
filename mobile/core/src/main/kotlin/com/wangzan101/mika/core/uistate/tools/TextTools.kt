package com.wangzan101.mika.core.uistate.tools

import com.wangzan101.mika.core.uistate.ScreenFamily
import com.wangzan101.mika.core.risk.GateTarget
import com.wangzan101.mika.core.prompt.Feedback
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.Verification
import com.wangzan101.mika.core.tool.ArgError
import com.wangzan101.mika.core.tool.Args
import com.wangzan101.mika.core.uistate.DESCRIBED_ELEMENT
import com.wangzan101.mika.core.uistate.DESCRIBED_ROLE
import com.wangzan101.mika.core.uistate.UnseenField
import com.wangzan101.mika.core.tool.COORD
import com.wangzan101.mika.core.tool.LOCATED_REF
import com.wangzan101.mika.core.tool.REF
import com.wangzan101.mika.core.tool.Risk
import com.wangzan101.mika.core.tool.SNAP
import com.wangzan101.mika.core.tool.ToolContext
import com.wangzan101.mika.core.tool.ToolDef
import com.wangzan101.mika.core.tool.ToolExecution
import com.wangzan101.mika.core.tool.Verb
import com.wangzan101.mika.core.tool.argStr
import com.wangzan101.mika.core.tool.bool
import com.wangzan101.mika.core.tool.fail
import com.wangzan101.mika.core.tool.int
import com.wangzan101.mika.core.tool.okObj
import com.wangzan101.mika.core.tool.str
import com.wangzan101.mika.core.tool.switchHint
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import com.wangzan101.mika.core.uistate.action
import com.wangzan101.mika.core.uistate.lastOrSnapshot
import com.wangzan101.mika.core.uistate.locatedInfo
import com.wangzan101.mika.core.uistate.toPx
import com.wangzan101.mika.core.uistate.lastSnapshot
import com.wangzan101.mika.core.uistate.screen
import com.wangzan101.mika.core.uistate.visibleTextNow
import com.wangzan101.mika.core.uistate.withPortRef

private const val KEYCODE_ENTER = 66

/** 输入、清空另收的参数:一个点的坐标(ref 也可以是看图找到的 @vN),树读不到输入框时直接往那一点打字。 */
private val POINT_ARGS = mapOf(
    "x" to int("Instead of a ref: the input box's point (e.g. a visibleText center), tapped before typing. $COORD", 0, 999),
    "y" to int(COORD, 0, 999),
)

/** 往哪儿打字:树里的元素(编号),或一个点(像素;[located] 是看图找到的 @vN,不是为 null)。 */
private sealed interface FieldAim {
    data class Ref(val ref: Pair<String, String>?) : FieldAim
    data class Point(val x: Int, val y: Int, val located: String?) : FieldAim
}

/**
 * 按参数定往哪儿打字:没给点时是编号(或焦点所在的框);给了坐标或 @vN 时是那一点,@vN 要和找到时的画面对得上。
 * 不能用的 @vN 返回给模型的失败结果。
 */
private suspend fun aim(a: Args, ctx: ToolContext): Pair<FieldAim?, ToolExecution?> {
    val ref = a.ref(located = true, knownSnapshot = ctx.lastSnapshot?.snapshotId)
    val x = a.coord("x")
    val y = a.coord("y")
    if (ref != null && (x != null || y != null)) throw ArgError("x", "give either ref+snapshotId or x+y, not both")
    if ((x == null) != (y == null)) throw ArgError(if (x == null) "x" else "y", "x and y go together")
    if (ref != null && LOCATED_REF.matches(ref.first)) {
        val p = locatedPixel(ctx, ref.first, ref.second) ?: return null to fail("ref_expired", Feedback["located_stale"])
        return FieldAim.Point(p.first, p.second, ref.first) to null
    }
    if (x != null && y != null) {
        val s = ctx.lastOrSnapshot()
        return FieldAim.Point(toPx(x, s.width), toPx(y, s.height), null) to null
    }
    return FieldAim.Ref(ref) to null
}

/** 往看图找到的点上打字、清空时结果里写上找的是什么;没佐证的点标出来。 */
private fun located(ctx: ToolContext, aim: FieldAim?, r: ToolExecution): ToolExecution {
    val ref = (aim as? FieldAim.Point)?.located ?: return r
    val info = ctx.locatedInfo[ref] ?: return r
    val extra = listOfNotNull(info.target?.let { "located" to JsonPrimitive(it) }, ("unverifiedPoint" to JsonPrimitive(true)).takeIf { info.unverified })
    return if (extra.isEmpty()) r else r.with(content = JsonObject(r.content + extra))
}

/** 输入(带回车时可能是发送,要按目标判不可逆)。 */
internal class TypeText(f: ScreenFamily) : ScreenTool(f, "type_text") {
    override val verb = Verb.TypeText
    override val batchable = true
    override val routable = f.routable
    override val label = "输入文字"
    override val risk = Risk.External
    override val gateTarget = GateTarget.Enter
    override val showsScreenAfter = true
    override val reportsEffect = true
    override val logged = true
    override val def by lazy { ToolDef(name,
        describe(),
        mapOf(
            "text" to buildJsonObject { put("type", "string"); put("description", "Text to enter, 1-10000 characters."); put("minLength", 1); put("maxLength", 10000) },
            "pressEnter" to bool("Press Enter after typing (default false)."),
            "ref" to str(REF), "snapshotId" to str(SNAP),
            DESCRIBED_ELEMENT to str("Instead of ref+snapshotId: the input field's label, accessible name or placeholder, as shown on the screen. It must match exactly one input field on the screen right now."),
            DESCRIBED_ROLE to str(DESCRIBE_ROLE),
        ) + POINT_ARGS, listOf("text")) }

    override suspend fun execute(a: Args, ctx: ToolContext): ToolExecution {
        if (a.str(DESCRIBED_ELEMENT) != null) throw ArgError(DESCRIBED_ELEMENT, "could not be resolved to an input field here; use ref+snapshotId")
        val text = a.str("text", max = 10000)!!
        val enter = a.bool("pressEnter", false)
        val (target, failed) = aim(a, ctx)
        failed?.let { return it }
        // 框在屏上的纵向位置(0–999):读不回框时拿屏上这块地方的字交叉核对
        val fieldY = when (target) {
            is FieldAim.Point -> gridY(target.y, ctx)
            is FieldAim.Ref -> refY(target.ref, ctx)
            null -> null
        }
        // 盲区里(树读不到框)同一段字只许写一次:屏上已经两份,或上次没确认、现在还在,都先让模型清空或读屏
        if (target is FieldAim.Point) {
            val near = UnseenField.near(ctx.visibleTextNow(), fieldY!!)
            if (UnseenField.duplicated(near, text)) return duplicated()
            if (ctx.unconfirmedTyped == text && UnseenField.shows(near, text)) return unconfirmed()
        }
        return when (target) {
            is FieldAim.Point -> located(ctx, target, typeInto(ctx, text, enter, fieldY) { ctx.screen.typeAt(target.x, target.y, text) })
            else -> ctx.withPortRef((target as FieldAim.Ref).ref) { ref -> typeInto(ctx, text, enter, fieldY) { ctx.screen.typeText(ref?.first, ref?.second, text) } }
        }
    }

    private suspend fun typeInto(ctx: ToolContext, text: String, enter: Boolean, fieldY: Int?, type: suspend () -> ActionResult): ToolExecution {
        val screen = ctx.screen
        val typed = type()
        if (typed !is ActionResult.Ok) return ctx.action(typed)
        val v = typed.verification
        val visible = if (v != Verification.MATCH) ctx.visibleTextNow() else null
        // 粘贴路径上全选没生效时,字会叠进框里;读不回框就看屏上这段字是不是连着两份
        if (visible != null && UnseenField.duplicated(visible, text)) {
            ctx.unconfirmedTyped = text
            return duplicated()
        }
        // 有的框读不回自己的字(网页画布里的搜索框、混淆了 id 的输入框),字其实已经进去了:
        // 屏上这一块能看到这段字时报「没核对上」,不要报「没写进去」——后者会让模型再写一遍,叠成两份
        val seenOnScreen = fieldY != null && UnseenField.shows(UnseenField.near(visible, fieldY), text)
        if (v == Verification.MISMATCH && !seenOnScreen) return ToolExecution(buildJsonObject {
            put("ok", false); put("error", "action_not_applied"); put("verification", v.wire)
            put("message", Feedback["type.not_applied"])
            put("recoverable", true)
        })
        val reported = if (v == Verification.MISMATCH) Verification.UNKNOWN else v
        // 读不回来就先记下这段字:模型再写同一段(没先确认/清空)时拦住它
        if (reported == Verification.MATCH) ctx.unconfirmedTyped = null else if (text.isNotBlank()) ctx.unconfirmedTyped = text
        val switched = typed.appSwitched
        // 读不回来就不按回车:可能把没打进去的内容提交出去;前台被切走时回车会打到别的 App 上
        val pressEnter = enter && reported != Verification.UNKNOWN && switched == null
        if (pressEnter) {
            val k = screen.pressKey(KEYCODE_ENTER)
            if (k !is ActionResult.Ok) return ctx.action(k)
        }
        return ToolExecution(okObj {
            put("typed", text.length); put("pressedEnter", pressEnter)
            put("secret", typed.secret)
            if (typed.relocated) put("relocated", true)
            typed.relocatedTo?.takeIf { typed.relocated }?.let { put("relocatedTo", it) }
            reported?.let { put("verification", it.wire) }
            if (reported == Verification.UNKNOWN) put("needsCheck", true)
            if (enter && !pressEnter) put("enterSkipped", true)
            switched?.let { put("app_switched", it) }
            val hints = listOfNotNull(
                typed.hint,
                (if (enter) Feedback.format("type.unverified_enter", "unverified" to Feedback["type.unverified"]) else Feedback["type.unverified"])
                    .takeIf { reported == Verification.UNKNOWN },
                switched?.let { switchHint(it, typed.switchedByTarget).let { h -> if (enter) Feedback.format("type.switched_enter", "switch" to h) else h } },
            )
            if (hints.isNotEmpty()) put("hint", hints.joinToString(" "))
        }, changed = typed.changed)
    }

    override fun logTarget(o: JsonObject, r: ToolExecution, ctx: ToolContext) = refTarget(o, r, ctx.lastSnapshot) ?: pointTarget(o)

    // 只有端口明确说不是密码框才写出输入的字
    override fun logTyped(o: JsonObject, r: ToolExecution) =
        o.argStr("text")?.takeIf { r.content["secret"] == JsonPrimitive(false) }?.let { "「${it.take(40)}」" }
}

internal class ClearText(f: ScreenFamily) : ScreenTool(f, "clear_text") {
    override val verb = Verb.ClearText
    override val batchable = true
    override val routable = f.routable
    override val label = "清空输入框"
    override val risk = Risk.Write
    override val showsScreenAfter = true
    override val reportsEffect = true
    override val logged = true
    override val def by lazy { ToolDef(name, describe(),
        mapOf("ref" to str(REF), "snapshotId" to str(SNAP)) + POINT_ARGS) }

    override suspend fun execute(a: Args, ctx: ToolContext): ToolExecution {
        val (target, failed) = aim(a, ctx)
        failed?.let { return it }
        val r = when (target) {
            is FieldAim.Point -> located(ctx, target, ctx.action(ctx.screen.clearAt(target.x, target.y)))
            else -> ctx.withPortRef((target as FieldAim.Ref).ref) { p -> ctx.action(ctx.screen.clearText(p?.first, p?.second)) }
        }
        // 清空了就不再拦同一段字的第二次输入
        if (r.content["ok"] == JsonPrimitive(true)) ctx.unconfirmedTyped = null
        return r
    }

    override fun logTarget(o: JsonObject, r: ToolExecution, ctx: ToolContext) = refTarget(o, r, ctx.lastSnapshot) ?: pointTarget(o)
}

/** 框里已经是两份一样的字:不再写,请模型先清空(提示里写清怎么清)。 */
private fun duplicated() = ToolExecution(buildJsonObject {
    put("ok", false); put("error", "duplicate_text")
    put("message", Feedback["type.duplicate"]); put("recoverable", true)
})

/** 同一段字刚写过但没核对上,屏上还看得到:再写只会叠一份,请模型先读屏或清空。 */
private fun unconfirmed() = ToolExecution(buildJsonObject {
    put("ok", false); put("error", "unconfirmed_type")
    put("message", Feedback["type.unconfirmed"]); put("recoverable", true)
})

/** 像素 y 换成读屏那套 0–999 坐标。 */
private suspend fun gridY(y: Int, ctx: ToolContext): Int = y * 999 / ctx.lastOrSnapshot().height.coerceAtLeast(1)

/** 按 ref 找到输入框在屏上的纵向中心(0–999);编号不是当前这一屏或找不到时为 null(那就不猜)。 */
private fun refY(ref: Pair<String, String>?, ctx: ToolContext): Int? {
    val (id, snap) = ref ?: return null
    val s = ctx.lastSnapshot ?: return null
    if (snap != null && s.snapshotId != snap) return null
    val el = s.elements.firstOrNull { it.ref == id } ?: return null
    if (el.bounds.size != 4) return null
    return (el.bounds[1] + el.bounds[3]) / 2
}

/** 往坐标点上打字、清空时动作清单里写的对象。 */
private fun pointTarget(o: JsonObject): String? = o["x"]?.let { x -> "${x},${o["y"]}" }
