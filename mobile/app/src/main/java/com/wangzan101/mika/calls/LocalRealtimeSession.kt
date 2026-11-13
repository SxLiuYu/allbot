package com.wangzan101.mika.calls

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本地 realtime 后端的会话：连 waihu 的 WebSocket，只搬音频。
 *
 * 和火山那边有三处不一样，都在这一层抹平，[CallPcmBridge] 不用改：
 *
 * 1. 帧长。言出的录音管道是 640 字节 / 20 ms，waihu 的 `_drain_input` 按
 *    3200 字节 / 100 ms 数静音帧，帧长不对判停会失准。这里攒够 5 帧再发。
 * 2. 采样率。waihu 下行 TTS 已经重采样到 16 kHz，言出的播放管道是 24 kHz。
 *    这里做 16→24 kHz 线性插值（3:2），不改播放管道，火山的格式契约照旧。
 * 3. 协议。火山用 JSON + base64 音频，本地用裸 PCM 二进制帧。本地没有
 *    转写/语义事件，[events] 只发 [VolcRealtimeEvent.Audio]；告别词、打断
 *    这些由 waihu 的 CallEngine 自己负责，言出侧按通话时长兜底收尾。
 *
 * 连接建立即视为就绪（HTTP 101），不等服务端的首帧。`sendGreeting` 把开场白
 * 作为文本指令发给 waihu，由它的 LLM/TTS 播出来。
 */
internal class LocalRealtimeSession(
    private val endpoint: String,
    private val greeting: String,
    private val systemPrompt: String,
    private val connectTimeoutMs: Long = 10_000,
) : CallRealtimeSession {

    private enum class Phase { CONNECTING, ACTIVE, ENDED }
    private var phase = Phase.CONNECTING
    private var socket: WebSocket? = null
    private val ready = CompletableDeferred<Unit>()
    private val closed = CompletableDeferred<Unit>()
    private val output = Channel<VolcRealtimeEvent>(32)
    private val collecting = AtomicBoolean(false)
    private var muted = false
    @Volatile private var discardPending = false
    private var terminal: VolcRealtimeEvent = VolcRealtimeEvent.Closed

    /** 上行攒包：5 × 640 字节 = 3200 字节 = 100 ms @ 16 kHz。 */
    private val pending = ByteArray(FRAME_BYTES)
    private var pendingCount = 0

    /** 16→24 kHz 插值要跨帧保留末采样和相位，帧边界才不会有台阶。 */
    private var resampleLast = 0
    private var resamplePhase = 0

    override val events: Flow<VolcRealtimeEvent> = flow {
        check(collecting.compareAndSet(false, true)) { "Realtime events have one consumer" }
        for (event in output) if (!discardPending) emit(event)
        emit(terminal)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(this@LocalRealtimeSession) {
                if (phase != Phase.CONNECTING) { webSocket.cancel(); return }
                socket = webSocket
                phase = Phase.ACTIVE
                // 开场白和系统提示交给 waihu 的会话配置，由它自己决定何时播。
                val config = "{\"type\":\"configure\",\"greeting\":${jsonString(greeting)},\"system_prompt\":${jsonString(systemPrompt)}}"
                if (!webSocket.send(config)) end(VolcRealtimeException.Kind.NETWORK)
                else ready.complete(Unit)
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            synchronized(this@LocalRealtimeSession) {
                if (phase != Phase.ACTIVE) return
                val pcm24 = resample16to24(bytes.toByteArray())
                if (pcm24.isNotEmpty()) publish(VolcRealtimeEvent.Audio(pcm24))
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            synchronized(this@LocalRealtimeSession) {
                if (phase != Phase.ACTIVE) return
                // 目前只认挂断；其它文本是诊断信息，不进事件流。
                if (text.contains("\"hangup\"")) end(null, cancelSocket = false)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(this@LocalRealtimeSession) {
                webSocket.close(1000, null)
                end(if (code == 1000) null else VolcRealtimeException.Kind.NETWORK)
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(this@LocalRealtimeSession) {
                end(if (phase == Phase.ACTIVE && code == 1000) null else VolcRealtimeException.Kind.NETWORK)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            response?.close()
            synchronized(this@LocalRealtimeSession) {
                val kind = when (response?.code) {
                    401, 403 -> VolcRealtimeException.Kind.AUTH
                    429 -> VolcRealtimeException.Kind.RATE_LIMITED
                    else -> VolcRealtimeException.Kind.NETWORK
                }
                end(kind)
            }
        }
    }

    internal suspend fun connect(): LocalRealtimeSession {
        val client = OkHttpClient.Builder()
            .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
            .pingInterval(15, TimeUnit.SECONDS)
            .build()
        val request = Request.Builder().url(endpoint).build()
        client.newWebSocket(request, listener)
        // awaitReady 由调用方用 withTimeout 包住；这里不自行超时，避免重复计时。
        ready.await()
        return this
    }

    @Synchronized override fun sendPcm16(bytes: ByteArray, byteCount: Int): Boolean {
        if (phase != Phase.ACTIVE || muted || byteCount <= 0 || byteCount % 2 != 0 || byteCount > bytes.size) return false
        var offset = 0
        while (offset < byteCount) {
            val room = FRAME_BYTES - pendingCount
            val take = minOf(room, byteCount - offset)
            bytes.copyInto(pending, pendingCount, offset, offset + take)
            pendingCount += take
            offset += take
            if (pendingCount == FRAME_BYTES) {
                val frame = pending.copyOf()
                pendingCount = 0
                if (!sendBinary(frame)) return false
            }
        }
        return true
    }

    @Synchronized override fun sendGreeting(text: String): Boolean {
        // 开场白已在 onOpen 的 configure 里交给 waihu；这里只记下，避免重复播。
        return phase == Phase.ACTIVE
    }

    @Synchronized override fun setMuted(value: Boolean): Boolean {
        if (phase != Phase.ACTIVE) return false
        muted = value
        return true
    }

    @Synchronized override fun close() {
        if (phase == Phase.ENDED) return
        discardPending = true
        flushPending()
        socket?.close(1000, null)
        end(null, cancelSocket = true)
    }

    override suspend fun awaitClosed() = closed.await()

    private fun sendBinary(frame: ByteArray): Boolean {
        val connection = socket ?: return false
        if (connection.queueSize() > MAX_QUEUE_BYTES) {
            end(VolcRealtimeException.Kind.BACKPRESSURE)
            return false
        }
        return connection.send(frame.toByteString()).also { if (!it) end(VolcRealtimeException.Kind.NETWORK) }
    }

    /** 结束时把不满一帧的余量也发过去，最后半句话不能丢。 */
    @Synchronized private fun flushPending() {
        if (pendingCount > 0 && phase == Phase.ACTIVE) {
            sendBinary(pending.copyOf(pendingCount))
            pendingCount = 0
        }
    }

    private fun publish(event: VolcRealtimeEvent) {
        if (phase == Phase.ACTIVE && output.trySend(event).isFailure) {
            end(VolcRealtimeException.Kind.BACKPRESSURE, dropMedia = true)
        }
    }

    @Synchronized private fun end(kind: VolcRealtimeException.Kind?, cancelSocket: Boolean = false, dropMedia: Boolean = false) {
        if (phase == Phase.ENDED) return
        phase = Phase.ENDED
        if (cancelSocket) socket?.cancel()
        socket = null
        if (dropMedia) discardPending = true
        terminal = kind?.let { VolcRealtimeEvent.Failed(VolcRealtimeException(it)) } ?: VolcRealtimeEvent.Closed
        output.close()
        ready.completeExceptionally(kind?.let { VolcRealtimeException(it) }
            ?: VolcRealtimeException(VolcRealtimeException.Kind.NETWORK))
        closed.complete(Unit)
    }

    /**
     * 16 kHz → 24 kHz 线性插值：每 2 个输入采样出 3 个输出采样（3:2）。
     *
     * 输出采样 j 落在输入位置 j*2/3 处，在相邻两个输入采样之间线性插值。
     * 跨帧把上一帧的末采样拼到本帧头部，边界处才不会突然跳到 0。
     * 尾部不足的相位留到下一帧，用 [resamplePhase] 记住偏移。
     */
    internal fun resample16to24(input: ByteArray): ByteArray {
        val samples = input.size / 2
        if (samples == 0) return ByteArray(0)
        // 拼接序列：p[0] = 上一帧末采样，p[1..n] = 本帧采样。
        val padded = IntArray(samples + 1)
        padded[0] = resampleLast
        for (i in 0 until samples) padded[i + 1] = readSample(input, i)
        // 相位单位是 1/3 输入采样，跨帧保留；每输出一个采样步进 2。
        var pos = resamplePhase // 单位：1/3 采样，值域 0..2
        val result = ArrayList<Int>(samples * 3 / 2 + 2)
        while (pos / 3 + 1 <= samples) {
            val i = pos / 3
            val frac = pos % 3
            val a = padded[i]
            val b = padded[i + 1]
            result.add(a + (b - a) * frac / 3)
            pos += 2
        }
        resamplePhase = pos - (samples * 3) // 下一帧起点相对本帧末尾的偏移
        resampleLast = padded[samples]
        val out = ByteArray(result.size * 2)
        result.forEachIndexed { index, v -> writeSample(out, index, v) }
        return out
    }

    private fun readSample(input: ByteArray, index: Int): Int {
        val lo = input[index * 2].toInt() and 0xFF
        val hi = input[index * 2 + 1].toInt() and 0xFF
        val v = lo or (hi shl 8)
        return if (v >= 0x8000) v - 0x10000 else v
    }

    private fun writeSample(out: ByteArray, index: Int, value: Int) {
        val v = value.coerceIn(-32768, 32767)
        out[index * 2] = (v and 0xFF).toByte()
        out[index * 2 + 1] = ((v shr 8) and 0xFF).toByte()
    }

    private fun jsonString(value: String): String = buildString {
        append('"')
        for (c in value) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c.code < 0x20) append("\\u%04x".format(c.code)) else append(c)
        }
        append('"')
    }

    private companion object {
        const val FRAME_BYTES = 3200
        const val MAX_QUEUE_BYTES = 64 * 1024
    }
}
