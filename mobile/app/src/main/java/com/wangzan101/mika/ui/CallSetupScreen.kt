package com.wangzan101.mika.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.wangzan101.mika.R
import com.wangzan101.mika.calls.CallRuntime
import com.wangzan101.mika.calls.CallSetupStep
import com.wangzan101.mika.ui.components.FooterNote
import com.wangzan101.mika.ui.components.GroupCard
import com.wangzan101.mika.ui.components.ListRow
import com.wangzan101.mika.ui.components.PageScaffold
import com.wangzan101.mika.ui.components.RowChevron
import com.wangzan101.mika.ui.components.TileTone
import com.wangzan101.mika.ui.theme.MikaIcons
import com.wangzan101.mika.ui.theme.MikaTheme

/**
 * 电话初始化向导：把「权限 / 助手 / 通知 / 音频 / 服务」列成五步。
 *
 * 之前这些条件分散在「启用、准备、自动接听、后台常驻、已实测音频」五个开关上，用户只能
 * 一个个试。这里只做展示和跳转，每一步的实际判定仍在各子系统里（权限来自 telecom、
 * 助手来自 shell 连接、音频来自 probeAudio、服务来自 [CallBackendKind]），不新增放行条件。
 *
 * 与 App 主模型无关：电话不读 `ProviderStore.roles.main`，所以这里不要求配置主模型。
 */
@Composable
fun CallSetupScreen(
    runtime: CallRuntime,
    onOpenPermissions: () -> Unit,
    onOpenHelper: () -> Unit,
    onOpenAudio: () -> Unit,
    onOpenBackend: () -> Unit,
    onBack: () -> Unit,
) {
    val config by runtime.settings.state.collectAsState()
    val state by runtime.state.collectAsState()
    val done = CallSetupStep.completed(config, state)
    val missing = CallSetupStep.missing(config, state)

    PageScaffold(stringResource(R.string.calls_setup_title), onBack, Modifier.testTag("call-setup")) {
        FooterNote(
            if (missing.isEmpty()) stringResource(R.string.calls_home_ready)
            else stringResource(R.string.calls_home_setup_needed, missing.size)
        )
        GroupCard {
            CallSetupRow(
                R.string.calls_setup_step_permissions, CallSetupStep.DEVICE_PERMISSIONS in done,
                onOpenPermissions, first = true,
            )
            CallSetupRow(
                R.string.calls_setup_step_helper, CallSetupStep.BUILTIN_HELPER in done,
                onOpenHelper,
            )
            CallSetupRow(
                R.string.calls_setup_step_notifications, CallSetupStep.NOTIFICATIONS in done,
                onOpenPermissions,
            )
            CallSetupRow(
                R.string.calls_setup_step_audio, CallSetupStep.AUDIO_VERIFIED in done,
                onOpenAudio,
            )
            CallSetupRow(
                R.string.calls_setup_step_backend, CallSetupStep.BACKEND in done,
                onOpenBackend,
            )
        }
        FooterNote(stringResource(R.string.calls_privacy_note))
    }
}

@Composable
private fun CallSetupRow(labelRes: Int, done: Boolean, onOpen: () -> Unit, first: Boolean = false) {
    ListRow(
        icon = if (done) MikaIcons.Check else MikaIcons.Gear,
        title = stringResource(labelRes),
        subtitle = stringResource(if (done) R.string.calls_setup_done else R.string.calls_setup_go),
        first = first,
        tone = if (done) TileTone.Ok else TileTone.Neutral,
        titleColor = if (done) MikaTheme.colors.ink3 else androidx.compose.ui.graphics.Color.Unspecified,
        onClick = onOpen,
    ) { RowChevron() }
}
