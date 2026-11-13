package com.wangzan101.mika.settings

import com.wangzan101.mika.core.model.Capabilities
import com.wangzan101.mika.core.model.ChatModel
import com.wangzan101.mika.core.model.FallbackModel
import com.wangzan101.mika.core.model.ListedModel
import com.wangzan101.mika.core.model.Message
import com.wangzan101.mika.core.model.ModelReply
import com.wangzan101.mika.core.model.ModelRole
import com.wangzan101.mika.core.model.Part
import com.wangzan101.mika.core.model.StopReason
import com.wangzan101.mika.core.model.ToolSpec
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.KeyGenerator

/** 本地纯文本轻量模型:默认不用,灰度打开才交给旁路任务,且服务失败后整条任务走主模型。 */
class LocalLightProviderTest {
    @get:Rule val tmp = TemporaryFolder()
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private fun caps(tools: Boolean) = Capabilities(
        toolCalls = tools, vision = false, contextTokens = 8_192, reasoning = false,
    )

    /** 名为 local 的模型模拟本地服务不可用;其余按模型名回一段文字。 */
    private fun store() = ProviderStore(tmp.root, AesGcmKeyCipher { key }) { cfg, _, _, _ ->
        object : ChatModel {
            override val capabilities = cfg.capabilities
            override val name = cfg.model
            override suspend fun complete(system: String, messages: List<Message>, tools: List<ToolSpec>): ModelReply {
                if (cfg.model == "local") throw IllegalStateException("local service down")
                return ModelReply(listOf(Part.Text(cfg.model)), StopReason.EndTurn, null)
            }
        }
    }

    private fun connected(s: ProviderStore, name: String, url: String) =
        s.connect(name, ProviderConfig.Kind.OpenAiCompat, url, null, listOf(ListedModel("unused")))

    private fun configured(): ProviderStore {
        val s = store()
        val main = connected(s, "Remote", "https://remote.test/v1")
        val local = connected(s, "MNN", "http://192.168.1.10:8097/v1")
        assertTrue(s.use(ModelRole.Main, main.id, "main", caps(true)))
        assertTrue(s.use(ModelRole.Light, local.id, "local", caps(false)))
        return s
    }

    private suspend fun text(m: ChatModel) =
        (m.complete("s", emptyList(), emptyList()).parts.single() as Part.Text).text

    @Test fun textOnlyLightIsOffByDefault() = runTest {
        assertNull(configured().lightModelFor(localLight = false))
    }

    @Test fun grayFlagWrapsTextOnlyLightAndFallsBackOnce() = runTest {
        val m = configured().lightModelFor(localLight = true)!!
        assertTrue(m is FallbackModel)
        assertFalse("不会被 ModelRouter 派去跑操作步骤", m.capabilities.toolCalls)
        assertEquals("local", m.name)
        assertEquals("main", text(m))
        assertEquals("main", text(m))
        assertEquals("回退后记录用的名字切到主模型", "main", m.name)
    }

    @Test fun toolCapableLightIsUnaffectedByFlag() = runTest {
        val s = store()
        val main = connected(s, "Remote", "https://remote.test/v1")
        val light = connected(s, "Fast", "https://fast.test/v1")
        assertTrue(s.use(ModelRole.Main, main.id, "main", caps(true)))
        assertTrue(s.use(ModelRole.Light, light.id, "fast", caps(true)))
        val off = s.lightModelFor(localLight = false)!!
        val on = s.lightModelFor(localLight = true)!!
        assertFalse(off is FallbackModel)
        assertFalse(on is FallbackModel)
        assertEquals("fast", text(off))
    }

    @Test fun sameConfigAsMainIsNeverWrapped() = runTest {
        val s = store()
        val main = connected(s, "Remote", "https://remote.test/v1")
        assertTrue(s.use(ModelRole.Main, main.id, "main", caps(true)))
        assertTrue(s.choose(ModelRole.Light, RoleChoice.SameAsMain))
        val m = s.lightModelFor(localLight = true)!!
        assertFalse(m is FallbackModel)
        assertEquals("main", text(m))
    }
}
