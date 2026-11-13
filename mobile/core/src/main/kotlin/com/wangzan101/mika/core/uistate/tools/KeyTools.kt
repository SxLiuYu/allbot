package com.wangzan101.mika.core.uistate.tools

import com.wangzan101.mika.core.uistate.ScreenFamily
import com.wangzan101.mika.core.risk.GateTarget
import com.wangzan101.mika.core.tool.ArgError
import com.wangzan101.mika.core.tool.Args
import com.wangzan101.mika.core.uistate.PressKeys
import com.wangzan101.mika.core.tool.Risk
import com.wangzan101.mika.core.tool.ToolContext
import com.wangzan101.mika.core.tool.ToolDef
import com.wangzan101.mika.core.tool.ToolExecution
import com.wangzan101.mika.core.tool.Verb
import com.wangzan101.mika.core.tool.argStr
import com.wangzan101.mika.core.tool.str
import kotlinx.serialization.json.JsonObject
import com.wangzan101.mika.core.uistate.action
import com.wangzan101.mika.core.uistate.screen

internal class Back(f: ScreenFamily) : ScreenTool(f, "back") {
    override val verb = Verb.Back
    override val batchable = true
    // 照常采集锚点(运行的记录里要能看出当时在哪一级),但 RouteRecorder 不把带回退的运行记成路线:
    // 「回到上一级」做得对不对取决于当时在哪,录制和回放的起点常常不同,同一个回退会退多一级,
    // 而它照样返回成功,后面每一步就都在错的页面上做。
    // 实测 files-count 的路线记成「开文件管理 → 回退 → 点 Download」,回放时回退把刚进的应用首页退掉了,
    // 模型照着根目录内容答了「11 个文件夹」,真实答案是 99 项。
    override val routable = f.routable
    override val label = "返回"
    override val risk = Risk.Write
    override val showsScreenAfter = true
    override val reportsEffect = true
    override val logged = true
    override val def by lazy { ToolDef(name, describe()) }

    override suspend fun execute(a: Args, ctx: ToolContext) = ctx.action(ctx.screen.back())
}

/** 按键(回车、确认键可能是提交,要按目标判不可逆)。 */
internal class PressKey(f: ScreenFamily) : ScreenTool(f, "press_key") {
    override val verb = Verb.PressKey
    override val batchable = true
    override val routable = f.routable
    override val label = "按键"
    override val risk = Risk.External
    override val gateTarget = GateTarget.Key
    override val showsScreenAfter = true
    override val reportsEffect = true
    override val logged = true
    override val def by lazy { ToolDef(name, describe(),
        mapOf("key" to str("One of the allowed KEYCODE_* names, or its numeric keycode string.")), listOf("key")) }

    override suspend fun execute(a: Args, ctx: ToolContext): ToolExecution {
        val k = a.str("key")!!.trim()
        val code = PressKeys.resolve(k)
            ?: throw ArgError("key", "key '$k' is not allowed; only navigation/editing keys: ${keyNames(family)}")
        family.keys?.let { if (code !in it) throw ArgError("key", family.keysHint ?: "key '$k' is not allowed here") }
        return ctx.action(ctx.screen.pressKey(code))
    }

    override fun logTarget(o: JsonObject, r: ToolExecution, ctx: ToolContext) = o.argStr("key")
}
