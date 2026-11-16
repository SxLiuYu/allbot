package com.wangzan101.mika.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.wangzan101.mika.R
import com.wangzan101.mika.calls.CallBackendKind
import com.wangzan101.mika.calls.CallConfig
import com.wangzan101.mika.ui.components.FooterNote
import com.wangzan101.mika.ui.components.RadioRow
import kotlinx.coroutines.launch

/**
 * 通话服务选择：云端 / 自建 / 火山。
 *
 * 以前这一页只有「火山凭据」和「本地后端地址」两个并列入口，用户看不出它们谁是当前生效的
 * 那个。这里改成先选类型再看该类型需要的字段：云端和自建共用地址，火山用凭据。
 *
 * 选中但没填字段时保存会退回未配置（见 `CallSettings.save`），所以「选了云端却没填地址」
 * 不会被当成可用服务。
 */
@Composable
internal fun CallBackendDialog(
    config: CallConfig,
    onDismiss: () -> Unit,
    onSave: suspend (CallConfig) -> Boolean,
) {
    var kind by remember { mutableStateOf(config.effectiveBackendKind.takeIf { it != CallBackendKind.UNCONFIGURED } ?: CallBackendKind.CLOUD) }
    var endpoint by remember { mutableStateOf(config.localEndpoint.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val needsEndpoint = kind == CallBackendKind.CLOUD || kind == CallBackendKind.CUSTOM
    val valid = when (kind) {
        CallBackendKind.CLOUD, CallBackendKind.CUSTOM -> endpoint.isNotBlank()
        CallBackendKind.VOLCENGINE -> config.credentialsConfigured
        CallBackendKind.UNCONFIGURED -> false
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        modifier = Modifier.testTag("call-backend-dialog"),
        title = { Text(stringResource(R.string.calls_provider)) },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                CallBackendKind.entries
                    .filter { it != CallBackendKind.UNCONFIGURED }
                    .forEachIndexed { index, option ->
                        RadioRow(
                            stringResource(option.label()),
                            selected = kind == option,
                            onClick = { kind = option; error = false },
                            first = index == 0,
                            enabled = !busy,
                        )
                    }
                if (needsEndpoint) {
                    androidx.compose.material3.OutlinedTextField(
                        endpoint, { endpoint = it; error = false },
                        modifier = Modifier.fillMaxWidth().testTag("call-backend-endpoint"),
                        label = { Text("wss://…") }, singleLine = true, enabled = !busy,
                    )
                    FooterNote(stringResource(R.string.calls_local_endpoint_note))
                }
                if (kind == CallBackendKind.VOLCENGINE && !config.credentialsConfigured) {
                    FooterNote(stringResource(R.string.calls_setup_credentials))
                }
                if (error) Text(stringResource(R.string.calls_action_failed), color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && valid,
                modifier = Modifier.testTag("call-backend-save"),
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            val next = config.copy(
                                backendKind = kind,
                                // 切到火山时清掉自建地址：两个来源同时存在会让「当前到底连哪」无法判断，
                                // 也会让下次从火山切回自建时冒出一个用户没印象的旧地址。
                                localEndpoint = if (needsEndpoint) endpoint.trim().ifEmpty { null } else null,
                            )
                            if (onSave(next)) onDismiss() else error = true
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(stringResource(R.string.calls_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.calls_cancel)) } },
    )
}

/** 服务类型 → 字符串资源；放在界面层，避免 calls 包依赖 R。 */
internal fun CallBackendKind.label(): Int = when (this) {
    CallBackendKind.CLOUD -> R.string.calls_backend_cloud
    CallBackendKind.CUSTOM -> R.string.calls_backend_custom
    CallBackendKind.VOLCENGINE -> R.string.calls_backend_volcengine
    CallBackendKind.UNCONFIGURED -> R.string.calls_backend_unconfigured
}
