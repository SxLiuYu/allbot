"""X4 收敛：charlie 飞书触达点在 allbot 为唯一发送方时只记录不发送。"""
import json
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import feishu_sender
from app.feishu_sender import charlie_can_send, record_delivery_ref, sender_mode


@pytest.fixture
def refs_file(tmp_path, monkeypatch):
    path = tmp_path / "delivery-refs.jsonl"
    monkeypatch.setattr(feishu_sender, "_REFS_FILE", str(path))
    monkeypatch.delenv("FEISHU_SENDER", raising=False)
    yield path


def read_refs(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_default_sender_is_allbot_and_charlie_cannot_send(refs_file):
    assert sender_mode() == "allbot"
    assert charlie_can_send() is False


def test_charlie_mode_restores_direct_sending(monkeypatch, refs_file):
    monkeypatch.setenv("FEISHU_SENDER", "charlie")
    assert sender_mode() == "charlie"
    assert charlie_can_send() is True


def test_record_delivery_ref_writes_jsonl(refs_file):
    record_delivery_ref("notification", ref="om_x123", note="测试")
    refs = read_refs(refs_file)
    assert refs[0]["touchpoint"] == "notification"
    assert refs[0]["ref"] == "om_x123"
    assert refs[0]["sender"] == "allbot"


def test_notification_push_suppressed_and_recorded(refs_file, monkeypatch):
    import app.notifications as notifications
    monkeypatch.setattr(notifications, "FEISHU_PUSH_ENABLED", True)
    posted = []
    monkeypatch.setattr(notifications.requests, "post", lambda *a, **k: posted.append(a))
    notifications.push_feishu_async("提醒：喝水")
    assert posted == []
    refs = read_refs(refs_file)
    assert any(r["touchpoint"] == "notification" and "喝水" in r["note"] for r in refs)


def test_notification_push_sends_in_charlie_mode(refs_file, monkeypatch):
    import app.notifications as notifications
    import feishu_token
    import time
    monkeypatch.setenv("FEISHU_SENDER", "charlie")
    monkeypatch.setattr(notifications, "FEISHU_PUSH_ENABLED", True)
    posted = []
    monkeypatch.setattr(notifications.requests, "post", lambda *a, **k: posted.append(a))
    monkeypatch.setattr(feishu_token, "get_tenant_access_token", lambda: "fake-token")
    notifications.push_feishu_async("提醒：喝水")
    for _ in range(40):
        if posted:
            break
        time.sleep(0.05)
    assert len(posted) == 1
    assert read_refs(refs_file) == []


def test_personalized_push_suppressed(refs_file, monkeypatch):
    import personalized_push
    posted = []
    monkeypatch.setattr(personalized_push.requests, "post", lambda *a, **k: posted.append(a))
    monkeypatch.setattr(personalized_push, "FEISHU_PUSH_OPEN_ID", "ou_test", raising=False)
    personalized_push._push_feishu("热点", rich_content={"zh_cn": {"title": "今日热点", "content": []}})
    assert posted == []
    refs = read_refs(refs_file)
    assert any(r["touchpoint"] == "personalized" and r["note"] == "今日热点" for r in refs)


def make_webhook_client(monkeypatch, token="test-verify-token"):
    from app.routes import feishu as feishu_routes
    monkeypatch.setattr(feishu_routes, "FEISHU_VERIFICATION_TOKEN", token)
    web_app = FastAPI()
    web_app.include_router(feishu_routes.router)
    return TestClient(web_app)


def feishu_event(msg_id="msg_wx_001", text="你好", token="test-verify-token"):
    return {
        "type": "event",
        "token": token,
        "event": {
            "msg_type": "text",
            "sender": {"sender_id": {"open_id": "ou_sender"}},
            "message": {"message_id": msg_id, "chat_id": "oc_chat", "content": json.dumps({"text": text})},
        },
    }


def test_webhook_suppressed_in_allbot_mode(refs_file, monkeypatch):
    client = make_webhook_client(monkeypatch)
    created_tasks = []
    resp = client.post("/api/feishu/webhook", json=feishu_event())
    assert resp.status_code == 200 and resp.json() == {"code": 0}
    refs = read_refs(refs_file)
    assert any(r["touchpoint"] == "webhook" and r["ref"] == "msg_wx_001" for r in refs)
    assert created_tasks == []


def test_webhook_still_routes_to_brain_in_charlie_mode(refs_file, monkeypatch):
    client = make_webhook_client(monkeypatch)
    monkeypatch.setenv("FEISHU_SENDER", "charlie")
    resp = client.post("/api/feishu/webhook", json=feishu_event())
    assert resp.status_code == 200
    assert read_refs(refs_file) == []


def test_webhook_rejects_bad_token(refs_file, monkeypatch):
    client = make_webhook_client(monkeypatch)
    resp = client.post("/api/feishu/webhook", json=feishu_event(token="wrong"))
    assert resp.status_code == 403
    assert read_refs(refs_file) == []


def test_ws_handler_suppressed(refs_file, monkeypatch):
    import feishu_ws
    from types import SimpleNamespace

    calls = []
    monkeypatch.setattr(feishu_ws, "_is_duplicate_message", lambda msg_id: False)
    monkeypatch.setattr(feishu_ws, "_send_text_reply", lambda chat_id, text: calls.append((chat_id, text)))
    event = SimpleNamespace(event=SimpleNamespace(
        message=SimpleNamespace(message_id="msg_ws_9", message_type="text", chat_id="oc_c",
                                content=json.dumps({"text": "在吗"})),
        sender=SimpleNamespace(sender_type="user", sender_id=SimpleNamespace(open_id="ou_u")),
    ))
    feishu_ws._on_message_receive(event)
    assert calls == []
    refs = read_refs(refs_file)
    assert any(r["touchpoint"] == "feishu_ws" and r["ref"] == "msg_ws_9" for r in refs)
