"""飞书单一发送方开关（X4 收敛）。

FEISHU_SENDER 环境变量决定 charlie 是否直接向飞书发送/回复：
  - "allbot"（默认）：charlie 全部触达点只记录 deliveryRef，不发送。
  - "charlie"：恢复原有直接发送行为。

deliveryRef 记录到 <DATA_DIR>/delivery-refs.jsonl，一行一条 JSON：
  {"at": 毫秒时间戳, "touchpoint": 入口名, "ref": messageId 或 null, "note": 摘要}
"""
import json
import logging
import os
import threading
import time

log = logging.getLogger("magic")

_DATA_DIR = os.environ.get("ASSISTANT_KID_DATA_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REFS_FILE = os.path.join(_DATA_DIR, "delivery-refs.jsonl")
_refs_lock = threading.Lock()


def sender_mode() -> str:
    return (os.getenv("FEISHU_SENDER", "allbot") or "allbot").strip().lower()


def charlie_can_send() -> bool:
    """charlie 只有被显式指定为发送方时才直接发飞书。"""
    return sender_mode() == "charlie"


def record_delivery_ref(touchpoint: str, ref: str | None = None, note: str = "") -> None:
    """记录一次被抑制的发送（或收到的消息），供审计与幂等核对。失败不影响主流程。"""
    entry = {
        "at": int(time.time() * 1000),
        "touchpoint": touchpoint,
        "ref": ref or None,
        "note": note[:200],
        "sender": sender_mode(),
    }
    line = json.dumps(entry, ensure_ascii=False)
    try:
        with _refs_lock:
            with open(_REFS_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception as e:
        log.debug(f"[feishu-sender] 记录 deliveryRef 失败: {e}")
    log.info(f"[feishu-sender] sender={entry['sender']} 抑制 {touchpoint} 发送: {entry['note']}")
