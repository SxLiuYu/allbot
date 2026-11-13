# voice/ — 上游来源与改动记录

这个目录是 [Charlie 语音助手](https://github.com/SxLiuYu/charlie-voice-assistant) 的源码，随 AllBot 一起发行。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/SxLiuYu/charlie-voice-assistant |
| 上游提交 | `710d2c4bd2d4d015b0e7ee5af4038e89e4d25827`（2026-09-22，`chore: 提交承重模块使 main 自洽（FR-14 多用户分片 / 日志 / 追踪）`) |
| 许可证 | MIT（`voice/charlie/LICENSE` 待补，见下）；`Baize/` 子树是 Apache-2.0，见 `Baize/LICENSE` |
| 收录时间 | 2026-11-13 |
| 历史 | 上游提交**未带进本仓库** |

## 许可证现状（有坑，别忽略）

上游 README 一直写「MIT 开源」，但仓库里**只有 `Baize/LICENSE` 是 Apache-2.0**，`charlie/LICENSE` 这个文件在上游从未存在。本仓库按 README 的声明补了一份 MIT 许可证到 `voice/charlie/LICENSE`，并保留 `Baize/LICENSE` 不动。如果上游其实另有约定，以上游作者确认为准。

## 本仓库对上游做的改动

### 1. 仓库地址指向本仓库

- `README.md`、`CHANGELOG.md`、`charlie/README.md`、`docs/DEPLOYMENT.md` 里的 `SxLiuYu/charlie-voice-assistant` 改为 `SxLiuYu/allbot`（源码在 `voice/` 子树）
- 徽章改指本仓库 Releases

### 2. 同步网关（X1，上游没有）

等三个项目之间的任务同步通道，新增：

- `charlie/app/routes/sync.py` — `/sync/v1/*` 路由
- `charlie/app/sync_store.py` — 同步状态存储
- `charlie/tests/test_sync_gateway.py`、`test_state_sync.py`

修改：

- `charlie/agent/state_sync.py`
- `charlie/app/notifications.py`
- `charlie/app/routes/feishu.py`
- `charlie/feishu_ws.py`
- `charlie/personalized_push.py`
- `charlie/voice_server.py`

### 3. 飞书发送方收口（X4）

- 新增 `charlie/app/feishu_sender.py` 与 `charlie/tests/test_feishu_sender.py`
- 目的：飞书只留一个发送方，避免 allbot 和 charlie 各发一份

## 没带进来的东西

- `__pycache__/`、`.venv/`、本地 `*.local.txt`
- `.omc/`、`.claude/`（本地 AI 助手规则）
- 两个 git 子模块指针（`OOTB/charlie/skills/mimo-vision`、`src/skills/mimo-vision`）在上游没有 `.gitmodules`，无法还原，本仓库不收

## 怎么跑

```bash
cd voice/charlie
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-core.txt
cp .env.example .env             # 可选，Demo 模式直接可用
python voice_server.py           # http://localhost:8000
```

需要 ffmpeg（macOS `brew install ffmpeg`，Linux `apt install ffmpeg`，Windows `winget install ffmpeg`）。

## 怎么从上游拉更新

```bash
git remote add charlie https://github.com/SxLiuYu/charlie-voice-assistant.git
git fetch charlie
git diff 710d2c4 charlie/main -- charlie
```

同步网关那 9 个文件与上游会冲突，每次都要手工合并。
