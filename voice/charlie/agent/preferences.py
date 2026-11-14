"""用户偏好: 跨进程原子持久化"""
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

@contextmanager
def _locked_preferences(shared: bool = False):
    with open(PREFS_LOCK_FILE, "a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)

def _preferences_file_signature_now():
    try:
        st = os.stat(PREFS_FILE)
    except FileNotFoundError:
        return None
    return (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)

def _read_locked_preferences() -> dict:
    try:
        with open(PREFS_FILE, "r", encoding="utf-8") as f:
            prefs = json.load(f)
            return prefs if isinstance(prefs, dict) else {}
    except Exception:
        return {}

def _write_preferences_temp_locked(prefs: dict) -> str:
    directory = os.path.dirname(PREFS_FILE)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory,
        prefix=".preferences.", suffix=".tmp", delete=False,
    ) as temp_file:
        temp_path = temp_file.name
        json.dump(prefs, temp_file, ensure_ascii=False, indent=2)
        temp_file.flush()
        os.fsync(temp_file.fileno())
    return temp_path

def _write_locked_preferences(prefs: dict) -> None:
    temp_path = ""
    try:
        temp_path = _write_preferences_temp_locked(prefs)
        os.replace(temp_path, PREFS_FILE)
        temp_path = ""
    except Exception:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        raise

def _bump_preferences_revision() -> None:
    global _preferences_revision
    # 计数器被置成非 int 时不能崩。测试 fixture 会把模块级标量存下来再置 None
    # 做隔离（tests/test_fr14_batch5_role_identity.py），热重载也可能留下半初始化
    # 状态。这里只影响 ETag，让 `+=` 抛 TypeError 会把整条偏好写入路径带死，
    # 外部表现为「切换角色失败」「非法音色覆盖」这类毫不相关的错误。
    if not isinstance(_preferences_revision, int):
        _preferences_revision = 0
    _preferences_revision += 1

def _load_preferences() -> None:
    global _preferences, _preferences_revision, _preferences_file_signature
    with _locked_preferences(shared=True):
        prefs = _read_locked_preferences()
        signature = _preferences_file_signature_now()
    with _prefs_lock:
        _preferences = prefs
        _preferences_file_signature = signature
        _bump_preferences_revision()

def _refresh_preferences_if_changed() -> bool:
    global _preferences, _preferences_revision, _preferences_file_signature
    with _prefs_lock:
        old_signature = _preferences_file_signature
    with _locked_preferences(shared=True):
        new_signature = _preferences_file_signature_now()
        if new_signature == old_signature:
            return False
        prefs = _read_locked_preferences()
    with _prefs_lock:
        if new_signature == _preferences_file_signature:
            return False
        _preferences = prefs
        _preferences_file_signature = new_signature
        _bump_preferences_revision()
    return True

def _save_preferences() -> None:
    global _preferences_save_seq, _preferences_file_signature
    with _prefs_lock:
        snapshot = dict(_preferences)
        save_seq = _preferences_save_seq + 1
        _preferences_save_seq = save_seq
    with _preferences_file_lock:
        with _locked_preferences(shared=False):
            if save_seq != _preferences_save_seq:
                return
            disk_prefs = _read_locked_preferences()
            merged = dict(disk_prefs)
            merged.update(snapshot)
            if save_seq != _preferences_save_seq:
                return
            temp_path = ""
            try:
                temp_path = _write_preferences_temp_locked(merged)
                if save_seq != _preferences_save_seq:
                    return
                os.replace(temp_path, PREFS_FILE)
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
            _preferences_file_signature = _preferences_file_signature_now()

def _commit_preferences(mutate: Callable[[dict], Any]) -> Any:
    global _preferences_file_signature
    with _preferences_file_lock:
        with _locked_preferences(shared=False):
            disk_prefs = _read_locked_preferences()
            with _prefs_lock:
                merged = dict(disk_prefs)
                merged.update(_preferences)
                result = mutate(merged)
                _preferences.clear()
                _preferences.update(merged)
                _bump_preferences_revision()
            try:
                _write_locked_preferences(merged)
            except (OSError, IOError) as e:
                log.warning(f"[prefs] 保存失败: {e}")
                return result
            _preferences_file_signature = _preferences_file_signature_now()
    # 失效 system_msg 缓存，确保下次看到最新偏好
    try:
        from agent.system_msg import invalidate_system_msg_cache
        invalidate_system_msg_cache()
    except Exception as e:
        log.debug(f"[agent.preferences] error at line 163: {e}")
        pass
    return result

def set_preference(key: str, value: str, uid: str | None = None) -> str:
    """写入偏好。

    `uid` 是签名兼容用的：`agent/user_profile.record_explicit` 一直按
    `set_preference("location", loc, uid)` 调用，而这里原先只收两个参数，
    于是每次「我住在X」都抛 TypeError 被调用方的 `except Exception` 吞掉 ——
    位置永远存不进去，且只留一句 debug。当前偏好是单文件单用户语义，
    uid 暂不参与分片；将来做隔离时在这里接上即可。
    """
    _commit_preferences(lambda prefs: prefs.__setitem__(key, value))
    log.info(f"[prefs] 设置偏好: {key}={value[:30]}")
    return f"已记住：{key}={value}"

def get_preference(key: str, uid: str | None = None) -> str:
    """读取偏好。`uid` 同 `set_preference`，仅作签名兼容。"""
    _refresh_preferences_if_changed()
    with _prefs_lock:
        return _preferences.get(key, "")

def preference_count() -> int:
    _refresh_preferences_if_changed()
    with _prefs_lock:
        return len(_preferences)

def list_preferences(uid: str | None = None) -> dict:
    """全部偏好快照。

    `uid` 是签名兼容用的：`_build_system_msg_dynamic` 一直按
    `list_preferences(uid)` 调用，而这里原先不收参数，于是每轮抛 TypeError 被
    外层 `except Exception` 吞掉 —— 用户偏好从来没进过 system msg。当前偏好
    仍是单文件单用户语义（`preferences.json`），uid 暂不参与分片；将来做按
    uid 隔离时在这里接上即可，调用方不用再改。
    """
    _refresh_preferences_if_changed()
    with _prefs_lock:
        return dict(_preferences)

def preferences_etag_token() -> str:
    _refresh_preferences_if_changed()
    with _prefs_lock:
        return f"preferences:{_preferences_revision}:{len(_preferences)}"

def preferences_snapshot() -> tuple[dict, str]:
    _refresh_preferences_if_changed()
    with _prefs_lock:
        return dict(_preferences), f"preferences:{_preferences_revision}:{len(_preferences)}"

def preferences_conditional(
    etag_matches: Callable[[str], bool],
    etag_for_token: Callable[[str], str],
) -> tuple[dict | None, str]:
    _refresh_preferences_if_changed()
    with _prefs_lock:
        token = f"preferences:{_preferences_revision}:{len(_preferences)}"
        if etag_matches(etag_for_token(token)):
            return None, token
        return dict(_preferences), token

def del_preference(key: str) -> str:
    def remove_key(prefs: dict) -> bool:
        if key not in prefs:
            return False
        del prefs[key]
        return True
    found = _commit_preferences(remove_key)
    if found:
        return f"已忘记：{key}"
    return f"未找到偏好：{key}"

_load_preferences()