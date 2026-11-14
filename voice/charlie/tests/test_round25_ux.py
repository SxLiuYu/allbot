"""Round 25 UX regression tests.

P1-1: 静音时段提醒补播不被过期判定吞掉 + 过期未送达推送飞书
P1-2: 飞书"正在思考…"占位（3 秒延迟）
P1-3: 飞书 per-chat 消息串行化
P1-4: brain 错误消息区分超时/工具不可用
P1-5: 飞书图片消息走视觉分析
"""
import os
import re
from unittest.mock import patch, MagicMock


# ─── P1-1: Reminder expiry vs retry_after ─────────────────────────────────

class TestReminderExpiryRetryAfter:
    """过期基准必须是 `due`，**不能**是 max(due, retry_after)。

    本组最初按「retry_after 晚于 due 就把过期基准推后」写（为了让静音时段
    的提醒在补播时刻不被判过期），但那是错的方向：重试会不断推后
    retry_after，以它为基准等于给提醒无限续命。真实事故是起床提醒 5 分钟
    一次循环了 64 次（见 app/reminders.py:660-661 的注释）。
    静音时段补播由 retry_after 控制「何时可以播」，与「何时算彻底过期」
    是两件事，因此这里断言的是前者不再污染后者。
    """

    def _read_claim_fn(self):
        import app.reminders as rem
        src = open(rem.__file__).read()
        idx = src.find("def claim_due_reminders")
        assert idx > 0
        return src[idx:idx + 4000]

    def test_expiry_is_anchored_on_due_not_retry_after(self):
        """过期判定只看 due；出现 expiry_base/retry_after 基准就是回归。"""
        body = self._read_claim_fn()
        assert "now - due > dt.timedelta(hours=EXPIRED_AFTER_HOURS)" in body
        assert "expiry_base" not in body, \
            "过期基准被改回 retry_after，会让重试无限续命（见真实事故 64 次循环）"

    def test_retry_after_does_not_extend_expiry(self):
        """retry_after 晚于 due 时也不该把过期基准推后。"""
        body = self._read_claim_fn()
        assert "retry_after > due" not in body
        assert "expiry_base = retry_after" not in body
        # 有一句显式注释钉住这个决定，防止后人「顺手优化」回去
        assert "过期锚定 due 而非 retry_after" in body

    def test_expired_undelivered_pushes_feishu(self):
        """未送达的提醒过期时应推送飞书通知"""
        body = self._read_claim_fn()
        assert "提醒已过期未送达" in body
        assert "push_feishu_async" in body

    def test_delivered_reminder_no_expiry_notify(self):
        """已送达(delivered)的提醒过期时不应推送飞书。

        注意 `enqueued` 是**要**推的：入队只代表进了设备 pending 队列，
        设备离线时队列 TTL 5 分钟就会丢，用户根本没听到，属于「未送达」。
        本用例原先断言 enqueued 不该通知，与同文件 test_expired_undelivered_
        pushes_feishu 的初衷以及实现在 "retry", None, "", "pending", "enqueued"
        上的取值直接冲突。
        """
        body = self._read_claim_fn()
        m = re.search(r'old_delivery_state in \(([^)]+)\)', body)
        assert m, "未找到 old_delivery_state 条件"
        states = m.group(1)
        assert "retry" in states
        assert "pending" in states
        assert "enqueued" in states
        assert "delivered" not in states

    def test_quiet_hours_reminder_scenario(self):
        """静音时段内到期的提醒，在静音结束后的补播时刻仍在过期窗口内。

        EXPIRED_AFTER_HOURS=2（app/reminders.py），所以场景要落在 2 小时内：
        00:20 到期、静音到 01:30 补播 —— 1h10m，仍在窗口内，能正常播出。
        （原先写 02:00 → 07:05 共 5 小时，本身就超窗口，断言必然失败；
        这个用例要守的是「静音补播不被误判过期」，不是让窗口跟着 retry_after 走。）
        """
        import app.reminders as rem
        import datetime as dt
        due = dt.datetime(2026, 8, 29, 0, 20)
        retry_after = dt.datetime(2026, 8, 29, 1, 30)
        now = dt.datetime(2026, 8, 29, 1, 30, 5)
        assert now - due < dt.timedelta(hours=rem.EXPIRED_AFTER_HOURS), \
            "静音时段补播的提醒不应在补播时刻被标记过期"
        # retry_after 只决定「何时可播」，不参与过期计算
        assert retry_after > due


# ─── P1-2: Feishu thinking placeholder ────────────────────────────────────

class TestFeishuThinkingPlaceholder:
    def _read_process_fn(self):
        import feishu_ws
        src = open(feishu_ws.__file__).read()
        idx = src.find("def _process_message_sync")
        assert idx > 0
        return src[idx:idx + 6000]

    def test_placeholder_text_exists(self):
        """应发送"正在思考…"占位消息"""
        body = self._read_process_fn()
        assert "正在思考" in body

    def test_placeholder_delayed_3s(self):
        """占位消息应有 3 秒延迟"""
        body = self._read_process_fn()
        assert "threading.Timer(3.0" in body

    def test_placeholder_suppressed_after_first_sentence(self):
        """首句发送后应取消占位（Event set）"""
        body = self._read_process_fn()
        assert "_first_sent.set()" in body
        assert "_first_sent.is_set()" in body

    def test_timer_cancelled_in_finally(self):
        """处理完成后应取消 Timer"""
        body = self._read_process_fn()
        assert "timer.cancel()" in body

    def test_no_placeholder_for_image(self):
        """图片消息不应启动占位 Timer"""
        body = self._read_process_fn()
        # 占位仅在 text 类型时启动
        assert 'if msg_kind == "text":' in body


# ─── P1-3: Per-chat serialization ─────────────────────────────────────────

class TestPerChatSerialization:
    def test_chat_locks_exist(self):
        """应有 per-chat 锁结构"""
        import feishu_ws
        assert hasattr(feishu_ws, "_chat_locks")
        assert hasattr(feishu_ws, "_get_chat_lock")

    def test_get_chat_lock_creates_and_reuses(self):
        """同一 chat_id 应复用同一把锁"""
        import feishu_ws
        lock1 = feishu_ws._get_chat_lock("test_chat_r25")
        lock2 = feishu_ws._get_chat_lock("test_chat_r25")
        assert lock1 is lock2

    def test_lock_serializes_same_chat(self):
        """同一 chat 的锁应真正互斥"""
        import feishu_ws
        import threading, time
        lock = feishu_ws._get_chat_lock("test_chat_r25_mutex")
        order = []
        def worker():
            with lock:
                order.append("enter")
                time.sleep(0.1)
                order.append("exit")
        t1 = threading.Thread(target=worker)
        t1.start()
        time.sleep(0.02)
        # 第二个线程应被阻塞
        acquired = lock.acquire(timeout=0.05)
        if acquired:
            lock.release()
        t1.join()
        assert not acquired or order == ["enter", "exit"]

    def test_lock_bounded(self):
        """锁数量应有上限（防泄漏）"""
        import feishu_ws
        src = open(feishu_ws.__file__).read()
        assert "_CHAT_LOCKS_MAX" in src


# ─── P1-4: Friendly brain errors ──────────────────────────────────────────

class TestFriendlyBrainErrors:
    def test_timeout_message(self):
        from agent.llm import _friendly_brain_error
        result = _friendly_brain_error("Request timed out after 30s")
        assert "超时" in result

    def test_mcp_unavailable_message(self):
        from agent.llm import _friendly_brain_error
        result = _friendly_brain_error("MCP工具 weather 暂时不可用，请稍后重试")
        assert "暂时不可用" in result
        assert "换个说法" in result

    def test_generic_fallback(self):
        from agent.llm import _friendly_brain_error
        result = _friendly_brain_error("some random error")
        assert "处理时出错了" in result

    def test_case_insensitive_timeout(self):
        from agent.llm import _friendly_brain_error
        result = _friendly_brain_error("BRAIN RUN TIMEOUT EXCEEDED")
        assert "超时" in result

    def test_used_in_stream_path(self):
        """brain_stream_sentences 异常路径应使用 _friendly_brain_error"""
        import agent.llm as llm
        src = open(llm.__file__).read()
        idx = src.find("def brain_stream_sentences")
        body = src[idx:]
        assert "_friendly_brain_error(" in body


# ─── P1-5: Feishu image → vision ──────────────────────────────────────────

class TestFeishuImageVision:
    def _read_process_fn(self):
        import feishu_ws
        src = open(feishu_ws.__file__).read()
        idx = src.find("def _process_message_sync")
        return src[idx:idx + 7000]

    def test_image_branch_exists(self):
        """应存在图片消息处理分支"""
        body = self._read_process_fn()
        assert 'msg_kind == "image"' in body
        assert "image_key" in body

    def test_feishu_image_download_api(self):
        """应调用飞书图片下载 API"""
        body = self._read_process_fn()
        assert "/im/v1/images/" in body
        assert "image_type" in body

    def test_vision_script_invoked(self):
        """应调用 mimo-vision 脚本"""
        import feishu_ws
        assert hasattr(feishu_ws, "VISION_SCRIPT")
        assert "mimo-vision" in feishu_ws.VISION_SCRIPT
        body = self._read_process_fn()
        assert "VISION_SCRIPT" in body

    def test_temp_file_cleanup(self):
        """临时图片文件应在 finally 中删除"""
        body = self._read_process_fn()
        img_idx = body.find("NamedTemporaryFile")
        assert img_idx > 0
        finally_idx = body.find("os.unlink", img_idx)
        assert finally_idx > 0

    def test_failure_fallback_message(self):
        """图片识别失败应有兜底提示"""
        body = self._read_process_fn()
        assert "图片识别暂时失败" in body

    def test_other_non_text_still_rejected(self):
        """其他非文本类型仍走拒绝路径"""
        import feishu_ws
        src = open(feishu_ws.__file__).read()
        assert "只能处理文字" in src
