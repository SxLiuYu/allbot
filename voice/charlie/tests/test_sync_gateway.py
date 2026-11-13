import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.routes.sync import create_app

os.environ["SYNC_ALLOW_INSECURE_LOCAL"] = "1"
AUTH = {"Authorization": "Bearer local-test-admin"}


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "sync.db"))) as c:
        yield c


def create(client, task_id="task_test_0001", key="create-key-0001", **kwargs):
    body = {"id": task_id, "goal": "打开设置，告诉我第一个分类名字", "status": "pending", "origin": "feishu", "target": "phone", "ownerId": "ou_owner", "sensitivity": "normal", **kwargs}
    return client.post("/sync/v1/tasks", json=body, headers={**AUTH, "Idempotency-Key": key})


def test_health_and_pairing_is_single_use(client):
    assert client.get("/sync/v1/health", headers=AUTH).json()["protocol"] == "mika-relay.v2"
    code = client.post("/sync/v1/admin/pairing-codes", json={"deviceId": "emulator-5554"}, headers=AUTH).json()["code"]
    paired = client.post("/pair", json={"code": code}).json()
    assert len(paired["deviceToken"]) == 43
    assert paired["mcpUrl"] == "/mcp"
    assert client.post("/pair", json={"code": code}).status_code == 409
    assert client.post("/pair", json={"code": "wrong-code"}).status_code == 401


def test_devices_list_and_unpair_revokes_token(client):
    code = client.post("/sync/v1/admin/pairing-codes", json={"deviceId": "emulator-5554"}, headers=AUTH).json()["code"]
    token = client.post("/pair", json={"code": code}).json()["deviceToken"]
    devices = client.get("/sync/v1/devices", headers=AUTH).json()["devices"]
    assert any(d["deviceId"] == "emulator-5554" and d["online"] is False and "tasks" in d["capabilities"] for d in devices)
    device_auth = {"Authorization": f"Bearer {token}"}
    assert client.delete("/device", headers=device_auth).json()["revoked"] == "emulator-5554"
    assert client.delete("/device", headers=device_auth).status_code == 401
    assert not any(d["deviceId"] == "emulator-5554" for d in client.get("/sync/v1/devices", headers=AUTH).json()["devices"])


def test_create_is_idempotent_under_concurrency(client):
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: create(client), range(2)))
    assert [r.status_code for r in responses] == [201, 201]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    assert len(client.get("/sync/v1/tasks", headers=AUTH).json()["tasks"]) == 1


def test_event_idempotency_and_version_cas(client):
    create(client)
    event = {"deviceId": "emulator-5554", "idempotencyKey": "claim-key-0001", "type": "claimed", "fromVersion": 1, "payload": {"status": "running"}}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=event, headers=AUTH).status_code == 200
    duplicate = client.post("/sync/v1/tasks/task_test_0001/events", json=event, headers=AUTH).json()
    assert duplicate["deduplicated"] is True
    stale = client.post("/sync/v1/tasks/task_test_0001/events", json={**event, "idempotencyKey": "claim-key-other"}, headers=AUTH)
    assert stale.status_code == 409
    assert client.get("/sync/v1/tasks/task_test_0001", headers=AUTH).json()["version"] == 2


def test_sensitive_task_requires_human_review(client):
    create(client, sensitivity="payment")
    running = {"deviceId": "phone", "idempotencyKey": "claim-pay-01", "type": "claimed", "payload": {"status": "running"}}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=running, headers=AUTH).status_code == 200
    done = {"deviceId": "phone", "idempotencyKey": "done-pay-001", "type": "result", "payload": {"status": "done"}}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=done, headers=AUTH).status_code == 409
    review = {"deviceId": "phone", "idempotencyKey": "review-pay-1", "type": "result", "payload": {"status": "waiting_review", "result": {"text": "待确认"}}}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=review, headers=AUTH).status_code == 200
    accept = {"deviceId": "mac", "idempotencyKey": "accept-pay-1", "type": "review_accept", "actor": "owner:ou_owner", "payload": {"status": "done"}}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=accept, headers=AUTH).status_code == 200


def paired_socket(client):
    code = client.post("/sync/v1/admin/pairing-codes", json={"deviceId": "emulator-5554"}, headers=AUTH).json()["code"]
    token = client.post("/pair", json={"code": code}).json()["deviceToken"]
    return client.websocket_connect("/device", headers={"Authorization": f"Bearer {token}", "Sec-WebSocket-Protocol": "mika-relay.v2"})


def frame(frame_id="request_00000001"):
    return {"type": "request", "id": frame_id, "method": "GET", "path": "/api/v1", "headers": {"accept": "application/json"}, "body": "", "status": 0, "query": "", "client": ""}


def test_relay_roundtrip_and_duplicate_frame_rejected(client):
    with paired_socket(client) as ws:
        ws.send_text(json.dumps(frame()))
        response = ws.receive_json()
        assert response["status"] == 503
        ws.send_text(json.dumps(frame()))
        assert ws.receive()["type"] == "websocket.close"


def test_store_restart_keeps_idempotency_and_cursor(tmp_path):
    path = str(tmp_path / "sync.db")
    with TestClient(create_app(path)) as first:
        create(first)
    with TestClient(create_app(path)) as second:
        create(second)
        assert len(second.get("/sync/v1/tasks", headers=AUTH).json()["tasks"]) == 1


def test_sse_reconnect_since_returns_each_event_once(client):
    create(client)
    for i in range(3):
        event = {"deviceId": "phone", "idempotencyKey": f"progress-{i:08d}", "type": "progress", "payload": {"progress": {"step": i}}}
        assert client.post("/sync/v1/tasks/task_test_0001/events", json=event, headers=AUTH).status_code == 200
    with client.stream("GET", "/sync/v1/stream?since=1&replay_only=true", headers=AUTH) as response:
        lines = []
        for line in response.iter_lines():
            if line.startswith("data: "):
                lines.append(json.loads(line[6:]))
    assert [event["payload"]["progress"]["step"] for event in lines] == [0, 1, 2]
    assert len({event["seq"] for event in lines}) == 3


def test_gateway_dispatches_real_relay_request_and_receives_device_result(client):
    create(client, deviceId="emulator-5554")
    with paired_socket(client) as ws:
        import threading
        def device_worker():
            request = ws.receive_json()
            goal = json.loads(base64.b64decode(request["body"]))["goal"]
            assert goal.startswith("打开设置")
            result = {"task_id": "phone-run-1", "status": "done", "answer": "网络和互联网"}
            response = {"type": "response", "id": request["id"], "status": 201, "headers": {"content-type": "application/json"}, "body": base64.b64encode(json.dumps(result).encode()).decode()}
            ws.send_text(json.dumps(response))
        thread = threading.Thread(target=device_worker)
        thread.start()
        dispatched = client.post("/sync/v1/tasks/task_test_0001/dispatch", headers=AUTH)
        thread.join(timeout=5)
    assert dispatched.status_code == 200
    assert dispatched.json()["deviceTask"]["answer"] == "网络和互联网"
    assert client.get("/sync/v1/tasks/task_test_0001", headers=AUTH).json()["status"] == "running"


def test_device_event_is_bound_to_its_token_and_cannot_accept_review(client):
    create(client)
    code = client.post("/sync/v1/admin/pairing-codes", json={"deviceId": "emulator-5554"}, headers=AUTH).json()["code"]
    token = client.post("/pair", json={"code": code}).json()["deviceToken"]
    auth = {"Authorization": f"Bearer {token}"}
    event = {"deviceId": "emulator-5554", "idempotencyKey": "device-event-1", "type": "status", "payload": {"status": "running"}}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=event, headers=auth).status_code == 200
    other = {**event, "idempotencyKey": "device-event-2", "deviceId": "another-phone"}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=other, headers=auth).status_code == 403
    review = {**event, "idempotencyKey": "device-event-3", "type": "review_accept"}
    assert client.post("/sync/v1/tasks/task_test_0001/events", json=review, headers=auth).status_code == 403
