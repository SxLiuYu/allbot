package com.wangzan101.mika.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.wangzan101.mika.ChineseUi
import com.wangzan101.mika.calls.CallBackendKind
import com.wangzan101.mika.calls.CallConfig
import com.wangzan101.mika.ui.theme.MikaTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 通话服务选择弹窗：选类型、填地址、保存时写回什么。
 *
 * 这里验的是弹窗自己的判定——保存出去的 [CallConfig] 是否只带当前类型需要的字段。
 * 落盘的可用性判定在 `CallSettings.save`（有单测），本测试只用一个记录调用的 `onSave`，
 * 不碰 SharedPreferences。
 */
@RunWith(AndroidJUnit4::class)
class CallBackendDialogTest {
    @get:Rule(order = Int.MIN_VALUE) val chinese = ChineseUi()

    @get:Rule val compose = createComposeRule()

    private var saved: CallConfig? = null
    private var dismissed = false
    private var saveResult = true

    private fun show(config: CallConfig = CallConfig()) = compose.setContent {
        MikaTheme(dark = false) {
            CallBackendDialog(
                config = config,
                onDismiss = { dismissed = true },
                onSave = { next -> saved = next; saveResult },
            )
        }
    }

    @Test
    fun unconfiguredStartsOnCloudWithSaveBlockedUntilAddressGiven() {
        show()

        compose.onNodeWithTag("call-backend-dialog").assertIsDisplayed()
        // 没配过时默认停在云端，但地址为空，保存不可点：否则会存出一个「选了云端却没地址」。
        compose.onNodeWithTag("call-backend-save").assertIsNotEnabled()
        compose.onNodeWithTag("call-backend-endpoint").assertIsDisplayed()
    }

    @Test
    fun cloudSavesKindAndEndpoint() {
        show()

        compose.onNodeWithTag("call-backend-endpoint").performTextInput("wss://voice.example.com/ws")
        compose.onNodeWithTag("call-backend-save").assertIsEnabled().performClick()
        compose.waitForIdle()

        assertEquals(CallBackendKind.CLOUD, saved?.backendKind)
        assertEquals("wss://voice.example.com/ws", saved?.localEndpoint)
        assertTrue(dismissed)
    }

    @Test
    fun customAlsoNeedsAddress() {
        show()

        compose.onNodeWithText("自建服务").performClick()
        compose.onNodeWithTag("call-backend-save").assertIsNotEnabled()
        compose.onNodeWithTag("call-backend-endpoint").performTextInput("ws://10.0.0.5:9000/ws")
        compose.onNodeWithTag("call-backend-save").assertIsEnabled().performClick()
        compose.waitForIdle()

        assertEquals(CallBackendKind.CUSTOM, saved?.backendKind)
        assertEquals("ws://10.0.0.5:9000/ws", saved?.localEndpoint)
    }

    @Test
    fun switchingToVolcengineDropsTheEndpoint() {
        show(CallConfig(localEndpoint = "wss://voice.example.com/ws", credentialsConfigured = true))

        compose.onNodeWithText("火山引擎").performClick()
        compose.onNodeWithTag("call-backend-save").assertIsEnabled().performClick()
        compose.waitForIdle()

        assertEquals(CallBackendKind.VOLCENGINE, saved?.backendKind)
        // 地址必须清掉：两个来源同时留着，会说不清「现在到底连哪个」。
        assertNull(saved?.localEndpoint)
    }

    @Test
    fun volcengineWithoutCredentialsCannotSave() {
        show(CallConfig(credentialsConfigured = false))

        compose.onNodeWithText("火山引擎").performClick()

        compose.onNodeWithTag("call-backend-save").assertIsNotEnabled()
        compose.onNodeWithText("请先配置通话服务。").assertIsDisplayed()
    }

    @Test
    fun failedSaveKeepsDialogOpen() {
        saveResult = false
        show()

        compose.onNodeWithTag("call-backend-endpoint").performTextInput("wss://voice.example.com/ws")
        compose.onNodeWithTag("call-backend-save").performClick()
        compose.waitForIdle()

        // 存失败要留在页面上并报错，不能静默关掉让人以为生效了。
        assertTrue(!dismissed)
        compose.onNodeWithTag("call-backend-dialog").assertIsDisplayed()
    }

    @Test
    fun clearingEndpointDisablesSave() {
        show(CallConfig(localEndpoint = "wss://voice.example.com/ws", backendKind = CallBackendKind.CLOUD))

        compose.onNodeWithTag("call-backend-save").assertIsEnabled()
        compose.onNodeWithTag("call-backend-endpoint").performTextClearance()

        compose.onNodeWithTag("call-backend-save").assertIsNotEnabled()
    }
}
