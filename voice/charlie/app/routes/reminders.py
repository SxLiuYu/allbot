"""Reminder/notification/SSE/lan-info/OTA routes.

Extracted from voice_server.py.
"""
import os, sys, json, time, datetime, logging, asyncio

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.http_helpers import (
    json_response, file_not_modified_response, file_etag_token,
    sse_event, SSE_EVENT_HEARTBEAT_FRAME,
)
from app.state import (
    register_sse_client, unregister_sse_client, sse_client_count,
)
from app.notifications import drain_notifications, _get_lan_ip
from app.auth import _sanitize_text, AUTH_TOKEN
from app.config import http_port, https_port
from app.reminders import (
    REMINDERS_FILE, _load_reminders, append_reminder, complete_reminder,
)

log = logging.getLogger("magic")

router = APIRouter(tags=["reminders"])

MAX_TEXT_LENGTH = 500

class ReminderRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200)
    time: str = Field(default="")
    repeat: str = Field(default="")

@router.get("/api/reminders")
async def list_reminders(request: Request):
    cached = file_not_modified_response(request, REMINDERS_FILE, "reminders")
    if cached is not None:
        return cached
    reminders_token = file_etag_token(REMINDERS_FILE, "reminders")
    data = _load_reminders()
    reminders_token_after_load = file_etag_token(REMINDERS_FILE, "reminders")
    pending = [r for r in data if not r.get("done")]
    return json_response(
        request,
        {"total": len(data), "pending": len(pending), "reminders": data},
        etag_token=reminders_token if reminders_token == reminders_token_after_load else None,
    )

@router.post("/api/reminders")
async def add_reminder(req: ReminderRequest):
    from app.audit_log import audit_log
    text = _sanitize_text(req.text, 200)
    time_str = _sanitize_text(req.time, 50)
    repeat = _sanitize_text(req.repeat, 20) if req.repeat else ""
    due = None
    if time_str:
        from utils import parse_time_str
        due = parse_time_str(time_str)
    if repeat:
        item = append_reminder(text, time_str, due, repeat=repeat)
    else:
        item = append_reminder(text, time_str, due)
    rid = item["id"]
    when = f"，提醒时间{due.replace('T', ' ')}" if due else (f"（时间'{time_str}'未解析出时刻）" if time_str else "")
    repeat_desc = {"daily": "（每天重复）", "weekly": "（每周重复）", "weekdays": "（工作日重复）"}.get(repeat, "")
    audit_log("api:reminders", input_data=f"text={text} time={time_str} repeat={repeat}",
              output_data=f"id={rid}", action="add")
    return {"ok": True, "id": rid, "message": f"已添加提醒：{text}{when}{repeat_desc}"}

@router.delete("/api/reminders/{rid}")
async def delete_reminder(rid: int):
    from app.audit_log import audit_log
    if not complete_reminder(rid):
        audit_log("api:reminders", input_data=f"rid={rid}", success=False,
                  error="not_found", action="delete")
        raise HTTPException(404, "提醒不存在")
    audit_log("api:reminders", input_data=f"rid={rid}", output_data="completed", action="delete")
    return {"ok": True, "message": f"提醒{rid}已标记完成"}

@router.get("/api/notifications")
async def get_notifications():
    from app.audit_log import audit_log
    notifs = drain_notifications()
    audit_log("api:notifications", input_data="poll", output_data=f"{len(notifs)}items", action="poll")
    return {"count": len(notifs), "notifications": notifs}

@router.get("/api/events")
async def sse_events():
    """SSE实时通知流(Web客户端用EventSource连接, 免轮询)"""
    queue = asyncio.Queue()
    register_sse_client(queue)

    async def event_stream():
        try:
            yield sse_event({
                "type": "connect",
                "text": "已连接",
                "time": datetime.datetime.now().isoformat(),
            })
            while True:
                try:
                    event_frame = await asyncio.wait_for(queue.get(), timeout=30)
                    yield event_frame
                except asyncio.TimeoutError:
                    yield SSE_EVENT_HEARTBEAT_FRAME
        except asyncio.CancelledError:
            pass
        finally:
            unregister_sse_client(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"})

@router.get("/api/lan-info")
async def lan_info():
    lan_ip = _get_lan_ip() or "127.0.0.1"
    return {
        "http_url": f"http://{lan_ip}:{http_port()}",
        "https_url": f"https://{lan_ip}:{https_port()}",
        "lan_ip": lan_ip,
        "http_port": http_port(),
        "https_port": https_port(),
    }

def _ota_device_offer():
    """OTA 响应里的 `device` 段：把服务端设置下发给固件。

    背景：OTA 服务器地址原本编译进固件（CONFIG_OTA_URL），Mac 换 IP 后设备
    就找不到服务器。改成由设置中心下发后，服务器搬家可以在设备还连得上旧地址
    时提前改好。

    契约（tests/test_runtime_settings.py::TestOtaDeviceOffer 锁死）：
    - XIAOZHI_OTA_DEVICE_ENABLE != "1" 时整段不下发，返回 None；
    - 空串不下发：显式清空覆盖等价于「不干预」，下发空串会把设备导向空地址；
    - auto_listen 恒在图里（有默认值，不属于「不干预」语义）。
    """
    if os.getenv("XIAOZHI_OTA_DEVICE_ENABLE", "0") != "1":
        return None
    from app import runtime_settings
    offer = {"auto_listen": runtime_settings.get("device.auto_listen")}
    ota_url = runtime_settings.get("device.ota_url")
    if ota_url:
        offer["ota_url"] = ota_url
    return offer


@router.api_route("/xiaozhi/ota", methods=["GET", "POST"])
async def xiaozhi_ota(request: Request):
    """OTA config endpoint for xiaozhi firmware."""
    from app.audit_log import audit_log
    audit_log("api:xiaozhi_ota", input_data=request.method, action="ota_config")
    try:
        body = await request.body()
        if body:
            log.info("[xiaozhi] OTA device self-report: %s", body[:500].decode("utf-8", "replace"))
    except Exception as e:
        log.warning("[xiaozhi] OTA body read error: %s", e)
    host = request.url.hostname or ""
    client_ip = request.client.host if request.client else ""
    if client_ip and not client_ip.startswith("127."):
        host = _get_lan_ip() or "127.0.0.1"
    elif host in ("localhost", "127.0.0.1", "::1", ""):
        host = _get_lan_ip() or "127.0.0.1"
    ws_url = f"ws://{host}:{http_port()}/ws/xiaozhi"
    if AUTH_TOKEN:
        # OTA 端点公开可达，不返回真实 AUTH_TOKEN；设备连接 WS 时自行携带预置 token
        ws_url = f"{ws_url}?token=device"
    ota_response = {
        "websocket": {"url": ws_url, "version": 1},
        "server_time": {"timestamp": int(datetime.datetime.now().timestamp()), "timezone_offset": 480},
    }
    mqtt_broker = os.getenv("MQTT_BROKER", "")
    if mqtt_broker and os.getenv("MQTT_ENABLE_OTA", "0") == "1":
        mqtt_port = int(os.getenv("MQTT_PORT", "1883"))
        device_id = os.getenv("MQTT_DEVICE_ID", "esp32-default")
        ota_response["mqtt"] = {
            "endpoint": f"{mqtt_broker}:{mqtt_port}",
            "client_id": f"charlie-{device_id}",
            "publish_topic": f"charlie/esp32/{device_id}/up",
            "subscribe_topic": f"charlie/esp32/{device_id}/down",
            "keepalive": 60,
        }
        log.info(f"[xiaozhi] OTA 返回 MQTT 配置: {mqtt_broker}:{mqtt_port} (device={device_id})")
    # 设置中心下发的设备段（默认关闭；见 _ota_device_offer 的契约说明）
    device_offer = _ota_device_offer()
    if device_offer:
        ota_response["device"] = device_offer
    return JSONResponse(ota_response)


# OTA 地址必须是 http(s)：固件拿它去轮询，畸形值一旦落盘，设备下次激活
# 直接失败且报错难定位（没有 ssh 的话基本只能重烧）。
_URL_SCHEMES = ("http://", "https://")


def _validate_setting(key, value):
    """参数级校验；返回错误串或 None。`_coerce` 只管类型，这里管语义。"""
    if key == "device.ota_url":
        s = "" if value is None else str(value).strip()
        # 空串是合法操作：等价于「不干预设备已保存地址」
        if s and not s.lower().startswith(_URL_SCHEMES):
            return "OTA 服务器地址必须以 http:// 或 https:// 开头"
    return None


@router.get("/api/settings")
async def get_settings():
    """当前设置 + 非法覆盖的提示（站点页面渲染用）。"""
    from app import runtime_settings
    settings = {}
    for key in runtime_settings.schema():
        # 无覆盖时取参数表声明的默认值（env 惰性求值）
        settings[key] = runtime_settings.get(key, runtime_settings.default_for(key))
    return {"settings": settings, "overrides": runtime_settings.overrides()}


@router.post("/api/settings")
async def post_settings(payload: dict):
    """批量写入设置。全部合法才落盘，避免改一半留下不一致状态。

    返回 {"ok": bool, "errors": [..], "applied": {..}}：`ok` 为 False 时
    `errors` 给出每条被拒的原因，`applied` 为空（不做部分写入）。
    """
    from app import runtime_settings
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "errors": ["请求体必须是对象"]}, status_code=400)
    errors = []
    staged = {}
    for key, value in payload.items():
        if key not in runtime_settings.schema():
            errors.append(f"未知参数: {key}")
            continue
        bad = _validate_setting(key, value)
        if bad:
            errors.append(bad)
            continue
        ok, msg = runtime_settings.set_value(key, value)
        if not ok:
            errors.append(msg)
        else:
            staged[key] = runtime_settings.get(key, runtime_settings.default_for(key))
    if errors:
        # 回滚已写入的键，保证「要么全改、要么不改」
        for key in staged:
            runtime_settings.clear(key)
        return JSONResponse({"ok": False, "errors": errors, "applied": {}})
    return {"ok": True, "errors": [], "applied": staged}
