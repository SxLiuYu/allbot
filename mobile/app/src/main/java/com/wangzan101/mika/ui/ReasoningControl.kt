package com.wangzan101.mika.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.wangzan101.mika.R
import com.wangzan101.mika.core.model.ModelRole
import com.wangzan101.mika.settings.ReasoningOptions
import com.wangzan101.mika.settings.RoleChoice
import com.wangzan101.mika.ui.components.FooterNote
import com.wangzan101.mika.ui.components.SelectChip

/** 每个用途自己的档位;跟随主模型时说明继承,显式选同一个模型仍能独立设置。 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ReasoningControl(ui: ModelSetupUi, role: ModelRole, onSelect: (String?) -> Unit) {
    val cfg = ui.configFor(role) ?: return
    val listed = ui.providerOf(cfg)?.models?.firstOrNull { it.id == cfg.model }
    val options = ReasoningOptions.of(cfg, listed) ?: return
    val selected = ui.roles.reasoningEffort(role)
    if (options.levels.isEmpty() && selected == null) return
    if (ui.roles[role] == RoleChoice.SameAsMain) {
        FooterNote(stringResource(R.string.model_reasoning_inherit))
        return
    }
    var open by remember(role, cfg.providerId, cfg.model) { mutableStateOf(false) }
    TextButton(
        onClick = { open = true },
        modifier = Modifier.padding(start = 8.dp).testTag("reasoning-${role.name.lowercase()}"),
    ) {
        Text(stringResource(R.string.model_reasoning_value, reasoningLabel(selected)))
    }
    if (open) AlertDialog(
        onDismissRequest = { open = false },
        title = { Text(stringResource(R.string.model_reasoning_title, ModelsCopy.roleLabel(role))) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.model_reasoning_note))
                if (!options.fromProvider) Text(stringResource(R.string.model_reasoning_unknown))
                if (selected != null && selected !in options.levels) Text(stringResource(R.string.model_reasoning_unavailable))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    (listOf<String?>(null) + options.levels).forEach { effort ->
                        SelectChip(reasoningLabel(effort), selected == effort, {
                            onSelect(effort)
                            open = false
                        }, Modifier.testTag("reasoning-option-${effort ?: "default"}"))
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun reasoningLabel(effort: String?): String = when (effort) {
    null -> stringResource(R.string.model_reasoning_default)
    "none" -> stringResource(R.string.model_reasoning_none)
    "minimal" -> stringResource(R.string.model_reasoning_minimal)
    "low" -> stringResource(R.string.model_reasoning_low)
    "medium" -> stringResource(R.string.model_reasoning_medium)
    "high" -> stringResource(R.string.model_reasoning_high)
    "xhigh" -> stringResource(R.string.model_reasoning_xhigh)
    "max" -> stringResource(R.string.model_reasoning_max)
    else -> effort
}
