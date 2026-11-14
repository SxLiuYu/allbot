# 设置中心与多 Key 轮询

这两块功能在代码里已经写完，但曾长期没有接线：`app/runtime_settings.py` 和
`agent/stepfun_keys.py` 都是完整模块，没有任何路由或调用点 import 它们。
2026-11-15 补齐接线，本文记录接线后的契约。

## 设置中心（`/api/settings`）

### 数据流

```
站点页面 → POST /api/settings → runtime_settings.json → OTA 响应的 device 段 → 固件 NVS → 生效
```

参数表在 `app/runtime_settings.py:_KEYS`，目前四项：

| key | 类型 | 默认 | 何时生效 |
|---|---|---|---|
| `device.auto_listen` | bool | `true` | 设备下次取 OTA 配置（需重启一次） |
| `device.ota_url` | str | `""` | 设备下次激活（重启设备即可） |
| `tts.voice` | str | `$TTS_VOICE` | 立即 |
| `tts.speed` | float | `$TTS_SPEED` | 立即 |
| `tts.priority` | list | `$TTS_PRIORITY` | 立即 |

覆盖值落在 `data/runtime_settings.json`。没有覆盖时取参数表声明的默认值，
所以改 `.env` 不用同步改代码。

### 接口

`GET /api/settings` 返回当前生效值与已覆盖项：

```json
{"settings": {"device.ota_url": "", ...}, "overrides": {}}
```

`POST /api/settings` 批量写入，**要么全改、要么不改**：

```bash
# 成功
curl -sX POST http://127.0.0.1:8000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"device.ota_url":"http://192.168.1.99:8000/xiaozhi/ota"}'
# {"ok":true,"errors":[],"applied":{"device.ota_url":"http://..."}}

# 非法 scheme：落盘前被拒，已有覆盖回滚
curl -sX POST http://127.0.0.1:8000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"device.ota_url":"ftp://host/ota"}'
# {"ok":false,"errors":["OTA 服务器地址必须以 http:// 或 https:// 开头"],"applied":{}}
```

`device.ota_url` 必须 `http://` 或 `https://` 开头。校验放在路由层而不是
`runtime_settings._coerce`：`_coerce` 只管类型，语义校验归调用方。畸形 URL
一旦落盘，设备下次激活会拿着它去轮询并直接失败，而且报错很难定位（设备上
没有 ssh，基本只能重烧）。

空串是合法操作，等价于「不干预设备已保存的地址」。

### OTA device 段

开关 `XIAOZHI_OTA_DEVICE_ENABLE`，默认 `0`（整段不下发）。

```bash
XIAOZHI_OTA_DEVICE_ENABLE=1
```

开启后 `/xiaozhi/ota` 响应多一段：

```json
{"device": {"auto_listen": true, "ota_url": "http://192.168.1.99:8000/xiaozhi/ota"}}
```

`ota_url` 只在非空时出现。下发空串会把设备导向空地址，所以显式清空（覆盖里
存 `""`）与「没配」在下发行为上一致：都不带这个键。

### 为什么这功能值得单独做

OTA 地址原本编译进固件（`CONFIG_OTA_URL`）。Mac 换 IP 之后设备就找不到服务器，
只能重烧。收进设置中心后，可以在设备还能连上旧地址时提前改好，下次激活即用。

前提是「设备还连得上旧地址」——服务器已经搬走的话设备拿不到新地址，这条绕不过去。

## StepFun 多 Key 轮询

### 为什么

StepFun 是 `TTS_PRIORITY` 默认链里的云端单点。实测单 key 有持续配额限制
（15 秒间隔照样 429）。`STEPFUN_KEY` 支持逗号分隔多把，全部 StepFun 调用
（TTS 批量/流式、ASR、LLM、realtime WS）共用一个本地路由器：

```bash
STEPFUN_KEY=sk-aaa,sk-bbb,sk-ccc   # 多把轮询
STEPFUN_KEY=sk-aaa                 # 单把，行为与老写法一致
```

分隔符接受 `,` 和 `;`，空项与重复项会被去掉并保序。

### 路由策略

实现在 `agent/stepfun_keys.py`：

- **轮询**：每次取 key 前进一格，把请求摊到所有 key 上，单 key 配额 × N
- **429 冷却**：撞 429 的 key 冷却 `STEPFUN_KEY_COOLDOWN` 秒（默认 60），
  轮询跳过它，配额窗口过了自动回归
- **401/403 隔离**：鉴权失败按 `STEPFUN_KEY_AUTH_COOLDOWN` 秒（默认 1800）
  隔离，key 欠费/被禁时快速滑过
- **全冷却兜底**：所有 key 都在冷却时，直接返回轮询指针当前那把 —— 不阻塞、
  不吞错，让上游 429/401 照常抛出，per-provider 熔断照常工作

线程安全：TTS 流式在 producer 线程、ASR race 在线程池、realtime 在 asyncio
executor，全部走同一把锁。

### 接线点

| 位置 | 用法 |
|---|---|
| `agent/asr_tts.py:_tts_stepfun` | `next_key()` 取 key；非 200 时 `mark_from_status(key, code)` |
| `app/llm_config.py:_get_provider_cfg` | `name == "stepfun"` 时走 `next_key()`，其他 provider 仍直读 env |
| `app/routes/manage.py:_verify_stepfun_key` | 只打第一把 key；把整串 `sk-a,sk-b` 当 Bearer 发出去必然 401 |

### 排查

```python
from agent import stepfun_keys
stepfun_keys.keys_status()
# [{'key_tail': 'sk-aaa'[-4:], 'cooling': False, 'cooldown_left_s': 0.0}, ...]
```

不回传 key 明文，只给尾 4 位。

## 跨设备同步（`SYNC_GATEWAY_ENABLED`）

默认关闭。开启后注册 `/api/sync` 路由，并用 `SYNC_DB` 指向独立的 SQLite 库：

```bash
SYNC_GATEWAY_ENABLED=1
SYNC_DB=./data/sync.db
```

`SYNC_DB` 缺失会在启动时 `KeyError`。与主库分开是为了让同步流量不污染会话数据。

## 测试覆盖

- `tests/test_runtime_settings.py`：schema 类型/默认值、POST 校验与拒绝、
  OTA device 段的四种组合（关、空、有值、显式清空）
- `tests/test_stepfun_keys.py`：解析（单把/多把/去空去重/缺失）、轮询顺序、
  429 冷却、401 隔离、全冷却兜底、TTS 打标、LLM 轮换、校验只取第一把
