"""Minimal sync gateway. Import with create_app() rather than starting voice_server.

Run standalone: python -m app.routes.sync --db /path/sync.db
The outer voice_server authentication middleware also protects this router when mounted.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from typing import Any

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse

from app.sync_store import Conflict, NotFound, SyncStore

router = APIRouter()
PROTOCOL = "mika-relay.v2"
MAX_BODY = 1_048_576
MAX_FRAME = 2 * MAX_BODY
REQUEST_HEADERS = {"authorization", "origin", "x-mika-client", "content-type", "accept", "mcp-protocol-version", "mcp-method", "mcp-name", "mcp-session-id", "last-event-id"}
RESPONSE_HEADERS = {"content-type", "allow", "retry-after", "www-authenticate", "mcp-protocol-version"}
CLIENT_RE = re.compile(r"[0-9A-Fa-f.:/]{0,64}")
ID_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")


def _store(request: Request) -> SyncStore:
    return request.app.state.sync_store


def _admin(request: Request):
    store = _store(request)
    if not store.admin_token:
        raise HTTPException(503, "SYNC_ADMIN_TOKEN is not configured")
    if not hmac.compare_digest(request.headers.get("authorization", "").removeprefix("Bearer "), store.admin_token):
        raise HTTPException(401, "unauthorized")


def _device(store: SyncStore, token: str):
    import hashlib
    row = store.conn.execute("SELECT * FROM devices WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
    if row is None:
        raise PermissionError("invalid device token")
    return row["device_id"]


@router.get("/sync/v1/health")
def health(request: Request):
    _admin(request)
    return _store(request).health()


@router.post("/sync/v1/admin/pairing-codes")
def pairing_code(request: Request, body: dict[str, Any]):
    _admin(request)
    device_id = str(body.get("deviceId", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", device_id):
        raise HTTPException(400, "invalid deviceId")
    return {"code": _store(request).create_pairing_code(device_id), "expiresIn": 600}


@router.post("/pair")
def pair(request: Request, body: dict[str, Any]):
    # Pairing codes are one-time credentials, not bearer admin tokens.
    try:
        return _store(request).pair(str(body.get("code", "")))
    except Conflict as e:
        raise HTTPException(409, str(e))
    except PermissionError as e:
        raise HTTPException(401, str(e))


@router.delete("/device")
def unpair(request: Request):
    store = _store(request)
    try:
        device_id = _device(store, request.headers.get("authorization", "").removeprefix("Bearer "))
    except PermissionError:
        raise HTTPException(401, "invalid device token")
    store.unpair(request.headers.get("authorization", "").removeprefix("Bearer "))
    return {"revoked": device_id}


@router.get("/sync/v1/tasks")
def tasks(request: Request, since: int | None = None):
    _admin(request)
    return {"tasks": _store(request).tasks(since)}


@router.post("/sync/v1/tasks", status_code=201)
def create_task(request: Request, body: dict[str, Any], idempotency_key: str = Header(default="")):
    _admin(request)
    try:
        task = _store(request).create(body, idempotency_key)
    except Conflict as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if task["status"] == "pending" and task["target"] == "phone" and task.get("deviceId"):
        # Creation only queues. Dispatch is an explicit, idempotency-claimed action.
        pass
    return task


@router.post("/sync/v1/tasks/{task_id}/dispatch")
async def dispatch_task(request: Request, task_id: str):
    _admin(request)
    store = _store(request)
    task = store.get(task_id)
    if task["status"] != "pending" or task["target"] != "phone" or not task.get("deviceId"):
        raise HTTPException(409, "task is not dispatchable to a phone")
    claimed = store.event(task_id, {"deviceId": task["deviceId"], "idempotencyKey": f"gateway-claim:{task_id}:{task['version']}", "type": "claimed", "fromVersion": task["version"], "payload": {"status": "running"}})
    try:
        response = await request.app.state.relay_hub.request(task["deviceId"], "POST", "/api/v1/tasks", {"goal": task["goal"], **({"conversation": task["conversation"]} if task.get("conversation") else {})})
        result = json.loads(base64.b64decode(response.get("body", "")))
        if response.get("status") not in {200, 201}:
            raise RuntimeError(result.get("error", {}).get("message", "device task rejected"))
        store.event(task_id, {"deviceId": task["deviceId"], "idempotencyKey": f"device-started:{task_id}:{claimed['version']}", "type": "progress", "payload": {"progress": {"note": f"device task {result.get('task_id')}"}, "result": {"text": result.get("answer", "")} if result.get("status") == "done" else task.get("result")}})
        return {"accepted": True, "deviceTask": result}
    except Exception as e:
        store.event(task_id, {"deviceId": task["deviceId"], "idempotencyKey": f"device-failed:{task_id}:{claimed['version']}", "type": "status", "payload": {"status": "failed", "error": str(e)}})
        raise HTTPException(503, str(e))


@router.get("/sync/v1/tasks/{task_id}")
def task(request: Request, task_id: str):
    _admin(request)
    try:
        return _store(request).get(task_id)
    except NotFound:
        raise HTTPException(404, "not found")


@router.post("/sync/v1/tasks/{task_id}/events")
def event(request: Request, task_id: str, body: dict[str, Any]):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    if hmac.compare_digest(token, _store(request).admin_token or ""):
        pass
    else:
        try:
            device_id = _device(_store(request), token)
            if body.get("deviceId") != device_id:
                raise HTTPException(403, "deviceId does not match device token")
            if body.get("type") == "review_accept":
                raise HTTPException(403, "device tokens cannot accept reviews")
        except PermissionError:
            raise HTTPException(401, "unauthorized")
    try:
        return _store(request).event(task_id, body)
    except Conflict as e:
        raise HTTPException(409, str(e))
    except NotFound:
        raise HTTPException(404, "not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/sync/v1/devices")
def devices(request: Request):
    _admin(request)
    return {"devices": _store(request).devices()}


@router.get("/sync/v1/stream")
async def stream(request: Request, since: int = 0, replay_only: bool = False):
    """SSE event feed. replay_only closes after draining events since the cursor.
    Production consumers leave it False for a persistent stream with heartbeats."""
    _admin(request)
    store = _store(request)
    async def events():
        cursor = since
        while True:
            if await request.is_disconnected():
                return
            for event in store.events(cursor):
                cursor = event["seq"]
                yield f"id: {cursor}\nevent: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            if replay_only:
                return
            yield ": heartbeat\n\n"
            await asyncio.sleep(1)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


class RelayHub:
    """Tracks live devices and correlates request/response frames by request id."""
    def __init__(self):
        self.sockets: dict[str, WebSocket] = {}
        self.pending: dict[str, asyncio.Future] = {}
        self.seen: dict[str, set[str]] = {}

    async def request(self, device_id: str, method: str, path: str, body: dict | None = None, timeout: float = 55):
        ws = self.sockets.get(device_id)
        if ws is None:
            raise HTTPException(503, "device offline")
        request_id = secrets.token_urlsafe(16)[:22]
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        frame = {"type": "request", "id": request_id, "method": method, "path": path, "headers": {"content-type": "application/json", "accept": "application/json"}, "body": base64.b64encode(json.dumps(body or {}, ensure_ascii=False).encode()).decode(), "status": 0, "query": "", "client": ""}
        try:
            await ws.send_text(json.dumps(frame, ensure_ascii=False))
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            cancel = {**frame, "type": "cancel", "body": ""}
            await ws.send_text(json.dumps(cancel))
            raise HTTPException(504, "device request timed out")
        finally:
            self.pending.pop(request_id, None)


@router.websocket("/device")
async def device_socket(ws: WebSocket):
    hub: RelayHub = ws.app.state.relay_hub
    store: SyncStore = ws.app.state.sync_store
    if ws.headers.get("sec-websocket-protocol") != PROTOCOL:
        await ws.close(code=1008)
        return
    try:
        device_id = _device(store, ws.headers.get("authorization", "").removeprefix("Bearer "))
    except PermissionError:
        await ws.close(code=1008)
        return
    await ws.accept(subprotocol=PROTOCOL)
    hub.sockets[device_id] = ws
    hub.seen[device_id] = set()
    store.set_online(device_id, True)
    seen = hub.seen[device_id]
    jobs = set()
    try:
        while True:
            text = await ws.receive_text()
            if len(text.encode()) > MAX_FRAME:
                await ws.close(code=1008)
                return
            try:
                frame = json.loads(text)
                if frame.get("type") == "response":
                    future = hub.pending.get(frame["id"])
                    if future is not None and not future.done():
                        future.set_result(frame)
                    continue
                assert ID_RE.fullmatch(frame["id"])
                assert frame["type"] == "cancel" or frame["type"] == "request"
                if frame["type"] == "request":
                    assert frame["method"] in {"GET", "POST", "DELETE"}
                    assert frame["path"] == "/mcp" or frame["path"] == "/api/v1" or frame["path"].startswith("/api/v1/")
                    assert frame.get("status", 0) == 0
                    assert len(frame.get("query", "")) <= 8192 and not any(c in frame.get("query", "") for c in "#\r\n")
                    assert CLIENT_RE.fullmatch(frame.get("client", ""))
                    assert len(frame.get("headers", {})) <= 16
                    assert all(k in REQUEST_HEADERS and "\r" not in v and "\n" not in v for k, v in frame.get("headers", {}).items())
                    body = base64.b64decode(frame.get("body", ""), validate=True)
                    assert len(body) <= MAX_BODY
            except (AssertionError, KeyError, ValueError, TypeError):
                await ws.close(code=1008)
                return
            if frame["type"] == "cancel":
                continue
            if frame["id"] in seen:
                await ws.close(code=1008)
                return
            seen.add(frame["id"])
            if len(seen) > 4096:
                await ws.close(code=1001)
                return
            # The actual task dispatcher is registered by the host adapter. A
            # pending task stays queued while no device-side handler is attached.
            response = {"type": "response", "id": frame["id"], "status": 503, "headers": {"content-type": "application/json"}, "body": base64.b64encode(b'{"error":{"code":"unavailable","message":"no device handler registered"}}').decode(), "method": "", "path": "", "query": "", "client": ""}
            await ws.send_text(json.dumps(response, separators=(",", ":")))
    except WebSocketDisconnect:
        pass
    finally:
        if hub.sockets.get(device_id) is ws:
            hub.sockets.pop(device_id, None)
        store.set_online(device_id, False)


def create_app(db_path: str | None = None):
    app = FastAPI(title="tri-project sync gateway")
    app.state.sync_store = SyncStore(db_path or os.environ.get("SYNC_DB", "sync.db"))
    app.state.relay_hub = RelayHub()
    app.include_router(router)

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse({"error": {"code": "conflict", "message": str(exc)}}, status_code=409)
    return app


if __name__ == "__main__":
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="sync.db")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    uvicorn.run(create_app(args.db), host=args.host, port=args.port)
