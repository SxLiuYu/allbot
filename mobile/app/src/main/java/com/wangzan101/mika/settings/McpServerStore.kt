package com.wangzan101.mika.settings

import com.wangzan101.mika.core.cap.mcp.HttpMcpEndpoint
import com.wangzan101.mika.core.cap.mcp.LegacySseMcpEndpoint
import com.wangzan101.mika.core.cap.mcp.McpClientException
import com.wangzan101.mika.core.cap.mcp.McpConnection
import com.wangzan101.mika.core.cap.mcp.McpEndpoint
import com.wangzan101.mika.core.cap.mcp.McpTrust
import com.wangzan101.mika.core.model.ChatModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.TimeUnit

/** 一条外部 MCP 服务的配置。地址和请求头都在这里,密钥不落明文(见 [McpServerStore.token])。 */
@Serializable
data class McpServerConfig(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val url: String,
    /** [TRANSPORT_HTTP] 是 2025-03-26 的 Streamable HTTP;[TRANSPORT_SSE] 是 2024-11-05 的旧版 HTTP+SSE。 */
    val transport: String = TRANSPORT_HTTP,
    val enabled: Boolean = true,
    /** 额外请求头(认证一般放这里);值可以含密钥,所以不进日志。 */
    val headers: Map<String, String> = emptyMap(),
    /** 不采信服务自称的只读注解,一律按可写处理。 */
    val trustAnnotations: Boolean = false,
    val timeoutSec: Int = 60,
) {
    companion object {
        const val TRANSPORT_HTTP = "http"
        const val TRANSPORT_SSE = "sse"
    }
}

/** 连接尝试的结果,给设置页显示。 */
data class McpServerProbe(val ok: Boolean, val serverName: String? = null, val toolCount: Int = 0, val message: String = "")

/**
 * 外部 MCP 服务的配置存储。
 *
 * 只做三件事:读写配置、按配置连上去、把连上的端点交给任务。认证只支持手工填请求头,
 * 需要 OAuth 或本地 stdio 的服务暂不支持——那两样各要一套流程和额外依赖。
 *
 * 连不上不影响任务:一个服务失败只让它的工具缺席,不会让整个任务起不来。
 */
class McpServerStore(private val file: File, private val cipher: KeyCipher) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true; encodeDefaults = true }
    // 每条服务的请求头单独加密成文件,配置本体只留文件名
    private val secretDir = File(file.parentFile, "mcp-servers")
    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).build()
    }

    @Synchronized fun list(): List<McpServerConfig> = runCatching {
        if (!file.isFile) return emptyList()
        json.decodeFromString<List<McpServerConfig>>(file.readText())
    }.getOrDefault(emptyList())

    @Synchronized fun save(configs: List<McpServerConfig>) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        // 显式传 serializer:List<T> 的泛型在运行期被擦除,单参数 encodeToString 会去反射找
        // McpServerConfig 的 serializer 并抛 SerializationException(第一次保存就崩)。
        tmp.writeText(json.encodeToString(ListSerializer(McpServerConfig.serializer()), configs))
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }

    @Synchronized fun upsert(config: McpServerConfig) {
        val all = list().toMutableList()
        val i = all.indexOfFirst { it.id == config.id }
        if (i >= 0) all[i] = config else all += config
        save(all)
    }

    @Synchronized fun remove(id: String) {
        save(list().filterNot { it.id == id })
        runCatching { secretFile(id).delete() }
    }

    /** 这条服务的请求头(含密钥);没存过返回空。 */
    @Synchronized fun headers(id: String): Map<String, String> = runCatching {
        val f = secretFile(id)
        if (!f.isFile) return emptyMap()
        json.decodeFromString<Map<String, String>>(cipher.decrypt(f.readBytes()).toString(Charsets.UTF_8))
    }.getOrDefault(emptyMap())

    @Synchronized fun setHeaders(id: String, headers: Map<String, String>) {
        secretDir.mkdirs()
        val f = secretFile(id)
        if (headers.isEmpty()) { f.delete(); return }
        val bytes = json.encodeToString(headers).toByteArray(Charsets.UTF_8)
        val tmp = File(secretDir, f.name + ".tmp")
        try {
            tmp.writeBytes(cipher.encrypt(bytes))
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING)
        } finally {
            bytes.fill(0); tmp.delete()
        }
    }

    private fun secretFile(id: String) = File(secretDir, "$id.json")

    /** 地址必须是 http(s);本机明文 HTTP 只在回环或私网地址上允许,免得令牌走公网明文。 */
    private fun validUrl(raw: String): Boolean {
        val u = raw.toHttpUrlOrNull() ?: return false
        if (u.scheme == "https") return true
        val host = u.host
        return u.scheme == "http" && (host == "127.0.0.1" || host == "::1" || host == "localhost" ||
            host.startsWith("10.") || host.startsWith("192.168.") ||
            Regex("^172\\.(1[6-9]|2[0-9]|3[01])\\.").containsMatchIn(host))
    }

    /**
     * 连上去并返回端点;失败给 [Result.failure]。
     *
     * 目录在连接时读一次就冻结(和 [McpEndpoint] 的约定一致),之后只发 tools/call。
     */
    suspend fun connect(config: McpServerConfig, clientVersion: String): Result<McpEndpoint> = withContext(Dispatchers.IO) {
        if (!validUrl(config.url)) {
            return@withContext Result.failure(McpClientException("MCP 服务地址必须是 https,本机或私网可以用 http"))
        }
        val headers = headers(config.id)
        val timeout = config.timeoutSec.coerceIn(5, 600)
        when (config.transport) {
            McpServerConfig.TRANSPORT_SSE -> LegacySseMcpEndpoint.connect(
                serverId = config.id, url = config.url, http = http, headers = headers,
                timeoutSec = timeout, clientName = "Mika", clientVersion = clientVersion,
            )
            else -> HttpMcpEndpoint.connect(
                serverId = config.id, url = config.url, http = http, headers = headers,
                timeoutSec = timeout, clientName = "Mika", clientVersion = clientVersion,
            )
        }
    }

    /** 设置页的「保存并测试」:连一次,报服务名和工具数。 */
    suspend fun probe(config: McpServerConfig, clientVersion: String): McpServerProbe =
        connect(config, clientVersion).fold(
            onSuccess = { e ->
                val n = e.tools().size
                runCatching { (e as? java.io.Closeable)?.close() }
                McpServerProbe(true, e.serverNameOrNull(), n)
            },
            onFailure = { McpServerProbe(false, message = it.message ?: it.javaClass.simpleName) },
        )

    /**
     * 任务开局要用的连接列表。没启用的跳过;连不上的跳过(不让一个坏配置挡住整个任务),
     * 并且并行连,免得几个慢服务串起来拖慢开局。
     */
    suspend fun connections(clientVersion: String, maxCostUnits: Long? = null): List<McpConnection> =
        withContext(Dispatchers.IO) {
            list().filter { it.enabled }.map { config ->
                config to connect(config, clientVersion)
            }.mapNotNull { (config, result) ->
                result.getOrNull()?.let { endpoint ->
                    McpConnection(
                        endpoint = endpoint,
                        maxCostUnits = maxCostUnits,
                        trust = if (config.trustAnnotations) McpTrust.TrustAnnotations else McpTrust.Restricted,
                    )
                }
            }
        }
}

/** 服务名;端点不暴露它时返回 null(只有 HTTP 传输读得到 initialize 里的 serverInfo)。 */
private fun McpEndpoint.serverNameOrNull(): String? = when (this) {
    is HttpMcpEndpoint -> serverName
    is LegacySseMcpEndpoint -> serverName
    else -> null
}
