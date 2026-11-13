package com.wangzan101.mika.core.replay

import com.wangzan101.mika.core.agent.FakeModel
import com.wangzan101.mika.core.model.ModelReply
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.StopReason
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class MemRoutes(vararg r: Route) : RouteStore {
    val m = linkedMapOf<String, Route>().apply { r.forEach { put(it.id, it) } }
    override fun all() = m.values.toList()
    override fun put(r: Route) { m[r.id] = r }
    override fun remove(id: String) { m.remove(id) }
    override fun clear() = m.clear()
    override fun count() = m.size
}

class RouteMatcherTest {
    private fun text(s: String) = ModelReply(listOf(Part.Text(s)), StopReason.EndTurn, null)
    private val memo = Route("m", "在备忘录里写{1}", 1, listOf("com.notes"), emptyMap(), emptyList(), lastUsedMs = 0)
    private val goal = "在备忘录里写今天天气不错"

    @Test fun noCandidatesNoModelCall() = runTest {
        val m = FakeModel()
        assertNull(RouteMatcher(m, MemRoutes(memo), null).choose("打开计算器算一下"))
        assertTrue(m.requests.isEmpty())
        assertNull(RouteMatcher(m, MemRoutes(), null).choose(goal))
        assertTrue(m.requests.isEmpty())
    }

    @Test fun choosesWithSlotsFromGoal() = runTest {
        val m = FakeModel(text("""好的 {"route": 1, "slots": ["今天天气不错"]}"""))
        assertEquals(RouteChoice(memo, listOf("今天天气不错")), RouteMatcher(m, MemRoutes(memo), null).choose(goal))
        assertEquals(1, m.requests.size)
    }

    @Test fun slotNotInGoalRejected() = runTest {
        val m = FakeModel(text("""{"route": 1, "slots": ["明天开会"]}"""))
        assertNull(RouteMatcher(m, MemRoutes(memo), null).choose(goal))
    }

    @Test fun slotsMustAlignWithTemplate() = runTest {
        val msg = memo.copy(id = "c", template = "给{1}发消息说{2}", slots = 2)
        // 「张三」只是「张三丰」的一部分:填回模板得不到原话
        assertNull(RouteMatcher(FakeModel(text("""{"route": 1, "slots": ["张三", "晚上好"]}""")), MemRoutes(msg), null).choose("给张三丰发消息说晚上好"))
        // 原话多了模板里没有的要求
        assertNull(RouteMatcher(FakeModel(text("""{"route": 1, "slots": ["今天天气不错"]}""")), MemRoutes(memo), null).choose("在备忘录里写今天天气不错并置顶"))
        // 槽值在原话里出现不止一次
        assertNull(RouteMatcher(FakeModel(text("""{"route": 1, "slots": ["好", "好"]}""")), MemRoutes(msg), null).choose("给好发消息说好"))
        // 只差空白:算同一句
        assertEquals(RouteChoice(msg, listOf("张三丰", "晚上好")),
            RouteMatcher(FakeModel(text("""{"route": 1, "slots": ["张三丰", "晚上好"]}""")), MemRoutes(msg), null).choose("给 张三丰 发消息说晚上好"))
    }

    @Test fun malformedJsonIsNull() = runTest {
        for (bad in listOf("不知道", """{"route": "一"}""", """{"route": 1, "slots": ["a", "b"]}""", """{"route": 7, "slots": []}""", """{"route": null}""")) {
            assertNull(bad, RouteMatcher(FakeModel(text(bad)), MemRoutes(memo), null).choose(goal))
        }
        assertNull(RouteMatcher(FakeModel(RuntimeException("down")), MemRoutes(memo), null).choose(goal))
    }

    @Test fun disabledRoutesExcluded() {
        val off = memo.copy(id = "off", disabled = true)
        assertEquals(listOf("m"), RouteMatcher(FakeModel(), MemRoutes(memo, off), null).candidates(goal).map { it.id })
        assertTrue(RouteMatcher(FakeModel(), MemRoutes(off), null).candidates(goal).isEmpty())
    }

    @Test fun candidatesRankedAndLimited() {
        val routes = (1..7).map { memo.copy(id = "r$it", template = "在备忘录里写{1}" + "很".repeat(it)) }
        val got = RouteMatcher(FakeModel(), MemRoutes(*routes.toTypedArray()), null).candidates(goal)
        assertEquals(listOf("r1", "r2", "r3", "r4", "r5"), got.map { it.id })
    }

    @Test fun singleExactRouteSkipsTheModelCall() = runTest {
        // 有一个候选没有槽、模板与原话逐字相同:选它不需要问模型
        val exact = memo.copy(id = "x", template = goal, slots = 0)
        val m = FakeModel()
        assertEquals(RouteChoice(exact, emptyList()), RouteMatcher(m, MemRoutes(exact), null).choose(goal))
        assertTrue(m.requests.isEmpty())
        // 同一个 App 的其他路线也会进候选(按包名带进来的),它们不影响这个判断
        val sibling = memo.copy(id = "s", template = "在备忘录里写一篇周报", slots = 0)
        val m2 = FakeModel()
        assertEquals(RouteChoice(exact, emptyList()), RouteMatcher(m2, MemRoutes(sibling, exact), null).choose(goal))
        assertTrue(m2.requests.isEmpty())
    }

    @Test fun singleInexactRouteStillAsksTheModel() = runTest {
        // 模板和原话不完全一样(这里是槽值)、或恰好有两条都叫这个名字时,仍然让模型选
        val m = FakeModel(text("""{"route": 1, "slots": ["今天天气不错"]}"""))
        assertEquals(RouteChoice(memo, listOf("今天天气不错")), RouteMatcher(m, MemRoutes(memo), null).choose(goal))
        assertEquals(1, m.requests.size)

        // 两条模板都逐字等于原话:分不出来,交给模型
        val twin = memo.copy(id = "n", template = goal, slots = 0)
        val both = FakeModel(text("""{"route": 1, "slots": []}"""))
        assertEquals(RouteChoice(twin, emptyList()), RouteMatcher(both, MemRoutes(twin, twin.copy(id = "n2")), null).choose(goal))
        assertEquals(1, both.requests.size)
    }

    @Test fun rephrasedRouteSkipsTheModelCall() = runTest {
        // 同一句话换个说法(无槽):直接选它,不问模型
        val r = memo.copy(id = "dial", template = "打开拨号应用，告诉我屏幕上有什么按钮", slots = 0, packages = listOf("com.android.contacts"))
        for (said in listOf("把拨号应用打开，告诉我屏幕上有啥按钮", "帮我打开拨号，屏幕上有什么按钮", "打开拨号，看看屏幕上有什么按钮")) {
            val m = FakeModel()
            assertEquals(said, RouteChoice(r, emptyList()), RouteMatcher(m, MemRoutes(r), null).choose(said))
            assertTrue(said, m.requests.isEmpty())
        }
    }

    @Test fun lowSimilarityStillAsksTheModel() = runTest {
        // 「打开拨号看看有什么按钮呀」只到 0.333:过了进候选的 0.3,过不了走捷径的 0.35,仍问模型
        val r = memo.copy(id = "dial", template = "打开拨号应用，告诉我屏幕上有什么按钮", slots = 0, packages = listOf("com.android.contacts"))
        val m = FakeModel()
        RouteMatcher(m, MemRoutes(r), null).choose("打开拨号看看有什么按钮呀")
        assertEquals(1, m.requests.size)
    }

    @Test fun differentTaskOnSameAppStillAsksTheModel() = runTest {
        // 同一个 App、同一批词,但办的是另一件事:「第一个通知是什么」不是「第一个分类的名字」
        val r = memo.copy(id = "first", template = "打开设置，告诉我当前屏幕上第一个分类的名字", slots = 0, packages = listOf("com.android.settings"))
        val said = "打开设置，告诉我第一个通知是什么"
        val m = FakeModel(text("""{"route": null, "slots": []}"""))
        assertNull(RouteMatcher(m, MemRoutes(r), null).choose(said))
        assertEquals(1, m.requests.size)
    }

    @Test fun twoSimilarRoutesStillAskTheModel() = runTest {
        // 两条都够像、且分不开:省这一次调用是赌,交给模型
        val a = memo.copy(id = "a", template = "打开设置，告诉我第一个分类的名字", slots = 0, packages = listOf("com.android.settings"))
        val b = memo.copy(id = "b", template = "打开设置，告诉我第一个分类叫什么", slots = 0, packages = listOf("com.android.settings"))
        val m = FakeModel(text("""{"route": 1, "slots": []}"""))
        RouteMatcher(m, MemRoutes(a, b), null).choose("打开设置，告诉我第一个分类是啥")
        assertEquals(1, m.requests.size)
    }

    @Test fun rephrasedSlotRouteStillAsksTheModel() = runTest {
        // 有槽的路线不能走捷径,哪怕相似度过得了门槛(这里 0.417):槽值要从原话里抽,那是模型的工作
        val withSlot = memo.copy(id = "s", template = "在备忘录里写{1}", slots = 1, packages = listOf("com.notes"))
        val m = FakeModel()
        RouteMatcher(m, MemRoutes(withSlot), null).choose("在备忘录里写下今天天气不错")
        assertEquals(1, m.requests.size)
    }
}
