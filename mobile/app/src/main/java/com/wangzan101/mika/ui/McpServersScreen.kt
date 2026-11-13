package com.wangzan101.mika.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.wangzan101.mika.BuildConfig
import com.wangzan101.mika.settings.McpServerConfig
import com.wangzan101.mika.settings.McpServerProbe
import com.wangzan101.mika.settings.McpServerStore
import com.wangzan101.mika.ui.components.ButtonKind
import com.wangzan101.mika.ui.components.ButtonSize
import com.wangzan101.mika.ui.components.FooterNote
import com.wangzan101.mika.ui.components.GroupCard
import com.wangzan101.mika.ui.components.GroupLabel
import com.wangzan101.mika.ui.components.InputRow
import com.wangzan101.mika.ui.components.ListRow
import com.wangzan101.mika.ui.components.MikaButton
import com.wangzan101.mika.ui.components.MikaSwitch
import com.wangzan101.mika.ui.components.PageScaffold
import com.wangzan101.mika.ui.components.RowActions
import com.wangzan101.mika.ui.theme.MikaIcons
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 外部 MCP 服务一览:添加、编辑、启停、删除、测试连接。
 *
 * 只填地址和请求头;认证靠请求头(比如 `Authorization: Bearer ...`),密钥单独加密存。
 * 连接成功就会在任务里出现这家服务的工具,前缀是 `mcp_<名字>_`。
 */
@Composable
internal fun McpServersScreen(store: McpServerStore, onBack: () -> Unit) {
    var servers by remember { mutableStateOf(store.list()) }
    var editing by remember { mutableStateOf<McpServerConfig?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<McpServerConfig?>(null) }
    var probe by remember { mutableStateOf<McpServerProbe?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun reload() { servers = store.list() }

    // 不再套 verticalScroll:PageScaffold 的内容区已经是滚动容器,
    // 再套一层会因无界高度约束抛 IllegalStateException(点进这个页面就崩)。
    PageScaffold("MCP 服务器", onBack) {
        if (servers.isEmpty()) {
            GroupCard {
                ListRow(MikaIcons.Link, "还没有外部服务", "添加一个 MCP 服务,它的工具就会出现在任务里", first = true)
            }
        } else {
            servers.forEach { cfg ->
                GroupCard {
                    ListRow(MikaIcons.Link, cfg.name.ifBlank { cfg.url }, cfg.url, first = true) {
                        MikaSwitch(cfg.enabled, { on ->
                            store.upsert(cfg.copy(enabled = on)); reload()
                        }, Modifier.testTag("mcp-enabled-${cfg.id}"), enabled = !busy)
                    }
                    RowActions {
                        MikaButton("编辑", { editing = cfg }, size = ButtonSize.Small, enabled = !busy)
                        MikaButton("测试", {
                            busy = true; probe = null
                            scope.launch {
                                val r = withContext(Dispatchers.IO) { store.probe(cfg, BuildConfig.VERSION_NAME) }
                                probe = r; busy = false
                            }
                        }, kind = ButtonKind.Tonal, size = ButtonSize.Small, enabled = !busy)
                        MikaButton("删除", { deleting = cfg }, kind = ButtonKind.Text, size = ButtonSize.Small, enabled = !busy)
                    }
                }
            }
        }
        RowActions {
            MikaButton("添加服务", { adding = true }, size = ButtonSize.Small, enabled = !busy)
        }
        probe?.let { p ->
            FooterNote(
                if (p.ok) "连接成功:${p.serverName ?: "未命名服务"},${p.toolCount} 个工具"
                else "连接失败:${p.message}"
            )
        }
        FooterNote("任务开始时会连接所有已启用的服务;连不上的那个只是不出现,不影响任务本身。")
        FooterNote("地址必须是 https;本机或局域网可以用 http。认证信息填在请求头里,单独加密保存。")
    }

    if (adding || editing != null) {
        val base = editing ?: McpServerConfig(name = "", url = "")
        ServerEditor(
            initial = base,
            headers = store.headers(base.id),
            onDismiss = { adding = false; editing = null },
            onSave = { cfg, hdrs ->
                scope.launch {
                    withContext(Dispatchers.IO) {
                        store.upsert(cfg)
                        store.setHeaders(cfg.id, hdrs)
                    }
                    adding = false; editing = null; reload()
                }
            },
        )
    }

    if (deleting != null) {
        val target = deleting!!
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("删除 ${target.name.ifBlank { target.url }}") },
            text = { Text("删除后这个服务的工具不会再出现在任务里,已保存的认证信息一并删掉。") },
            confirmButton = {
                TextButton({ store.remove(target.id); deleting = null; reload() }) { Text("删除") }
            },
            dismissButton = { TextButton({ deleting = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun ServerEditor(
    initial: McpServerConfig,
    headers: Map<String, String>,
    onDismiss: () -> Unit,
    onSave: (McpServerConfig, Map<String, String>) -> Unit,
) {
    var name by remember { mutableStateOf(initial.name) }
    var url by remember { mutableStateOf(initial.url) }
    var transport by remember { mutableStateOf(initial.transport) }
    var trust by remember { mutableStateOf(initial.trustAnnotations) }
    // 请求头一行一条 `名字: 值`;比给两个固定输入框(Object/值)好用,也能放多个头
    var headerText by remember {
        mutableStateOf(headers.entries.joinToString("\n") { (k, v) -> "$k: $v" })
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial.name.isBlank() && initial.url.isBlank()) "添加 MCP 服务" else "编辑 MCP 服务") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                InputRow("名字", name, { name = it }, "浏览器", modifier = Modifier.testTag("mcp-name"))
                InputRow("地址", url, { url = it }, "https://example.com/mcp",
                    keyboard = KeyboardType.Uri, modifier = Modifier.testTag("mcp-url"))
                GroupLabel("传输方式")
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    MikaButton(
                        if (transport == McpServerConfig.TRANSPORT_HTTP) "Streamable HTTP(推荐)" else "旧版 HTTP+SSE",
                        { transport = if (transport == McpServerConfig.TRANSPORT_HTTP) McpServerConfig.TRANSPORT_SSE else McpServerConfig.TRANSPORT_HTTP },
                        kind = ButtonKind.Tonal, size = ButtonSize.Small,
                    )
                }
                GroupLabel("请求头")
                InputRow("请求头", headerText, { headerText = it }, "Authorization: Bearer xxx",
                    secret = true, modifier = Modifier.testTag("mcp-headers"))
                FooterNote("一行一条,格式「名字: 值」。认证一般放这里。")
                GroupLabel("信任")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    MikaSwitch(trust, { trust = it }, Modifier.testTag("mcp-trust"))
                    Text("  采信服务自称的只读注解", Modifier.padding(start = 8.dp))
                }
                FooterNote("关着时所有工具都按可能改动界面处理,更安全。")
            }
        },
        confirmButton = {
            TextButton({
                val hdrs = parseHeaders(headerText)
                onSave(initial.copy(name = name.trim(), url = url.trim(), transport = transport,
                    trustAnnotations = trust), hdrs)
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onDismiss) { Text("取消") } },
    )
}

/** 把「一行一条 `名字: 值`」拆成表;空行跳过,没冒号的行丢弃。 */
private fun parseHeaders(text: String): Map<String, String> = text.lineSequence()
    .map { it.trim() }
    .filter { it.isNotEmpty() && it.contains(':') }
    .associate { line ->
        val i = line.indexOf(':')
        line.substring(0, i).trim() to line.substring(i + 1).trim()
    }
