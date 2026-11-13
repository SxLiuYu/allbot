# 局域网语音链路（Mac realtime）

语音端默认走云端（StepFun / 百度 / Agnes）。本文记录把它切到一台局域网机器上
常驻的四个服务之后的样子：契约、实测数据、怎么开、已知问题。

## 为什么这么做

云端链路每句话都要出一次公网：ASR 一次、LLM 一次、TTS 一次。三个服务的
网络往返加起来就是端到端延迟的主要部分。局域网上这些往返降到毫秒级，
而且音频和文本都不出内网。

## 四个服务（一台机器，默认 172.16.84.88）

| 端口 | 服务 | 协议 | 模型 |
|---|---|---|---|
| 8091 | LLM | OpenAI 兼容 `/v1/chat/completions` | qwen35-4b |
| 8095 | 流式 ASR | WebSocket `/asr/stream` | Paraformer-large online |
| 8099 | TTS | `/v1/audio/speech`、`/v1/audio/speech/stream` | moss-tts-nano |
| 8770 | 判停（可选） | `POST /v1/systemone` | jev-style-2b-decision |

判停服务本仓未接：charlie 的端点检测走 Silero VAD 或 RMS 静音计数，
不需要语义判停。waihu 那边的通话链路会用它。

## 实测（2026-11-14，Mac 局域网）

| 环节 | 延迟 | 备注 |
|---|---|---|
| LLM 首 token | 211–246ms | 非流式整句 611–748ms |
| ASR 2s 音频 | 约 1.1s | 服务端按 600ms 一块串行处理，1s 音频约 0.99s |
| ASR 3.2s 音频 | 约 2.1s | 时延随音频线性增长，不是固定开销 |
| TTS 非流式整句 | 约 1.0s | 一次性返回 WAV |
| TTS 流式首块 | 142–225ms | 裸 PCM16 48kHz 立体声 |

ASR 那栏值得注意：它不是「一次调用固定 1s」，而是跟着音频长度走。
3.2 秒的音频要 2.1 秒才出结果，因为服务端每 600ms 一块串行解码。
这意味着长句子上它比 SenseVoice（26ms）差得远，只适合短指令。

## 怎么开

`.env` 里填地址，再把 `local` 写进对应的优先级链：

```ini
LOCAL_LLM_BASE=http://172.16.84.88:8091
LOCAL_LLM_MODEL=qwen35-4b
LOCAL_ASR_URL=ws://172.16.84.88:8095/asr/stream
LOCAL_TTS_URL=http://172.16.84.88:8099/v1/audio/speech

LLM_PRIORITY=local,stepfun,agnes
ASR_PRIORITY=local,sensevoice,baidu
TTS_PRIORITY=local,stepfun
```

不填地址时这些 provider 在链路里自动跳过，行为与接入前完全一致。

## 三个接口契约差异（都在 provider 里抹平了）

**ASR 只认 16k 单声道裸 PCM。** 上游给的是 WAV 或 mp3，`_asr_local` 先用
ffmpeg 转一遍。协议是 `start` → 二进制帧 → `commit`，结果取 `final`
而不是 `partial`：短音频下 partial 是截断的（实测 1s 音频的 partial 停在
「这个套餐它」，final 才是「这个套餐它包含」）。

**TTS 的 `voice` 参数不能传。** 传 `"default"`、`"中文女"`、`"tingting"`
一律 500，只有省略才 200。所以角色音色在局域网 TTS 上不生效，统一用它
自己的默认音色。

**TTS 返回的是 WAV，不是 mp3。** `response_format` 参数当前被服务端忽略，
`mp3`/`wav`/`pcm` 三种取值都回 `audio/wav`。下游 `mp3_to_opus_packets`
用 ffmpeg auto-probe 解码，不看扩展名，所以不用二次转码——多转一次要多付
一次 ffmpeg 启动的几十毫秒。

## 流式播报

配了 `LOCAL_TTS_STREAM_URL` 才走流式。链路是：

```
8099 /v1/audio/speech/stream
  → 裸 PCM16（响应头声明 x-sample-rate / x-channels，实测 48000/2）
  → audioop.tomono 下混单声道
  → audioop.ratecv 降到 24kHz（跨块保留状态，否则块边界有咔哒声）
  → 按 60ms 一帧切，opuslib 编码
  → ws.send_bytes 逐包下发
```

首块从「整句合成完」提前到「第一个 PCM 块到达」，实测 142–225ms。

两个实现细节容易踩：

- **块边界会切断立体声采样帧**（4 字节对齐）。不对齐处理会每个块丢半个
  采样，累积起来整句音调偏移。代码里用 `raw_pending` 兜跨块残留。
- **生成器的 `next()` 会阻塞在网络读上**，必须丢线程池，否则整个事件循环
  卡住 100ms 量级，其他设备的下行全会抖。见 `_aiter_packets`。

## 已知问题：8099 流式端点输出长度抖动

2026-11-14 实测，同一句「好的。」连续请求，返回长度在 **0.48s 到 15.76s**
之间无规律波动。非流式端点同样抖（107KB 到 5.4MB）。`/health` 报
`max_new_frames: 750`（=30s 上限）、`rss_mb: 1428`，看着像服务热起来之后
会跑满帧数上限。

这是服务侧问题，不是客户端。修好之前建议 `LOCAL_TTS_STREAM_URL` 留空走
非流式——虽然非流式也抖，但至少不会把 15 秒的静音塞给设备。

## 测试覆盖

- `tests/test_asr_tts_priority.py::TestLocalProviders`：TTS 请求体不带
  `voice`、ASR 的 URL scheme 归一化、未配置时两个 provider 都被跳过
- `tests/test_tts_local_stream.py`：分帧、下混、上采样、跨块残留、
  尾帧补零、取消、`_aiter_packets` 的惰性拉取
- `tests/test_llm_config.py`：`local` 不在默认链里、判据是 base 不是 key、
  占位 api_key 非空

本机（Windows 无 libopus）跑：65 passed, 3 skipped。跳过的三条是
`_aiter_packets`，因为 `app/xiaozhi_ws.py` 顶层依赖 `opuslib`；CI 上装了
`libopus0` 会全部执行。
