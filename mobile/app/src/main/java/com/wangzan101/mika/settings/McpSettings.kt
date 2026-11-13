package com.wangzan101.mika.settings

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import java.util.Base64

/**
 * 电脑连接(MCP)的设置:开关和端口存成一个小 JSON 文件(读不懂按关着);
 * 访问令牌和服务商的 Key 一样经 [KeyCipher] 加密后另存一个文件,第一次要用时生成。
 * 默认关着。
 */
class McpSettings(private val dir: File, private val cipher: KeyCipher, private val random: SecureRandom = SecureRandom()) {
    private val file = File(dir, "mcp.json")
    private val tokenFile = File(dir, "mcp-token.bin")
    private val _enabled: MutableStateFlow<Boolean>
    @Volatile private var cachedToken: String? = null

    /** 监听的端口;文件里没写就用 [DEFAULT_PORT]。 */
    val port: Int

    init {
        val o = runCatching { Json.parseToJsonElement(file.readText()) as? JsonObject }.getOrNull()
        _enabled = MutableStateFlow((o?.get("enabled") as? JsonPrimitive)?.booleanOrNull ?: false)
        port = (o?.get("port") as? JsonPrimitive)?.intOrNull?.takeIf { it in 1024..65535 } ?: DEFAULT_PORT
    }

    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    @Synchronized fun setEnabled(on: Boolean) {
        _enabled.value = on
        save()
    }

    /** 当前的访问令牌;还没有(或读不出来)就生成一个存下。 */
    @Synchronized fun token(): String {
        cachedToken?.let { return it.debugLogged() }
        val stored = runCatching { if (tokenFile.isFile) String(cipher.decrypt(tokenFile.readBytes()), Charsets.UTF_8) else null }.getOrNull()
        val token = stored?.takeIf { it.length >= MIN_TOKEN }?.also { cachedToken = it } ?: regenerate()
        return token.debugLogged()
    }

    /**
     * DEBUG 专用:令牌正常只存在加密文件里、也只显示在界面上,但自动化验证需要它。
     * 只在 debuggable 包里打;release 构建里 BuildConfig.DEBUG 是 false,不会进日志。
     *
     * 包在 runCatching 里是因为 android.util.Log 在纯 JVM 单测里是 Stub,
     * 一调用就抛。日志是辅助,绝不能因为它把 token() 弄挂——那样连真机上
     * 正常取令牌都会被拖累。
     */
    private fun String.debugLogged(): String = also {
        runCatching {
            if (com.wangzan101.mika.BuildConfig.DEBUG) android.util.Log.d("MikaDebugToken", it)
        }
    }

    /** 换一个新令牌:旧的当场失效,连着的电脑要换上新的才能再用。 */
    @Synchronized fun regenerate(): String {
        val bytes = ByteArray(32).also(random::nextBytes)
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        dir.mkdirs()
        val tmp = File(dir, tokenFile.name + ".tmp")
        tmp.writeBytes(cipher.encrypt(token.toByteArray(Charsets.UTF_8)))
        Files.move(tmp.toPath(), tokenFile.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        cachedToken = token
        return token
    }

    @Synchronized private fun save() {
        dir.mkdirs()
        val tmp = File(dir, file.name + ".tmp")
        tmp.writeText(buildJsonObject { put("enabled", _enabled.value); put("port", port) }.toString())
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    companion object {
        const val DEFAULT_PORT = 8765
        private const val MIN_TOKEN = 32
    }
}
