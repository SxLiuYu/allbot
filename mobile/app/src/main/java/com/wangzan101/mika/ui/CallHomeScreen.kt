package com.wangzan101.mika.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import com.wangzan101.mika.R
import com.wangzan101.mika.calls.CallActionResult
import com.wangzan101.mika.calls.CallAutoAnswerStage
import com.wangzan101.mika.calls.CallBackendKind
import com.wangzan101.mika.calls.CallConfig
import com.wangzan101.mika.calls.CallPhase
import com.wangzan101.mika.calls.CallPolicy
import com.wangzan101.mika.calls.CallRuntime
import com.wangzan101.mika.calls.CallRuntimeState
import com.wangzan101.mika.calls.CallSetupStep
import com.wangzan101.mika.calls.CallSimpleDial
import com.wangzan101.mika.calls.CallTaskBrief
import androidx.compose.material3.AlertDialog
import com.wangzan101.mika.ui.components.BarIconButton
import com.wangzan101.mika.ui.components.IconTile
import com.wangzan101.mika.ui.components.PageBackground
import com.wangzan101.mika.ui.components.TopBar
import com.wangzan101.mika.ui.components.FooterNote
import com.wangzan101.mika.ui.components.GroupCard
import com.wangzan101.mika.ui.components.GroupLabel
import com.wangzan101.mika.ui.components.ListRow
import com.wangzan101.mika.ui.components.MikaSwitch
import com.wangzan101.mika.ui.components.RowChevron
import com.wangzan101.mika.ui.components.TileTone
import com.wangzan101.mika.ui.theme.MikaIcons
import com.wangzan101.mika.ui.theme.MikaSpace
import com.wangzan101.mika.ui.theme.MikaTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 电话首页：接电话、打电话、通话记录。
 *
 * 设计取舍：**日常只出现三个动作**。权限、助手连接、音频实测、服务连接这些一次性
 * 初始化收进 [onOpenSetup]；火山凭据、自建地址、音频通道、详细任务这些收进
 * [onOpenAdvanced]。原来的四标签工作区（接听/任务/记录/设置）仍然完整保留，由
 * [onOpenLegacy] 进入，所以这次只是换默认入口，没有任何能力被删。
 *
 * 安全语义不变：自动接听仍要求 [CallSetupStep.ready] 且号码在白名单内，这里的
 * 开关只写 `autoAnswer` 一个字段，放行判定仍在 [CallPolicy.callerAllowed]。
 */
@Composable
fun CallHomeScreen(
    runtime: CallRuntime,
    onOpenSetup: () -> Unit,
    onOpenAdvanced: () -> Unit,
    onOpenHistory: () -> Unit,
    onOpenLegacy: () -> Unit,
    onOpenInstructions: () -> Unit,
    onBack: () -> Unit,
    standalone: Boolean = false,
) {
    val config by runtime.settings.state.collectAsState()
    val state by runtime.state.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<CallActionResult?>(null) }
    var number by rememberSaveable { mutableStateOf("") }
    var request by rememberSaveable { mutableStateOf("") }
    var review by remember { mutableStateOf<CallTarget?>(null) }

    val setupMissing = CallSetupStep.missing(config, state)
    val ready = setupMissing.isEmpty()
    val join = stringResource(R.string.calls_missing_join)
    // 先在这里取文字：stringResource 不能出现在非 composable 的 lambda 里。
    val missingText = setupMissing.map { stringResource(it.label()) }.joinToString(join)
    val idle = state.phase == CallPhase.IDLE
    val canToggleAuto = ready && idle && !busy

    fun perform(action: suspend () -> CallActionResult) {
        if (busy) return
        busy = true
        feedback = null
        scope.launch {
            try {
                feedback = action()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                feedback = CallActionResult(false, "")
            } finally {
                busy = false
            }
        }
    }

    suspend fun save(change: (CallConfig) -> CallConfig): Boolean = try {
        withContext(Dispatchers.IO) {
            synchronized(runtime.settings) { runtime.settings.save(change(runtime.settings.state.value)) }
        }
        true
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        feedback = CallActionResult(false, "")
        false
    }

    PageBackground(Modifier.testTag("call-home")) {
        Column(Modifier.fillMaxSize().navigationBarsPadding().imePadding()) {
            if (standalone) {
                TopBar(stringResource(R.string.app_name), MikaIcons.Gear, onOpenAdvanced,
                    stringResource(R.string.calls_advanced_title), right = {
                        BarIconButton(MikaIcons.Bell, stringResource(R.string.calls_setup_title), onOpenSetup)
                    })
            } else {
                TopBar(stringResource(R.string.calls_title), MikaIcons.Back, onBack, stringResource(R.string.back))
            }
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(horizontal = MikaSpace.Page).padding(top = 8.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // 通话中：当前通话置顶，控制按钮不折叠，人工接管始终可达。
                if (!idle) {
                    CurrentCallSummary(
                        state = state,
                        feedback = feedback,
                        canAnswer = ready && !busy && state.canAnswer,
                        onAnswer = { state.callId?.let { id -> perform { runtime.answer(id) } } },
                        onHangup = { state.callId?.let { id -> perform { runtime.hangup(id) } } },
                        onTakeover = { perform { runtime.takeover() } },
                        onCancelAuto = { state.callId?.let { id -> perform { runtime.cancelAutoAnswer(id) } } },
                    )
                } else {
                    feedback?.let { CallFeedback(it) }
                }

                // 接电话
                GroupLabel(stringResource(R.string.calls_home_answer_title))
                GroupCard(Modifier.testTag("call-home-answer")) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconTile(MikaIcons.Bell, if (config.autoAnswer && ready) TileTone.Ok else TileTone.Neutral)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(stringResource(R.string.calls_auto_answer), style = MaterialTheme.typography.titleMedium)
                            Text(
                                when {
                                    !ready -> stringResource(R.string.calls_home_setup_needed, setupMissing.size)
                                    config.autoAnswer -> stringResource(R.string.calls_home_ready)
                                    else -> stringResource(R.string.calls_home_answer_sub)
                                },
                                style = MaterialTheme.typography.bodySmall, color = MikaTheme.colors.ink3,
                            )
                        }
                        MikaSwitch(
                            config.autoAnswer,
                            onCheckedChange = { checked ->
                                // 打开前必须先通过初始化：否则开关会亮着但实际接不了，用户以为坏了。
                                if (checked && !ready) onOpenSetup()
                                else scope.launch { save { it.copy(autoAnswer = checked) } }
                            },
                            modifier = Modifier.testTag("call-home-auto"),
                            enabled = canToggleAuto || (config.autoAnswer && idle && !busy),
                        )
                    }
                    if (!ready) {
                        CallFoldDivider()
                        ListRow(
                            MikaIcons.Gear, stringResource(R.string.calls_setup_title),
                            subtitle = missingText,
                            onClick = onOpenSetup,
                        ) { RowChevron() }
                    }
                    CallFoldDivider()
                    ListRow(
                        MikaIcons.Doc, stringResource(R.string.calls_instructions_entry),
                        onClick = onOpenInstructions,
                    ) { RowChevron() }
                }

                // 打电话
                GroupLabel(stringResource(R.string.calls_home_dial_title))
                GroupCard(Modifier.testTag("call-home-dial")) {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            number, { number = it }, modifier = Modifier.fillMaxWidth().testTag("call-home-number"),
                            label = { Text(stringResource(R.string.calls_number)) }, singleLine = true,
                            textStyle = TextStyle(textDirection = TextDirection.Ltr),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            isError = number.isNotBlank() && CallPolicy.outgoingNumber(number) == null,
                            enabled = idle && !busy,
                        )
                        OutlinedTextField(
                            request, { request = it }, modifier = Modifier.fillMaxWidth().testTag("call-home-request"),
                            label = { Text(stringResource(R.string.calls_home_dial_request)) },
                            placeholder = { Text(stringResource(R.string.calls_home_dial_request_hint)) },
                            minLines = 2, maxLines = 4,
                            isError = request.trim().length > CallSimpleDial.MAX_REQUEST_CHARS,
                            enabled = idle && !busy,
                        )
                        CallPrimaryButton(
                            stringResource(R.string.calls_home_dial_check),
                            enabled = idle && !busy && ready && CallSimpleDial.canDial(number, request),
                            onClick = {
                                val brief = CallSimpleDial.brief(request)
                                review = CallTarget(CallPolicy.outgoingNumber(number) ?: number, brief)
                            },
                            modifier = Modifier.testTag("call-home-dial-check"),
                        )
                        TextButton(
                            onClick = onOpenLegacy, enabled = idle && !busy,
                            modifier = Modifier.fillMaxWidth().testTag("call-home-advanced-task"),
                        ) { Text(stringResource(R.string.calls_simple_advanced)) }
                        if (!ready) {
                            FooterNote(stringResource(R.string.calls_home_setup_needed, setupMissing.size))
                        }
                    }
                }

                // 记录与设置
                GroupCard {
                    ListRow(
                        MikaIcons.Clock, stringResource(R.string.calls_home_history),
                        first = true, onClick = onOpenHistory,
                    ) { RowChevron() }
                    CallFoldDivider()
                    ListRow(
                        MikaIcons.Gear, stringResource(R.string.calls_advanced_title),
                        subtitle = stringResource(config.effectiveBackendKind.label()), onClick = onOpenAdvanced,
                    ) { RowChevron() }
                }

                FooterNote(stringResource(R.string.calls_privacy_note))
            }
        }
    }

    review?.let { target ->
        CallSimpleReviewDialog(
            target = target,
            ready = ready,
            onDismiss = { review = null },
            onDial = {
                review = null
                scope.launch {
                    feedback = runtime.dial(target.number, task = target.brief)
                }
            },
        )
    }
}

/** 待确认的拨号目标。简单模式只有号码和可选的一句话要求。 */
private data class CallTarget(val number: String, val brief: CallTaskBrief?)

@Composable
private fun CallSimpleReviewDialog(
    target: CallTarget,
    ready: Boolean,
    onDismiss: () -> Unit,
    onDial: () -> Unit,
) {
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        modifier = Modifier.testTag("call-home-review"),
        title = { Text(stringResource(R.string.calls_task_review)) },
        text = {
            Column(Modifier.heightIn(max = 400.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(stringResource(R.string.calls_number), style = MaterialTheme.typography.labelMedium,
                        color = MikaTheme.colors.ink3)
                    Text("\u2066${target.number}\u2069", style = MaterialTheme.typography.bodyMedium)
                }
                target.brief?.let { brief ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(stringResource(R.string.calls_home_dial_request),
                            style = MaterialTheme.typography.labelMedium, color = MikaTheme.colors.ink3)
                        Text(brief.goal, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Text(
                    stringResource(if (ready) R.string.calls_task_confirm_note else R.string.calls_task_review_blocked),
                    style = MaterialTheme.typography.bodySmall, color = MikaTheme.colors.ink3,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { busy = true; onDial() },
                enabled = ready && !busy,
                modifier = Modifier.testTag("call-home-dial-confirm"),
            ) { Text(stringResource(R.string.calls_task_dial_now)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.calls_cancel)) } },
    )
}

@Composable
private fun CurrentCallSummary(
    state: CallRuntimeState,
    feedback: CallActionResult?,
    canAnswer: Boolean,
    onAnswer: () -> Unit,
    onHangup: () -> Unit,
    onTakeover: () -> Unit,
    onCancelAuto: () -> Unit,
) {
    val cancelAuto = state.autoAnswerStage == CallAutoAnswerStage.COUNTDOWN ||
        state.autoAnswerStage == CallAutoAnswerStage.PREPARING
    val ringing = state.phase == CallPhase.RINGING && state.autoAnswerStage != CallAutoAnswerStage.ANSWERING
    GroupCard(Modifier.testTag("call-home-current")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                IconTile(MikaIcons.Phone, if (state.aiActive || cancelAuto) TileTone.Accent else TileTone.Neutral)
                Column(Modifier.weight(1f)) {
                    Text(
                        state.detail ?: stringResource(R.string.calls_current_call),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    state.number?.let {
                        Text("\u2066$it\u2069", style = MaterialTheme.typography.bodySmall, color = MikaTheme.colors.ink3)
                    }
                }
            }
            state.liveTranscript.lastOrNull()?.let { line ->
                Text(line.text, style = MaterialTheme.typography.bodySmall, color = MikaTheme.colors.ink3, maxLines = 2)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (ringing) {
                    TextButton(onClick = onAnswer, enabled = canAnswer,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("call-home-answer-call")) {
                        Text(stringResource(R.string.calls_answer))
                    }
                }
                if (cancelAuto) {
                    TextButton(onClick = onCancelAuto,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("call-home-cancel-auto")) {
                        Text(stringResource(R.string.calls_auto_cancel))
                    }
                }
                if (state.canTakeOver) {
                    TextButton(onClick = onTakeover,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("call-home-takeover")) {
                        Text(stringResource(R.string.calls_takeover))
                    }
                }
                if (state.canHangUp) {
                    TextButton(onClick = onHangup,
                        modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("call-home-hangup")) {
                        Text(stringResource(R.string.calls_hangup), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
            feedback?.let { CallFeedback(it) }
        }
    }
}

/** 步骤 → 字符串资源。放在这里而不是枚举里，避免 calls 包依赖 R。 */
private fun CallSetupStep.label(): Int = when (this) {
    CallSetupStep.DEVICE_PERMISSIONS -> R.string.calls_setup_step_permissions
    CallSetupStep.BUILTIN_HELPER -> R.string.calls_setup_step_helper
    CallSetupStep.NOTIFICATIONS -> R.string.calls_setup_step_notifications
    CallSetupStep.AUDIO_VERIFIED -> R.string.calls_setup_step_audio
    CallSetupStep.BACKEND -> R.string.calls_setup_step_backend
}

/** 卡片内的分隔线；与 GroupCard 的 hairlines 对齐。 */
@Composable
internal fun CallFoldDivider() {
    androidx.compose.material3.HorizontalDivider(color = MikaTheme.colors.hair)
}
