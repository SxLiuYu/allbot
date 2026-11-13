"""Regression tests for bounded state-sync flush and stale MQTT rejection."""
import json
import sys
from types import SimpleNamespace

from agent import state_sync


def reset_state():
    state_sync._local_state.clear()
    state_sync._DIRTY.clear()
    state_sync._last_published_hash = None
    state_sync._source_version = 0
    state_sync._last_remote_version = 0
    timer = state_sync._flush_timer
    if timer is not None:
        timer.cancel()
    state_sync._flush_timer = None


def test_many_changes_share_one_timer_and_one_flush(monkeypatch):
    reset_state()
    monkeypatch.setattr(state_sync, "write_shared_state", lambda state: True)
    monkeypatch.setattr(state_sync, "_publish_mqtt", lambda state, version: None)
    timers = []

    class Timer:
        def __init__(self, delay, fn):
            self.delay, self.fn = delay, fn
            self.daemon = False
            timers.append(self)
        def start(self):
            pass
        def cancel(self):
            pass

    monkeypatch.setattr(state_sync.threading, "Timer", Timer)
    for i in range(20):
        state_sync.sync_state("preferences", {"index": i})
    assert len(timers) == 1
    assert state_sync._DIRTY.is_set()
    state_sync._delayed_flush()
    assert state_sync.get_synced_state("preferences") == {"index": 19}
    assert not state_sync._DIRTY.is_set()
    reset_state()


def test_unchanged_state_is_not_republished(monkeypatch):
    reset_state()
    monkeypatch.setattr(state_sync, "write_shared_state", lambda state: True)
    published = []
    monkeypatch.setattr(state_sync, "_publish_mqtt", lambda state, version: published.append(version))
    state_sync.sync_state("user_state", {"at_home": True}, immediate=True)
    state_sync._flush_sync()
    state_sync._flush_sync()
    assert published == [1]
    reset_state()


def test_mqtt_payload_carries_version_and_hash(monkeypatch):
    reset_state()
    monkeypatch.setattr(state_sync, "write_shared_state", lambda state: True)
    published = []
    client = SimpleNamespace(publish=lambda topic, payload, qos, retain: published.append(json.loads(payload)))
    sys.modules["app.mqtt_server"] = SimpleNamespace(get_mqtt_client=lambda: client, _MQTT_AVAILABLE=True)
    state_sync.sync_state("user_state", {"at_home": True}, immediate=True)
    assert published[0]["version"] == 1
    reset_state()


def test_windows_file_lock_compatibility(tmp_path, monkeypatch):
    reset_state()
    monkeypatch.setattr(state_sync, "DATA_DIR", str(tmp_path))
    assert state_sync.write_shared_state({"user_state": {"at_home": True}})
    assert state_sync.read_shared_state()["user_state"]["at_home"] is True
    reset_state()


def test_stale_mqtt_state_is_ignored(monkeypatch):
    reset_state()
    callbacks = {}
    client = SimpleNamespace(
        subscribe=lambda topic, qos: None,
        message_callback_add=lambda topic, fn: callbacks.update(callback=fn),
    )
    monkeypatch.setitem(sys.modules, "app.mqtt_server", SimpleNamespace(get_mqtt_client=lambda: client, _MQTT_AVAILABLE=True))
    applied = []
    monkeypatch.setattr(state_sync, "_apply_remote_state", applied.append)
    state_sync.setup_mqtt_listener()
    message = lambda version, home: SimpleNamespace(payload=json.dumps({"version": version, "state": {"user_state": {"at_home": home}}, "source": "other", "ts": 1}).encode())
    callbacks["callback"](client, None, message(2, True))
    callbacks["callback"](client, None, message(1, False))
    assert state_sync.get_synced_state("user_state") == {"at_home": True}
    assert len(applied) == 1
    reset_state()
