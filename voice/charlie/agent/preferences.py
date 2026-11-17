"""用户偏好: 跨进程原子持久化（FR-14: 按 uid 分片）。

分片规则（与 persona/history/memory_store/state_sync 一致）：
    `default` → 原文件名 `preferences.json`（老数据零迁移）
    其他 uid  → `preferences_{uid}.json`

身份解析统一走 `agent.user_context.resolve_user()`（显式 uid > ContextVar
绑定 > env 兜底）；数据层不传 session_id，因此看不到 session 注册表
（按会话解析是入口层 S4 的职责）。本模块不写 os.environ。

向后兼容：`PREFS_FILE` / `PREFS_LOCK_FILE` / `_preferences` / `_prefs_lock` /
`_preferences_revision` / `_preferences_save_seq` / `_preferences_file_signature`
等名字全部保留，且语义为「`default` 用户的视图」—— `voice_agent.py:80-86`
在 import 期直接快照了它们，`tests/conftest.py` 与多个测试也会 monkeypatch
`PREFS_FILE` / `PREFS_LOCK_FILE`，名字或语义一变就会连锁破坏。
"""
import os
import json
import tempfile
import threading
try:
    import fcntl
except ImportError:  # Windows 无 fcntl
    import fcntl_compat as fcntl
import logging
from contextlib import contextmanager
from typing import Callable, Any

log = logging.getLogger("magic")

DATA_DIR = os.environ.get("ASSISTANT_KID_DATA_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PREFS_FILE = os.path.join(DATA_DIR, "preferences.json")
PREFS_LOCK_FILE = PREFS_FILE + ".lock"
_preferences = {}
_prefs_lock = threading.RLock()
_preferences_revision = 0
_preferences_file_lock = threading.Lock()
_preferences_save_seq = 0
_preferences_file_signature = None

# ===== FR-14: 按 uid 分键的状态 =====
# `_uid_prefs` 等四个 dict 的键是 uid；`default` 的槽同时别名到上面的兼容名字，
# 让「老代码 / voice_agent 快照 / 测试 monkeypatch」看到的仍是同一个对象。
_uid_prefs: dict[str, dict] = {"default": _preferences}
_uid_signatures: dict[str, Any] = {"default": None}
_uid_revisions: dict[str, int] = {"default": 0}
_uid_save_seqs: dict[str, int] = {"default": 0}


def _resolve_uid(uid: str | None = None) -> str:
    """数据层身份唯一出口：显式 uid > ContextVar 绑定 > env 兜底。

    不传 session_id（数据层拿不到，也按 batch2 契约不该看到 session 注册表）。
    """
    if uid:
        return uid
    from agent.user_context import resolve_user, DEFAULT_USER
    return resolve_user() or DEFAULT_USER


def _prefs_file(uid: str | None = None) -> str:
    """偏好文件路径。`default` 必须仍然是 `PREFS_FILE` 这个原文件名。

    ⚠️ 必须由模块级 `PREFS_FILE` 派生，不能另算 `DATA_DIR/preferences.json`：
    `PREFS_FILE` 是运维与测试都在 monkeypatch 的**唯一事实来源**
    （tests/test_voice_agent.py:1308 只 patch 它、不 patch DATA_DIR），
    两条路径一旦分叉，"读到的文件"和"被 patch 的文件"就不是同一个了。
    """
    uid = _resolve_uid(uid)
    if uid == "default":
        return PREFS_FILE
    return os.path.join(os.path.dirname(PREFS_FILE) or ".", f"preferences_{uid}.json")


def _prefs_lock_file(uid: str | None = None) -> str:
    uid = _resolve_uid(uid)
    if uid == "default":
        return PREFS_LOCK_FILE
    return _prefs_file(uid) + ".lock"


def _slot(uid: str) -> dict:
    """取该 uid 的内存偏好槽；default 复用 `_preferences` 兼容对象。"""
    if uid == "default":
        return _preferences
    return _uid_prefs.setdefault(uid, {})


def _sig_slot(uid: str) -> Any:
    return _uid_signatures.get(uid)


def _set_sig(uid: str, value: Any) -> None:
    _uid_signatures[uid] = value
    if uid == "default":
        global _preferences_file_signature
        _preferences_file_signature = value


def _revision(uid: str) -> int:
    return _uid_revisions.get(uid, 0)


def _bump_revision(uid: str) -> None:
    val = _uid_revisions.get(uid, 0)
    if not isinstance(val, int):
        val = 0
    _uid_revisions[uid] = val + 1
    if uid == "default":
        global _preferences_revision
        _preferences_revision = _uid_revisions[uid]


def _save_seq(uid: str) -> int:
    return _uid_save_seqs.get(uid, 0)


def _bump_save_seq(uid: str) -> int:
    val = _uid_save_seqs.get(uid, 0) + 1
    _uid_save_seqs[uid] = val
    if uid == "default":
        global _preferences_save_seq
        _preferences_save_seq = val
    return val


@contextmanager
def _locked_preferences(uid: str | None = None, shared: bool = False):
    uid = _resolve_uid(uid)
    path = _prefs_lock_file(uid)
    with open(path, "a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def _preferences_file_signature_now(uid: str | None = None):
    try:
        st = os.stat(_prefs_file(uid))
    except FileNotFoundError:
        return None
    return (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)


def _read_locked_preferences(uid: str | None = None) -> dict:
    try:
        with open(_prefs_file(uid), "r", encoding="utf-8") as f:
            prefs = json.load(f)
            return prefs if isinstance(prefs, dict) else {}
    except Exception:
        return {}


def _write_preferences_temp_locked(prefs: dict, uid: str | None = None) -> str:
    path = _prefs_file(uid)
    directory = os.path.dirname(path)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory,
        prefix=".preferences.", suffix=".tmp", delete=False,
    ) as temp_file:
        temp_path = temp_file.name
        json.dump(prefs, temp_file, ensure_ascii=False, indent=2)
        temp_file.flush()
        os.fsync(temp_file.fileno())
    return temp_path


def _write_locked_preferences(prefs: dict, uid: str | None = None) -> None:
    temp_path = ""
    try:
        temp_path = _write_preferences_temp_locked(prefs, uid)
        os.replace(temp_path, _prefs_file(uid))
        temp_path = ""
    except Exception:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        raise


def _bump_preferences_revision() -> None:
    """兼容名：给 default 用户 bump revision（旧代码 / voice_agent 调用）。"""
    _bump_revision("default")


def _load_preferences(uid: str | None = None) -> None:
    uid = _resolve_uid(uid)
    with _locked_preferences(uid, shared=True):
        prefs = _read_locked_preferences(uid)
        signature = _preferences_file_signature_now(uid)
    with _prefs_lock:
        slot = _slot(uid)
        slot.clear()
        slot.update(prefs)
        _set_sig(uid, signature)
        _bump_revision(uid)


def _refresh_preferences_if_changed(uid: str | None = None) -> bool:
    uid = _resolve_uid(uid)
    with _prefs_lock:
        old_signature = _sig_slot(uid)
    with _locked_preferences(uid, shared=True):
        new_signature = _preferences_file_signature_now(uid)
        if new_signature == old_signature:
            return False
        prefs = _read_locked_preferences(uid)
    with _prefs_lock:
        if new_signature == _sig_slot(uid):
            return False
        slot = _slot(uid)
        slot.clear()
        slot.update(prefs)
        _set_sig(uid, new_signature)
        _bump_revision(uid)
    return True


def _save_preferences(uid: str | None = None) -> None:
    uid = _resolve_uid(uid)
    with _prefs_lock:
        snapshot = dict(_slot(uid))
        save_seq = _bump_save_seq(uid)
    with _preferences_file_lock:
        with _locked_preferences(uid, shared=False):
            if save_seq != _save_seq(uid):
                return
            disk_prefs = _read_locked_preferences(uid)
            merged = dict(disk_prefs)
            merged.update(snapshot)
            if save_seq != _save_seq(uid):
                return
            temp_path = ""
            try:
                temp_path = _write_preferences_temp_locked(merged, uid)
                if save_seq != _save_seq(uid):
                    return
                os.replace(temp_path, _prefs_file(uid))
                temp_path = ""
            except (OSError, IOError) as e:
                log.warning(f"[prefs] 保存失败: {e}")
                return
            finally:
                if temp_path:
                    try:
                        os.unlink(temp_path)
                    except OSError:
                        pass
            _set_sig(uid, _preferences_file_signature_now(uid))


def _commit_preferences(mutate: Callable[[dict], Any], uid: str | None = None) -> Any:
    uid = _resolve_uid(uid)
    with _preferences_file_lock:
        with _locked_preferences(uid, shared=False):
            disk_prefs = _read_locked_preferences(uid)
            with _prefs_lock:
                merged = dict(disk_prefs)
                merged.update(_slot(uid))
                result = mutate(merged)
                slot = _slot(uid)
                slot.clear()
                slot.update(merged)
                _bump_revision(uid)
            try:
                _write_locked_preferences(merged, uid)
            except (OSError, IOError) as e:
                log.warning(f"[prefs] 保存失败: {e}")
                return result
            _set_sig(uid, _preferences_file_signature_now(uid))
    # 失效 system_msg 缓存，确保下次看到最新偏好
    try:
        from agent.system_msg import invalidate_system_msg_cache
        invalidate_system_msg_cache()
    except Exception as e:
        log.debug(f"[agent.preferences] error at line: {e}")
        pass
    return result


def set_preference(key: str, value: str, uid: str | None = None) -> str:
    """写入偏好（按 uid 分片；uid 为空时按当前绑定用户解析）。"""
    _commit_preferences(lambda prefs: prefs.__setitem__(key, value), uid)
    log.info(f"[prefs] 设置偏好: {key}={value[:30]}")
    return f"已记住：{key}={value}"


def get_preference(key: str, uid: str | None = None) -> str:
    _refresh_preferences_if_changed(uid)
    with _prefs_lock:
        return _slot(_resolve_uid(uid)).get(key, "")


def preference_count(uid: str | None = None) -> int:
    _refresh_preferences_if_changed(uid)
    with _prefs_lock:
        return len(_slot(_resolve_uid(uid)))


def list_preferences(uid: str | None = None) -> dict:
    """全部偏好快照（按 uid 分片）。"""
    _refresh_preferences_if_changed(uid)
    with _prefs_lock:
        return dict(_slot(_resolve_uid(uid)))


def preferences_etag_token(uid: str | None = None) -> str:
    uid = _resolve_uid(uid)
    _refresh_preferences_if_changed(uid)
    with _prefs_lock:
        slot = _slot(uid)
        return f"preferences:{_revision(uid)}:{len(slot)}"


def preferences_snapshot(uid: str | None = None) -> tuple[dict, str]:
    uid = _resolve_uid(uid)
    _refresh_preferences_if_changed(uid)
    with _prefs_lock:
        slot = _slot(uid)
        return dict(slot), f"preferences:{_revision(uid)}:{len(slot)}"


def preferences_conditional(
    etag_matches: Callable[[str], bool],
    etag_for_token: Callable[[str], str],
    uid: str | None = None,
) -> tuple[dict | None, str]:
    uid = _resolve_uid(uid)
    _refresh_preferences_if_changed(uid)
    with _prefs_lock:
        slot = _slot(uid)
        token = f"preferences:{_revision(uid)}:{len(slot)}"
        if etag_matches(etag_for_token(token)):
            return None, token
        return dict(slot), token


def del_preference(key: str, uid: str | None = None) -> str:
    def remove_key(prefs: dict) -> bool:
        if key not in prefs:
            return False
        del prefs[key]
        return True
    found = _commit_preferences(remove_key, uid)
    if found:
        return f"已忘记：{key}"
    return f"未找到偏好：{key}"


_load_preferences()
