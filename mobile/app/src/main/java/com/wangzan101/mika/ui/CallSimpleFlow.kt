package com.wangzan101.mika.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.activity.compose.BackHandler
import androidx.compose.ui.Modifier
import com.wangzan101.mika.R
import com.wangzan101.mika.calls.CallRuntime
import com.wangzan101.mika.ui.components.PageScaffold
import com.wangzan101.mika.ui.components.FooterNote
import com.wangzan101.mika.ui.components.GroupCard
import com.wangzan101.mika.ui.components.ListRow
import com.wangzan101.mika.ui.components.RowChevron
import com.wangzan101.mika.ui.theme.MikaIcons
import kotlinx.coroutines.launch

/** 精简电话界面里的四个页面。用可保存的枚举而不是布尔堆，回退时状态一致。 */
private enum class SimplePage { Home, Setup, Advanced, History }

/**
 * 精简电话界面的导航：首页、初始化向导、高级设置、通话记录。
 *
 * 页面之间只靠回调切换，不认识彼此。历史页直接复用 [CallHistorySection]，所以记录格式、
 * 加密、删除和回填逻辑与旧界面完全一致。
 */
@Composable
internal fun CallSimpleFlow(
    runtime: CallRuntime,
    standalone: Boolean,
    onBack: () -> Unit,
    onOpenInstructions: () -> Unit,
    onOpenLegacy: () -> Unit,
    onAbout: () -> Unit,
) {
    var page by rememberSaveable { mutableStateOf(SimplePage.Home) }
    var deviceRequest by rememberSaveable { mutableStateOf(0) }
    val device = rememberCallDeviceControls(runtime) { }
    val history by runtime.history.collectAsState()

    BackHandler(enabled = page != SimplePage.Home) { page = SimplePage.Home }

    when (page) {
        SimplePage.Home -> CallHomeScreen(
            runtime = runtime,
            onOpenSetup = { page = SimplePage.Setup },
            onOpenAdvanced = { page = SimplePage.Advanced },
            onOpenHistory = { page = SimplePage.History },
            onOpenLegacy = onOpenLegacy,
            onOpenInstructions = onOpenInstructions,
            onBack = onBack,
            standalone = standalone,
        )

        SimplePage.Setup -> CallSetupScreen(
            runtime = runtime,
            onOpenPermissions = { page = SimplePage.Advanced; deviceRequest++ },
            onOpenHelper = onOpenLegacy,
            onOpenAudio = { page = SimplePage.Advanced; deviceRequest++ },
            onOpenBackend = { page = SimplePage.Advanced },
            onBack = { page = SimplePage.Home },
        )

        SimplePage.Advanced -> CallAdvancedPage(
            runtime = runtime,
            deviceRequest = deviceRequest,
            onOpenLegacy = onOpenLegacy,
            onOpenInstructions = onOpenInstructions,
            onBack = { page = SimplePage.Home },
        )

        SimplePage.History -> CallHistoryPage(
            runtime = runtime,
            onOpenLegacy = onOpenLegacy,
            onBack = { page = SimplePage.Home },
        )
    }
}

/**
 * 高级设置页：只做跳板，不复制第二份配置实现。
 *
 * 原来的「设备与权限 / 后台与锁屏 / 语音服务 / 默认 SIM」四块仍由旧工作区承载，
 * 那里有全部校验和状态联动。复制一份到这里必然分叉，所以这里明确引导用户进入完整
 * 设置；等旧工作区被正式替换时再整体搬迁。
 */
@Composable
private fun CallAdvancedPage(
    runtime: CallRuntime,
    deviceRequest: Int,
    onOpenLegacy: () -> Unit,
    onOpenInstructions: () -> Unit,
    onBack: () -> Unit,
) {
    val config by runtime.settings.state.collectAsState()
    val scope = rememberCoroutineScope()
    var backendDialog by remember { mutableStateOf(false) }

    PageScaffold(stringResource(R.string.calls_advanced_title), onBack, Modifier.testTag("call-advanced-page")) {
        GroupCard {
            // 服务选择在这里直接可用：这是用户唯一需要理解的「电话用什么后端」的入口。
            ListRow(
                MikaIcons.Key, stringResource(R.string.calls_provider),
                subtitle = stringResource(config.effectiveBackendKind.label()),
                first = true, onClick = { backendDialog = true },
            ) { RowChevron() }
            CallFoldDivider()
            ListRow(
                MikaIcons.Gear, stringResource(R.string.calls_device_and_permissions),
                subtitle = stringResource(R.string.calls_device_system_settings_failed).takeIf { deviceRequest > 0 },
                onClick = onOpenLegacy,
            ) { RowChevron() }
            CallFoldDivider()
            ListRow(
                MikaIcons.Doc, stringResource(R.string.calls_instructions_entry),
                onClick = onOpenInstructions,
            ) { RowChevron() }
        }
        FooterNote(stringResource(R.string.calls_simple_advanced_note))
    }

    if (backendDialog) {
        CallBackendDialog(
            config = config,
            onDismiss = { backendDialog = false },
            onSave = { next ->
                runCatching {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        synchronized(runtime.settings) { runtime.settings.save(next) }
                    }
                }.isSuccess
            },
        )
    }
}

/** 通话记录页：复用现有列表，保留标记已处理、删除、复用任务。 */
@Composable
private fun CallHistoryPage(
    runtime: CallRuntime,
    onOpenLegacy: () -> Unit,
    onBack: () -> Unit,
) {
    val history by runtime.history.collectAsState()
    val state by runtime.state.collectAsState()
    val scope = rememberCoroutineScope()
    var pendingReuse by remember { mutableStateOf<Pair<String, com.wangzan101.mika.calls.CallTaskBrief>?>(null) }

    PageScaffold(stringResource(R.string.calls_home_history), onBack, Modifier.testTag("call-history-page")) {
        CallHistorySection(
            history,
            state.historyWriteFailed,
            onMark = runtime::setHistoryHandled,
            onDelete = runtime::deleteHistory,
            onReuseTask = { number, brief -> pendingReuse = number to brief },
        )
    }
    pendingReuse?.let { (number, brief) ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { pendingReuse = null },
            title = { androidx.compose.material3.Text(stringResource(R.string.calls_task_replace_title)) },
            text = { androidx.compose.material3.Text(stringResource(R.string.calls_task_replace_note)) },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    pendingReuse = null
                    scope.launch { runtime.dial(number, task = brief) }
                }) { androidx.compose.material3.Text(stringResource(R.string.calls_task_replace_action)) }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { pendingReuse = null }) {
                    androidx.compose.material3.Text(stringResource(R.string.calls_cancel))
                }
            },
        )
    }
}
