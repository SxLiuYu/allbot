"""SQLite storage for the sync contract.

No MQTT, conversation history, screenshots, or credentials are stored here.
All state changes and event insertion happen in one IMMEDIATE transaction.
"""
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid

STATUSES = {"pending", "running", "waiting_input", "waiting_review", "done", "failed", "cancelled"}
TRANSITIONS = {
    "pending": {"running", "cancelled"},
    "running": {"waiting_input", "waiting_review", "done", "failed", "cancelled"},
    "waiting_input": {"running", "cancelled"},
    "waiting_review": {"running", "done", "cancelled"},
    "done": set(), "failed": set(), "cancelled": set(),
}
SENSITIVE = {"identity", "payment", "credentials"}


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


def now_ms() -> int:
    return int(time.time() * 1000)


class SyncStore:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript("""
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
          origin TEXT NOT NULL, target TEXT NOT NULL, owner_id TEXT NOT NULL,
          device_id TEXT, result TEXT, progress TEXT, sensitivity TEXT NOT NULL DEFAULT 'normal',
          version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          type TEXT NOT NULL, from_version INTEGER, to_version INTEGER,
          payload TEXT NOT NULL, at INTEGER NOT NULL,
          UNIQUE(device_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS idempotency(
          key TEXT PRIMARY KEY, response TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices(
          device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          online INTEGER NOT NULL DEFAULT 0, capabilities TEXT NOT NULL,
          last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pairing_codes(
          code_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consumed_pairing_codes(
          code_hash TEXT PRIMARY KEY
        );
        """)
        # Local development stays opt-in. Production must explicitly set a token.
        self.admin_token = os.environ.get("SYNC_ADMIN_TOKEN") or ("local-test-admin" if os.environ.get("SYNC_ALLOW_INSECURE_LOCAL") == "1" else None)

    def close(self):
        with self.lock:
            self.conn.close()

    @staticmethod
    def _row(row):
        return json.loads(row["payload"])

    def health(self):
        return {"ok": True, "protocol": "mika-relay.v2", "contract": 1}

    def create_pairing_code(self, device_id: str) -> str:
        code = secrets.token_urlsafe(24)
        with self.lock, self.conn:
            self.conn.execute("INSERT INTO pairing_codes VALUES(?,?,?)", (self._hash(code), device_id, now_ms() + 600_000))
        return code

    @staticmethod
    def _hash(value: str) -> str:
        import hashlib
        return hashlib.sha256(value.encode()).hexdigest()

    def pair(self, code: str):
        digest = self._hash(code)
        with self.lock, self.conn:
            row = self.conn.execute("SELECT * FROM pairing_codes WHERE code_hash=?", (digest,)).fetchone()
            if row is None:
                consumed = self.conn.execute("SELECT 1 FROM consumed_pairing_codes WHERE code_hash=?", (digest,)).fetchone()
                if consumed:
                    raise Conflict("pairing code already used")
                raise PermissionError("invalid pairing code")
            if row["expires_at"] < now_ms():
                self.conn.execute("DELETE FROM pairing_codes WHERE code_hash=?", (digest,))
                raise PermissionError("expired pairing code")
            token = secrets.token_urlsafe(32)
            assert len(token) == 43
            self.conn.execute("DELETE FROM pairing_codes WHERE code_hash=?", (digest,))
            self.conn.execute("INSERT OR IGNORE INTO consumed_pairing_codes VALUES(?)", (digest,))
            self.conn.execute("INSERT OR REPLACE INTO devices VALUES(?,?,0,?,?)", (row["device_id"], self._hash(token), '["tasks","task_steer","device_state"]', now_ms()))
            return {"deviceToken": token, "mcpUrl": "/mcp", "relayUrl": "/device", "deviceId": row["device_id"]}

    def unpair(self, token: str):
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM devices WHERE token_hash=?", (self._hash(token),))

    def set_online(self, device_id: str, online: bool):
        with self.lock, self.conn:
            self.conn.execute("UPDATE devices SET online=?,last_seen=? WHERE device_id=?", (int(online), now_ms(), device_id))

    def devices(self):
        with self.lock:
            return [{"deviceId": r["device_id"], "online": bool(r["online"]), "capabilities": json.loads(r["capabilities"]), "lastSeen": r["last_seen"]} for r in self.conn.execute("SELECT * FROM devices")]

    def tasks(self, since: int | None = None):
        with self.lock:
            rows = self.conn.execute("SELECT payload FROM tasks WHERE (? IS NULL OR updated_at>?) ORDER BY updated_at", (since, since))
            return [self._row(r) for r in rows]

    def get(self, task_id: str):
        with self.lock:
            row = self.conn.execute("SELECT payload FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise NotFound(task_id)
            return self._row(row)

    def create(self, data: dict, key: str):
        if not key or len(key) < 8:
            raise ValueError("Idempotency-Key must have at least 8 characters")
        with self.lock, self.conn:
            old = self.conn.execute("SELECT response FROM idempotency WHERE key=?", (key,)).fetchone()
            if old:
                return json.loads(old["response"])
            existing = self.conn.execute("SELECT payload FROM tasks WHERE id=?", (data.get("id"),)).fetchone()
            if existing:
                current = self._row(existing)
                if data.get("version", 0) < current["version"]:
                    raise Conflict("stale task version")
                merged = {**current, **data, "version": current["version"] + 1, "updatedAt": now_ms()}
                self._validate_transition(current, merged, data.get("actor", "worker:sync"))
            else:
                merged = {**data, "id": data.get("id") or "task_" + uuid.uuid4().hex, "version": 1, "createdAt": now_ms(), "updatedAt": now_ms(), "sensitivity": data.get("sensitivity", "normal")}
            self._validate(merged)
            self._save(merged)
            self.conn.execute("INSERT INTO idempotency VALUES(?,?)", (key, json.dumps(merged, ensure_ascii=False)))
            self._event(merged["id"], data.get("deviceId", "gateway"), key + ":event", "created" if existing is None else "status", None, merged["version"], {"status": merged["status"]}, now_ms())
            return merged

    def _save(self, task):
        self.conn.execute("INSERT OR REPLACE INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (task["id"], task["goal"], task["status"], task["origin"], task["target"], task["ownerId"], task.get("deviceId"), json.dumps(task.get("result"), ensure_ascii=False), json.dumps(task.get("progress"), ensure_ascii=False), task.get("sensitivity", "normal"), task["version"], task["createdAt"], task["updatedAt"], json.dumps(task, ensure_ascii=False)))

    @staticmethod
    def _validate(task):
        required = ["id", "goal", "status", "origin", "target", "ownerId", "version", "createdAt", "updatedAt"]
        if any(task.get(k) in (None, "") for k in required) or task["status"] not in STATUSES:
            raise ValueError("invalid task")
        if task["target"] not in {"auto", "phone", "cloud", "mac", "charlie"}:
            raise ValueError("invalid target")
        if len(task["goal"]) > 4000 or not task["goal"].strip():
            raise ValueError("invalid goal")

    @staticmethod
    def _validate_transition(current, new, actor):
        if new["status"] == current["status"]:
            return
        if new["status"] not in TRANSITIONS[current["status"]]:
            raise Conflict(f"illegal transition {current['status']} -> {new['status']}")
        if current["status"] == "running" and new["status"] == "done" and current.get("sensitivity") in SENSITIVE:
            raise Conflict("sensitive task requires review")
        if current["status"] == "waiting_review" and new["status"] == "done" and not actor.startswith("owner:"):
            raise Conflict("review acceptance requires human owner")

    def _event(self, task_id, device_id, key, typ, from_version, to_version, payload, at):
        self.conn.execute("INSERT INTO events(task_id,device_id,idempotency_key,type,from_version,to_version,payload,at) VALUES(?,?,?,?,?,?,?,?)", (task_id, device_id, key, typ, from_version, to_version, json.dumps(payload, ensure_ascii=False), at))

    def event(self, task_id, data):
        key = data.get("idempotencyKey", "")
        if len(key) < 8:
            raise ValueError("idempotencyKey must have at least 8 characters")
        with self.lock, self.conn:
            if self.conn.execute("SELECT 1 FROM events WHERE device_id=? AND idempotency_key=?", (data.get("deviceId"), key)).fetchone():
                return {"accepted": True, "deduplicated": True}
            task = self.get(task_id)
            if data.get("fromVersion") is not None and data["fromVersion"] != task["version"]:
                raise Conflict("task version changed")
            payload = data.get("payload", {})
            updated = {**task, **{k: v for k, v in payload.items() if k in {"status", "result", "progress", "error", "deviceId", "deliveryRef"}}, "version": task["version"] + 1, "updatedAt": now_ms()}
            self._validate_transition(task, updated, data.get("actor", "worker:sync"))
            self._validate(updated)
            self._save(updated)
            self._event(task_id, data.get("deviceId"), key, data.get("type", "status"), data.get("fromVersion"), updated["version"], payload, data.get("at", now_ms()))
            return {"accepted": True, "deduplicated": False, "version": updated["version"]}

    def events(self, since: int = 0):
        with self.lock:
            return [{"seq": r["seq"], "taskId": r["task_id"], "type": r["type"], "toVersion": r["to_version"], "payload": json.loads(r["payload"]), "at": r["at"]} for r in self.conn.execute("SELECT * FROM events WHERE seq>? ORDER BY seq", (since,))]
