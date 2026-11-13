"""测试 ASR/TTS 优先级链遍历

注意：asr_tts._TTS_PROVIDERS / _ASR_PROVIDERS 在模块导入时即被填充为真实的
函数引用。patch.object(asr_tts, '_tts_baidu', ...) 只能替换模块属性，无法更新
字典中的引用，因此所有 provider 函数 mock 必须直接 patch.dict 到 _TTS_PROVIDERS /
_ASR_PROVIDERS，保证 tts()/asr() 遍历时取到的是 mock。
"""
import os
import pytest
from unittest.mock import patch, MagicMock


# ─────────────────────────────────────────────────────────────────────────────
# 规范音色映射层（resolve_voice）
# ─────────────────────────────────────────────────────────────────────────────

class TestStepfunVoiceMapping:
    """验证 resolve_voice 在各 provider TTS 函数中的接入"""

    def test_tts_stepfun_uses_resolved_voice(self):
        """_tts_stepfun 应将规范音色 Ethan 解析为 cixingnansheng"""
        from agent import asr_tts
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"audio"
        # _tts_stepfun 开头会检查 STEPFUN_KEY，没配就抛「未配置」——这条测的是
        # 音色映射，与 Key 有无无关，必须先把 Key 补上才走得到发请求那一步。
        with patch.dict(os.environ, {"STEPFUN_KEY": "sk-test"}), \
             patch("agent.asr_tts.get_effective_tts_config", return_value=("Ethan", 1.0)), \
             patch("voice_agent._session.post", return_value=mock_resp) as mock_post:
            result = asr_tts._tts_stepfun("你好")
            payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get("json")
            assert payload["voice"] == "cixingnansheng"

    def test_tts_baidu_uses_resolved_per(self):
        """_tts_baidu 应将规范音色 Ethan 解析为 per=3"""
        from agent import asr_tts
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "audio/mp3"}
        mock_resp.content = b"audio"
        mock_resp.json.return_value = {}
        with patch("agent.asr_tts.get_effective_tts_config", return_value=("Ethan", 1.0)), \
             patch("agent.asr_tts._baidu_get_token", return_value="fake-token"), \
             patch("voice_agent._session.post", return_value=mock_resp) as mock_post:
            result = asr_tts._tts_baidu("你好")
            call_kwargs = mock_post.call_args.kwargs
            data = call_kwargs.get("data", {})
            assert data.get("per") == 3


# ─────────────────────────────────────────────────────────────────────────────
# ASR
# ─────────────────────────────────────────────────────────────────────────────

class TestASRPriority:
    def test_asr_returns_first_successful(self):
        from agent import asr_tts
        fake = MagicMock(return_value="你好")
        with patch.dict(asr_tts._ASR_PROVIDERS, {"sensevoice": fake}):
            result = asr_tts.asr(b"audio", "mp3")
            assert result == "你好"
            fake.assert_called_once_with(b"audio", "mp3")

    def test_asr_falls_through_on_exception(self):
        from agent import asr_tts
        fake_sv = MagicMock(side_effect=RuntimeError("fail"))
        fake_bd = MagicMock(return_value="你好")
        with patch.dict(asr_tts._ASR_PROVIDERS, {
            "sensevoice": fake_sv,
            "baidu": fake_bd,
        }):
            result = asr_tts.asr(b"audio", "mp3")
            assert result == "你好"
            fake_bd.assert_called_once_with(b"audio", "mp3")

    def test_asr_skips_stepfun_when_no_key(self):
        from agent import asr_tts
        # Make every earlier provider raise so execution reaches stepfun
        fake_sv  = MagicMock(side_effect=RuntimeError("fail"))
        fake_bd  = MagicMock(side_effect=RuntimeError("fail"))
        fake_sf  = MagicMock(side_effect=AssertionError("should not be called"))
        fake_vk  = MagicMock(return_value="")
        with patch.dict(os.environ, {"STEPFUN_KEY": ""}), \
             patch.dict(asr_tts._ASR_PROVIDERS, {
                 "sensevoice": fake_sv,
                 "baidu": fake_bd,
                 "stepfun": fake_sf,
                 "vosk":     fake_vk,
             }):
            result = asr_tts.asr(b"audio", "mp3")
            fake_sf.assert_not_called()

    def test_asr_skips_unknown_provider(self):
        from agent import asr_tts
        fake_bd = MagicMock(return_value="你好")
        original = asr_tts.ASR_PRIORITY
        with patch.dict(asr_tts._ASR_PROVIDERS, {"baidu": fake_bd}):
            asr_tts.ASR_PRIORITY = ["unknown_provider", "baidu"]
            try:
                result = asr_tts.asr(b"audio", "mp3")
                assert result == "你好"
            finally:
                asr_tts.ASR_PRIORITY = original


# ─────────────────────────────────────────────────────────────────────────────
# TTS
# ─────────────────────────────────────────────────────────────────────────────

class TestTTSPriority:
    def test_tts_returns_first_successful(self):
        from agent import asr_tts
        fake = MagicMock(return_value=b"mp3audio")
        with patch.dict(asr_tts._TTS_PROVIDERS, {"baidu": fake}):
            result = asr_tts.tts("你好")
            assert result == b"mp3audio"

    def test_tts_falls_through_on_exception(self):
        from agent import asr_tts
        fake_bd = MagicMock(side_effect=RuntimeError("baidu down"))
        fake_sf = MagicMock(side_effect=RuntimeError("stepfun down"))
        fake_fn = MagicMock(return_value=b"mp3audio")
        with patch.dict(asr_tts._TTS_PROVIDERS, {
            "baidu": fake_bd,
            "stepfun": fake_sf,
            "finna": fake_fn,
        }):
            result = asr_tts.tts("你好")
            assert result == b"mp3audio"
            fake_fn.assert_called_once_with("你好")

    def test_tts_skips_stepfun_when_no_key(self):
        from agent import asr_tts
        from agent.asr_tts import TTSUnavailableError
        # Every earlier provider must raise so we reach stepfun in the loop
        fake_bd  = MagicMock(side_effect=RuntimeError("baidu fail"))
        fake_fn  = MagicMock(side_effect=RuntimeError("finna fail"))
        fake_sf  = MagicMock(side_effect=AssertionError("should not be called"))
        fake_vk  = MagicMock(return_value=b"vosk-mp3")
        with patch.dict(os.environ, {"STEPFUN_KEY": ""}), \
             patch.dict(asr_tts._TTS_PROVIDERS, {
                 "baidu": fake_bd,
                 "finna": fake_fn,
                 "stepfun": fake_sf,
             }):
            # vosk is not a TTS provider; append it just to have a final fallback
            asr_tts._TTS_PROVIDERS["vosk"] = fake_vk
            try:
                result = asr_tts.tts("你好")
                # Should return from vosk, stepfun never called
                assert fake_sf.call_count == 0
            except TTSUnavailableError:
                # Even on full failure, stepfun must not be called
                assert fake_sf.call_count == 0
            finally:
                asr_tts._TTS_PROVIDERS.pop("vosk", None)
                # 全链失败会把熔断打开 120s，不清掉后面所有 tts() 用例都会直接抛
                asr_tts._tts_unavailable_until = 0.0
                asr_tts._tts_failures = 0

    def test_tts_unavailable_error_fallthrough(self):
        """When a provider raises TTSUnavailableError (cooldown/rate-limited),
        the chain should continue to the next provider for resilience."""
        from agent import asr_tts
        from agent.asr_tts import TTSUnavailableError
        fake_bd = MagicMock(side_effect=TTSUnavailableError("cooldown"))
        fake_sf = MagicMock(return_value=b"audio_ok")
        fake_fn = MagicMock(side_effect=AssertionError("should not be called"))
        # stepfun 需要 Key 才不会被跳过；这条断言的就是「跳到 stepfun」。
        with patch.dict(os.environ, {"STEPFUN_KEY": "sk-test"}), \
             patch.object(asr_tts, "_tts_unavailable_until", 0.0), \
             patch.dict(asr_tts._TTS_PROVIDERS, {
                 "baidu": fake_bd,
                 "stepfun": fake_sf,
                 "finna": fake_fn,
             }):
            result = asr_tts.tts("你好")
            assert result == b"audio_ok"
            fake_bd.assert_called()
            fake_sf.assert_called()
            fake_fn.assert_not_called()

    def test_tts_all_providers_unavailable_raises(self):
        """When all providers raise TTSUnavailableError, the chain raises."""
        from agent import asr_tts
        from agent.asr_tts import TTSUnavailableError
        fake_bd = MagicMock(side_effect=TTSUnavailableError("cooldown"))
        fake_sf = MagicMock(side_effect=TTSUnavailableError("rate_limited"))
        fake_fn = MagicMock(side_effect=TTSUnavailableError("circuit_open"))
        with patch.dict(asr_tts._TTS_PROVIDERS, {
            "baidu": fake_bd,
            "stepfun": fake_sf,
            "finna": fake_fn,
        }):
            with pytest.raises(TTSUnavailableError):
                asr_tts.tts("你好")


# ─────────────────────────────────────────────────────────────────────────────
# Provider 注册表结构验证
# ─────────────────────────────────────────────────────────────────────────────

class TestProviderRegistry:
    def test_asr_providers_has_four(self):
        from agent.asr_tts import _ASR_PROVIDERS
        assert set(_ASR_PROVIDERS.keys()) == {
            "sensevoice", "baidu", "stepfun", "vosk", "local"}

    def test_tts_providers_has_four(self):
        from agent.asr_tts import _TTS_PROVIDERS
        # 6 个 provider：audio8(本地克隆) / cosyvoice(克隆，惰性加载占位 None)
        assert set(_TTS_PROVIDERS.keys()) == {
            "baidu", "finna", "stepfun", "edge", "audio8", "local", "cosyvoice"}
        # cosyvoice 注册前是占位 None，由 tts() 分发循环惰性加载
        assert _TTS_PROVIDERS["cosyvoice"] is None

    def test_registry_names_are_in_default_priority_chains(self):
        """注册了 provider 但没进默认链等于没接。"""
        from agent import asr_tts
        assert "local" in asr_tts.ASR_PRIORITY
        assert "local" in asr_tts.TTS_PRIORITY
        # 局域网链路排在云端之后：不可达时不该拖慢首选路径
        assert asr_tts.ASR_PRIORITY.index("local") > asr_tts.ASR_PRIORITY.index("sensevoice")
        assert asr_tts.TTS_PRIORITY.index("local") > asr_tts.TTS_PRIORITY.index("stepfun")


# ─────────────────────────────────────────────────────────────────────────────
# 局域网语音链路（Mac 上的 realtime 三件套）
# ─────────────────────────────────────────────────────────────────────────────

class TestLocalProviders:
    """local provider 的契约来自实测：
    ASR = WebSocket /asr/stream（start/二进制/commit → final）
    TTS = OpenAI 兼容 /v1/audio/speech，返回 WAV，且 voice 参数必须省略
    """

    def test_tts_local_posts_openai_shaped_body(self):
        from agent import asr_tts
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.content = b"RIFF" + b"\x00" * 500
        with patch.dict(os.environ, {"LOCAL_TTS_URL": "http://tts.test/v1/audio/speech"}), \
             patch("voice_agent._session.post", return_value=mock_resp) as mock_post:
            out = asr_tts._tts_local("你好")
        assert out == mock_resp.content
        url = mock_post.call_args.args[0]
        payload = mock_post.call_args.kwargs["json"]
        assert url == "http://tts.test/v1/audio/speech"
        assert payload["input"] == "你好"
        assert payload["model"] == "moss-tts-nano"
        # 服务端只有 voice 缺省时才 200；传任何值都 500（实测四个取值）
        assert "voice" not in payload

    def test_tts_local_raises_when_url_missing(self):
        from agent import asr_tts
        with patch.dict(os.environ, {"LOCAL_TTS_URL": ""}):
            with pytest.raises(RuntimeError, match="LOCAL_TTS_URL"):
                asr_tts._tts_local("你好")

    def test_tts_local_raises_on_http_error(self):
        from agent import asr_tts
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "voice not supported"
        with patch.dict(os.environ, {"LOCAL_TTS_URL": "http://tts.test/v1/audio/speech"}), \
             patch("voice_agent._session.post", return_value=mock_resp):
            with pytest.raises(RuntimeError, match="HTTP 500"):
                asr_tts._tts_local("你好")

    def test_asr_local_raises_when_url_missing(self):
        from agent import asr_tts
        with patch.dict(os.environ, {"LOCAL_ASR_URL": ""}):
            with pytest.raises(RuntimeError, match="LOCAL_ASR_URL"):
                asr_tts._asr_local(b"\x00" * 400, "wav")

    def test_asr_local_rejects_tiny_audio(self):
        from agent import asr_tts
        with patch.dict(os.environ, {"LOCAL_ASR_URL": "ws://asr.test/asr/stream"}):
            with pytest.raises(RuntimeError, match="无有效音频"):
                asr_tts._asr_local(b"\x00" * 10, "wav")

    def test_local_skipped_in_tts_chain_when_unconfigured(self):
        """未配置 LOCAL_TTS_URL 时不该走 local，也不该因为抛异常打断链。"""
        from agent import asr_tts
        fake_sf = MagicMock(return_value=b"cloud-audio")
        original = asr_tts.TTS_PRIORITY
        asr_tts.TTS_PRIORITY = ["stepfun", "local"]
        try:
            # STEPFUN_KEY 必须给值：tts() 在 key 为空时会跳过 stepfun，
            # 那样整条链一次都不调，测不到「local 被跳过」这件事。
            with patch.dict(os.environ, {"LOCAL_TTS_URL": "", "STEPFUN_KEY": "sk-test"}), \
                 patch.dict(asr_tts._TTS_PROVIDERS, {
                     "stepfun": fake_sf,
                     "local": MagicMock(side_effect=AssertionError("local 不该被调用")),
                 }), \
                 patch.object(asr_tts, "_tts_unavailable_until", 0.0), \
                 patch.object(asr_tts, "_tts_failures", 0), \
                 patch.object(asr_tts, "_tts_cache", {}):
                out = asr_tts.tts("你好")
        finally:
            asr_tts.TTS_PRIORITY = original
            # tts() 成功会写缓存，失败会写熔断，两种都清掉免得连累后面的用例
            asr_tts._tts_unavailable_until = 0.0
            asr_tts._tts_failures = 0
            asr_tts._tts_cache.clear()
        assert out == b"cloud-audio"

    def test_local_skipped_in_asr_chain_when_unconfigured(self):
        from agent import asr_tts
        fake_sv = MagicMock(return_value="你好")
        with patch.dict(os.environ, {"LOCAL_ASR_URL": ""}), \
             patch.dict(asr_tts._ASR_PROVIDERS, {
                 "sensevoice": fake_sv,
                 "local": MagicMock(side_effect=AssertionError("local 不该被调用")),
             }):
            out = asr_tts.asr(b"audio", "mp3")
        assert out == "你好"


class TestLocalUrnUrlNormalisation:
    """LOCAL_ASR_URL 允许写成 http://，asr_url 归一化要落到 ws://。"""

    @pytest.mark.parametrize("given,expected_prefix", [
        ("http://172.16.84.88:8095/asr/stream", "ws://"),
        ("https://asr.test/asr/stream", "wss://"),
        ("ws://172.16.84.88:8095/asr/stream", "ws://"),
    ])
    def test_scheme_is_normalised(self, given, expected_prefix):
        from agent import asr_tts
        captured = {}

        class _FakeWS:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def send(self, _data):
                return None

            async def recv(self):
                import json as _j
                # 第一条必须是 ready，之后给 final
                if not captured.get("greeted"):
                    captured["greeted"] = True
                    return _j.dumps({"type": "ready"})
                return _j.dumps({"type": "final", "text": "你好"})

        def _fake_connect(url, **_kw):
            captured["url"] = url
            return _FakeWS()

        fake_mod = MagicMock()
        fake_mod.connect = _fake_connect
        with patch.dict(os.environ, {"LOCAL_ASR_URL": given}), \
             patch.dict("sys.modules", {"websockets": fake_mod}), \
             patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(stdout=b"\x00\x00" * 4000, returncode=0)
            assert asr_tts._asr_local(b"\x00" * 400, "wav") == "你好"
        assert captured["url"].startswith(expected_prefix)


# ─────────────────────────────────────────────────────────────────────────────
# ASR 文本纠错（来自 gitee assistant-x-openclaw 的「文本纠错兜底」思路）
# ─────────────────────────────────────────────────────────────────────────────

class TestASRCorrection:
    def test_correction_disabled_by_default(self):
        """未显式开启时，correct_asr_text 应原样返回"""
        import importlib
        import agent.asr_correction as mod
        with patch.dict(os.environ, {"ASR_CORRECTION_ENABLED": "0"}):
            importlib.reload(mod)
            assert mod.correct_asr_text("四点了") == "四点了"
        # 恢复默认开启
        importlib.reload(mod)

    def test_filler_words_stripped(self):
        import agent.asr_correction as mod
        assert mod.correct_asr_text("嗯，帮我开空调") == "帮我开空调"
        assert mod.correct_asr_text("啊，现在几点了") == "现在几点了"

    def test_homophone_correction(self):
        import agent.asr_correction as mod
        assert mod.correct_asr_text("在开空调") == "再开空调"

    def test_wake_word_normalization(self):
        import agent.asr_correction as mod
        assert mod.correct_asr_text("查里，几点了") == "charlie，几点了"
        assert mod.correct_asr_text("小智，开灯") == "charlie，开灯"

    def test_file_based_corrections(self, tmp_path):
        """data/text_corrections.txt 规则应生效"""
        import agent.asr_correction as mod
        # 写入临时纠错文件
        corrections = tmp_path / "text_corrections.txt"
        corrections.write_text("四点了 : 十点了\n关机 : 关掉\n", encoding="utf-8")
        # 临时替换规则文件路径
        orig_file = mod._CORRECTIONS_FILE
        mod._CORRECTIONS_FILE = str(corrections)
        mod._file_rules_mtime = 0.0
        try:
            assert mod.correct_asr_text("四点了") == "十点了"
            assert mod.correct_asr_text("关机") == "关掉"
        finally:
            mod._CORRECTIONS_FILE = orig_file
            mod._file_rules_mtime = 0.0
            mod._load_file_rules()

    def test_empty_input_returns_original(self):
        import agent.asr_correction as mod
        assert mod.correct_asr_text("") == ""
        assert mod.correct_asr_text("   ") == "   "

    def test_asr_integration_calls_correction(self):
        """asr() 成功返回后应调用 correct_asr_text 做后处理"""
        from agent import asr_tts
        fake = MagicMock(return_value="四点了")
        with patch.dict(asr_tts._ASR_PROVIDERS, {"sensevoice": fake}), \
             patch("agent.asr_correction.correct_asr_text", side_effect=lambda t, **kw: t.replace("四", "十")) as mock_correct:
            result = asr_tts.asr(b"audio", "mp3", session_id="test_session")
            assert result == "十点了"
            mock_correct.assert_called_once_with("四点了", session_id="test_session")

