"""局域网流式 TTS（_tts_local_stream）与下行包迭代（_aiter_packets）。

这一层没有 libopus 也要能测：编码器从参数注入，被测的是
「立体声→单声道 + 48k→24k + 按帧切 + 尾帧补零」这段纯数据处理。
真实编码器在 CI（装了 libopus0）和 Mac 上才跑。
"""
import asyncio
import os
import struct
from unittest.mock import MagicMock, patch

from agent.asr_tts import _tts_local_stream

import pytest

# app.xiaozhi_ws 在模块顶层 import opuslib，没装 libopus 的机器（含 Windows 开发机）
# 根本导入不了。流式分帧那批用例不碰 opuslib（编码器注入），照常跑；
# 只有 _aiter_packets 那几条依赖该模块，缺库时跳过。
try:
    import opuslib  # noqa: F401
    _HAS_OPUS = True
except Exception:  # noqa: BLE001
    _HAS_OPUS = False

requires_opus = pytest.mark.skipif(
    not _HAS_OPUS, reason="需要 libopus（app.xiaozhi_ws 顶层依赖 opuslib）")


class RecordingEncoder:
    """替身编码器：只记录每帧样本数与字节数，不真的编码。"""

    def __init__(self):
        self.frames = []

    def encode(self, pcm, frame_samples):
        # 1 个样本 = 2 字节（PCM16），整帧字节数应为样本数 × 2
        assert len(pcm) == frame_samples * 2, (
            f"opus 帧必须是整帧 PCM16: got {len(pcm)} bytes, want {frame_samples * 2}")
        self.frames.append(frame_samples)
        return b"\x00" * 3


def _stereo_pcm(n_frames: int, rate: int = 48000) -> bytes:
    """造 n_frames 个 48k 立体声采样（左右同幅，便于验证下混）。"""
    return struct.pack("<h", 1000) * 2 * n_frames


def _fake_response(chunks, *, headers=None, status=200):
    """构造一个满足 `with session.post(...) as r` 的对象。"""
    r = MagicMock()
    r.status_code = status
    r.headers = headers if headers is not None else {
        "x-sample-rate": "48000", "x-channels": "2"}
    r.iter_content.return_value = iter(chunks)
    r.text = ""
    r.__enter__ = lambda self: self
    r.__exit__ = lambda self, *exc: False
    return r


def _collect(gen):
    return list(gen)


class TestLocalStreamFraming:
    def test_frames_are_exact_opus_length_after_resample(self):
        enc = RecordingEncoder()
        # 48k 立体声 1.0 秒 → 24k 单声道 1.0 秒 → 24000/1000*60 = 1440 样本/帧
        chunks = [_stereo_pcm(48000)]
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=_fake_response(chunks)):
            out = _collect(_tts_local_stream("你好", _encoder=enc))
        # 1.0 秒 = 1000ms / 60ms = 16.67 帧 → 16 个整帧 + 尾帧补零 = 17
        assert len(out) == 17
        assert set(enc.frames) == {1440}
        assert all(p == b"\x00" * 3 for p in out)

    def test_short_input_still_emits_one_padded_frame(self):
        enc = RecordingEncoder()
        # 只有 100 个源采样帧（约 2ms），远不够一个 60ms 的 opus 帧
        chunks = [_stereo_pcm(100)]
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=_fake_response(chunks)):
            out = _collect(_tts_local_stream("啊", _encoder=enc))
        # 尾帧补零后必须有 1 帧，不能把整句吞掉
        assert len(out) == 1
        assert enc.frames == [1440]

    def test_partial_source_frame_is_carried_across_chunks(self):
        """服务端按 4096 字节切块，块边界会切断立体声采样帧（4 字节）。

        没对齐时把半帧丢掉会造成每个块边界一个样本的错位，累积起来整句音调偏移。
        """
        enc = RecordingEncoder()
        raw = _stereo_pcm(2400)  # 9600 字节，不是 4096 的整数倍
        chunks = [raw[i:i + 4096] for i in range(0, len(raw), 4096)]
        assert len(chunks) > 1
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=_fake_response(chunks)):
            out = _collect(_tts_local_stream("你好", _encoder=enc))
        expected_samples = 2400 // 2  # 下混后单声道样本数
        total = len(enc.frames) * 1440
        # 补零帧最多多出一整帧，且不能少于实际时长
        assert total >= expected_samples
        assert total - expected_samples < 1440

    def test_downmix_halves_sample_count(self):
        """48k 立体声 N 帧 → 48k 单声道 N 样本 → 24k 后 N/2 样本。"""
        enc = RecordingEncoder()
        chunks = [_stereo_pcm(48000)]  # 1.0s
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=_fake_response(chunks)):
            _collect(_tts_local_stream("你好", _encoder=enc))
        # 24k × 1.0s = 24000 样本，向上取整到 1440 的倍数
        assert len(enc.frames) * 1440 >= 24000
        assert len(enc.frames) * 1440 - 24000 < 1440

    def test_headers_drive_source_format(self):
        """源格式从响应头读，不能写死 48000/2。"""
        enc = RecordingEncoder()
        chunks = [struct.pack("<h", 1000) * 16000]  # 16k 单声道 1.0s
        resp = _fake_response(chunks, headers={"x-sample-rate": "16000", "x-channels": "1"})
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=resp):
            _collect(_tts_local_stream("你好", _encoder=enc))
        # 16k → 24k 上采样 1.5 倍：24000 样本
        assert len(enc.frames) * 1440 >= 24000
        assert len(enc.frames) * 1440 - 24000 < 1440


class TestLocalStreamGuards:
    def test_raises_when_url_missing(self):
        from agent.asr_tts import _tts_local_stream
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": ""}):
            with pytest.raises(RuntimeError, match="LOCAL_TTS_STREAM_URL"):
                _collect(_tts_local_stream("你好", _encoder=RecordingEncoder()))

    def test_raises_on_http_error(self):
        from agent.asr_tts import _tts_local_stream
        resp = _fake_response([], status=500)
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=resp):
            with pytest.raises(RuntimeError, match="HTTP 500"):
                _collect(_tts_local_stream("你好", _encoder=RecordingEncoder()))

    def test_cancel_stops_early(self):
        from agent.asr_tts import _tts_local_stream
        import threading
        cancel = threading.Event()
        enc = RecordingEncoder()

        def _stop_after_first():
            cancel.set()

        chunks = [_stereo_pcm(48000)] * 5
        resp = _fake_response(chunks)
        with patch.dict(os.environ, {"LOCAL_TTS_STREAM_URL": "http://t.test/stream"}), \
             patch("voice_agent._session.post", return_value=resp):
            gen = _tts_local_stream("你好", _encoder=enc, cancel_evt=cancel)
            first = next(gen)
            assert first
            _stop_after_first()
            rest = _collect(gen)
        # 取消后不应该把 5 块全跑完
        assert len(rest) < 5 * 17


@requires_opus
class TestAiterPackets:
    def test_list_source_passes_through(self):
        from app.xiaozhi_ws import _aiter_packets

        async def run():
            return [p async for p in _aiter_packets(asyncio.get_running_loop(), [b"a", b"b"])]

        assert asyncio.run(run()) == [b"a", b"b"]

    def test_generator_source_is_pulled_lazily(self):
        """生成器不能先收完再发——那样等于非流式。"""
        from app.xiaozhi_ws import _aiter_packets
        pulled = []

        def gen():
            for i in range(3):
                pulled.append(i)
                yield bytes([i])

        async def run():
            out = []
            async for pkt in _aiter_packets(asyncio.get_running_loop(), gen()):
                out.append(pkt)
                # 每拿到一个包时，后面还没被拉取
                assert len(pulled) == len(out)
            return out

        assert asyncio.run(run()) == [b"\x00", b"\x01", b"\x02"]

    def test_empty_generator_yields_nothing(self):
        from app.xiaozhi_ws import _aiter_packets

        async def run():
            return [p async for p in _aiter_packets(asyncio.get_running_loop(), iter(()))]

        assert asyncio.run(run()) == []
