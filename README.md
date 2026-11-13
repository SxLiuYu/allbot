# AllBot 👾

> **你的 AI 助手会主动找你聊天，而不是干等着你提问。**

首个把"主动认知"做成系统级能力的开源 AI 伙伴 · 主动推送洞察 · 持续建模用户 · Agent 自主进化技能 · 同样的错误不犯第二次 · 可装进口袋在 Android 手机本地运行

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6.svg)](https://www.typescriptlang.org/)

**README** | [English](./README.en.md) | **简体中文**

## 一个仓库，三种形态

AllBot 是同一个智能体的三种落地方式，代码在同一个仓库里，各端独立可跑：

| 目录 | 是什么 | 技术栈 | 怎么跑 |
|---|---|---|---|
| **根目录** | 服务器端：主动认知、记忆、技能、飞书/微信接入 | Node.js ≥22 + TypeScript | `pnpm install && pnpm build`，见[快速开始](#-快速开始) |
| [`mobile/`](mobile/README.md) | 手机端（言出）：说一句话，它在后台屏幕上替你操作 App | Android 11+ / Kotlin | `cd mobile && ./gradlew :app:assembleDebug` |
| [`voice/`](voice/README.md) | 语音硬件端（Charlie）：ESP32 + 语音闭环，改造现有家电 | Python 3.12 + FastAPI | `cd voice/charlie && python voice_server.py` |

三端之间靠 HTTP 与 MCP 连接，不是三套独立产品：

```
     mobile/  手机上的手和眼          voice/  房间里的嘴和耳朵
        │                                 │
        │  任务下发 / 结果回传              │  语音单轮 / 设备事件
        └────────────┬────────────────────┘
                     v
             根目录  allbot   大脑、记忆、治理、主动推送
```

只想用其中一端也行。装了根目录的服务端，`mobile/` 和 `voice/` 都是可选的；只用 `mobile/` 的话，它就是一台能自己操作手机的助手。

### 三端怎么接起来

三端之间不是自动发现的，要手工配一次。**同步网关在 `voice/` 这一侧**（`voice/charlie/app/routes/sync.py`，协议 `mika-relay.v2`），allbot 和 mobile 都是它的客户端：

| 方向 | 谁在哪配 | 配什么 |
|---|---|---|
| allbot → voice | `allbot.json` 的 `tasks.sync` | 网关地址 + 设备令牌；`src/tasks/sync/adapter.ts` 负责把 OwnerTask 投影成同步任务 |
| mobile → allbot | App 的设置页 | 模型端点（OpenAI 兼容）即可；手机端本身不需要同步网关 |
| mobile → voice | App 的配对入口 | 目前**没有实现**，见下方「已知缺口」 |

先起 `voice/`（它会带上同步网关），再起 allbot 并填上面那张表里的地址。`tasks.sync` 不配时适配器整体短路，allbot 照常单机跑。

**已知缺口**（如实写，别当成能做）：

- `mobile/` 侧没有同步网关的配对入口。App 里 `RelayGateway.parse` 硬要求 https，也没有 SyncTaskClient 之类的映射代码。手机端现在只能当「独立的手机助手」用。
- `voice/firmware/` 只有 README，16MB 固件 bin 走 Release 分发，不在 git 里。
- 通话音频双向出声未验证，需要火山（Volcengine）凭证且必须真人听。

两个子目录都是上游项目的品牌改造版，**收录的是快照，不带上游 git 历史**，来源与逐项改动写在各自的 `VENDOR.md` 里：

- `mobile/` ← [wangzan101/Mika](https://github.com/wangzan101/Mika) @ `2dce3bb4`，Apache-2.0
- `voice/` ← [Charlie](https://github.com/SxLiuYu/charlie-voice-assistant) @ `710d2c4`，MIT（`voice/Baize/` 子树 Apache-2.0）

## 为什么是 AllBot

你用过的 AI 助手都一个模式：你问，它答。你不问，它就安静地待在那里。

AllBot 不一样。你在飞书里跟它聊了几次之后，它会开始**主动**给你发消息。不是广告，不是提醒喝水，而是你真正可能感兴趣的东西。

| 能力         | 普通 chatbot | 典型 memory agent (2026) | **AllBot**                                                         |
| ------------ | ------------ | ------------------------ | -------------------------------------------------------------------- |
| **交互方式** | 你问它才答   | 被动响应 + 长记忆        | **主动推送洞察** + 正常对话                                          |
| **用户建模** | 无状态       | 向量库 rerank            | **TypedInsight 6 类 + 类别衰减半衰期 + 兴趣生命周期**                |
| **时机感知** | 不管你在干嘛 | 无                       | **PRISM 成本敏感门控**(凌晨不打扰、信任低时克制)                     |
| **自我进化** | 无           | 无                       | **Agent 自主创建/删除技能**(LLM 质量门,0.7 分阈值)                  |
| **纠错学习** | 无           | 无                       | **双路径纠错记忆**(同样的错误不犯第二次)                             |
| **部署形态** | 云端 SaaS    | 云端 SaaS                | **云端 / 本地 / Android 手机本地运行**(Termux,完整 agent,非瘦客户端) |

> 渠道集成方面：只打包 **飞书 + 微信** 两个一等渠道（深度支持）。上游 OpenClaw 的 Telegram/Discord/Slack 等频道在 AllBot 中没有打包代码，文档仅作为上游参考归档在 `docs/archive/channels/`，详见 `docs/channels/index.md`。中英文 CLI / 向导 / 认知层 prompt 自动切换，40+ LLM 提供商可插拔。

## ✨ 核心特性

### 🔮 认知引擎 — 从被动回复到主动洞察

AllBot 不是一个被动响应的工具,而是一个**持续运行、对你建模、并在合适时机主动给你洞察**的认知实体。它的主动洞察流水线:

```mermaid
flowchart LR
    U[用户对话<br/>飞书/微信/WebUI] --> P[Persona 建模<br/>TypedInsight 6 类 + 兴趣生命周期]
    P --> S[Scheduler 事件<br/>timer / persona-change / info-scan]
    S --> G{PRISM 门控<br/>价值 vs 打扰成本}
    G -- 不通过 --> SKIP[静默 - 凌晨/信任低/频率过高]
    G -- 通过 --> SR[SIRI 循环]
    SR --> SE[Search<br/>跨域 / 深度 / 延伸]
    SE --> ID[Identify<br/>冷却 + bandit 选模式]
    ID --> RS[Resolve<br/>LLM 生成 → 自精炼 → judge 验证]
    RS --> DL[推送洞察<br/>飞书/微信/WebUI]
    DL --> F[用户隐式反馈<br/>回复长度 / 追问 / 敷衍]
    F -.更新偏好.-> P
```

五个核心机制:

- **Persona 画像** — 每次对话都在学习你。LLM 驱动的结构化提取,从对话中自动发现领域和兴趣。洞察按类别独立衰减(`tool_config` 7天 / `domain_knowledge` 30天 / `behavioral_pattern` 90天...),兴趣生命周期自动追踪(emergent→stable→declining→dormant→revived)。领域由 LLM 动态发现,不依赖硬编码关键词。
- **跨域洞察** — 你同时关注 A 和 B,它发现二者有潜在联系。你之前问过但没深入的问题,它从新角度跟进。你在某个领域钻得够深了,它推荐延伸方向。LLM 自我精炼(critique→rewrite,最多 3 轮)保证质量,语义去重确保每次推送都有新意。
- **时机门控** — 不是想发就发。PRISM 模型计算每条洞察的期望价值,只有预期收益超过打扰成本时才推送。凌晨不打扰,信任度低时克制,你最近活跃度低就先等等。每日自持上限(默认 2 条)+ 不固定间隔的随机投放节奏,像朋友分享而不是定时任务;不回复会自然收敛,你一开口立刻恢复。主动推送默认关闭,需要显式开启 `cognitive.proactive.enabled: true`。
- **信任演化** — 刚认识时谨慎试探,聊多了越来越懂你,最终变成可以大胆推荐的深度伙伴。SARA 框架驱动四个阶段的信任演化,信任等级决定系统被允许做什么。
- **偏好学习** — 你回复长了、追问了"为什么",它记下你喜欢这个话题。你敷衍了,它下次换一个方向。Thompson Sampling 驱动的偏好学习,隐式反馈比显式反馈更诚实。

洞察内容结合你的画像 + LLM 知识 + 实时网络搜索生成。配了搜索 API Key,洞察会紧跟时事。

**💡 真实洞察样例(运营者本人运行 AllBot 的实际飞书消息截图)**

以下两条是 AllBot 在长期运行中真实推送给运营者的飞书消息。**不是编造,不是 GPT 示例,是系统实际输出。**

<table>
<tr>
<td width="33%" valign="top">
<strong>样例 1:行为模式洞察</strong><br>
<sub>AllBot 注意到运营者反复把"风格判断"压在审稿环节,主动建议把判断前移到授权环节(2026-07-07 22:48 推送)</sub>
<br><br>
<img src="./screenshot/ins1.jpg" width="100%" alt="写作流程洞察 — AllBot 主动建议把审稿判断前移">
</td>
<td width="33%" valign="top">
<strong>样例 2:跨域连接</strong><br>
<sub>AllBot 把运营者之前"用 AI 辅助医疗就诊"的行为模式,迁移到"用 AI 辅助解读 Apple Watch 健身数据"上,建立两个领域之间的桥梁(2026-07-11 19:26 推送)</sub>
<br><br>
<img src="./screenshot/ins2.jpg" width="100%" alt="跨域连接 — AllBot 把医疗就诊的 AI 辅助模式映射到健身数据分析">
</td>
<td width="33%"></td>
</tr>
</table>

可以看到这些洞察的语气不是冷冰冰的"提醒"或"建议",而是**像一个朋友顺手分享一个想法**。这不是 prompt 硬塞的人格设定——是 Persona 画像里隐式偏好学习 + Thompson Sampling 调出来的对话风格。

### 🧬 自我进化 — Agent 自主判断何时学新技能

你跟 AllBot 连续做了几次复杂的飞书知识库整理操作——搜索会议记录、提取纪要、创建文档、设置任务。AllBot 发现这个流程重复且复杂，主动跟你说：

> "我注意到你最近几次都在做类似的会议纪要归档流程，我给自己写了个技能，以后你说'归档会议'我就自动执行整个流程。"

它怎么做到的：

- **Hard Trigger 检测** — 代码层做噪音过滤，检测到复杂任务后注入系统事件。
- **Agent 自主决策** — Agent 拥有完整对话上下文，自己判断是否值得做成技能。不值得就忽略。
- **质量门** — 草稿落盘前由 LLM 按 4 个维度评分取均值，低于 0.7 分最多 refine 2 次，仍未通过则拒绝。
- **完整生命周期** — 创建前去重检查、创建后跟踪使用频率、长期不用自动清理。

**🧬 真实样例 — Agent 自主决策的两种相反结果**

下面两条是运营者真实运行时 Agent 的两种相反决策。大多数"自进化 agent"会无差别地为每个复杂任务创建技能,AllBot 的 Agent 会自己判断"这事该不该固化成流程";决定创建后,草稿还要通过 0.7 分阈值的 LLM 质量门。

<table>
<tr>
<td width="33%" valign="top">
<strong>决策 1:Agent 决定创建技能</strong><br>
<sub>运营者处理了一批 Obsidian 哲学概念笔记的交叉引用,Agent 评估后认为这个模式会反复出现,主动创建了 <code>knowledge-graph-structuring</code> 技能,并解释了用途和删除方式</sub>
<br><br>
<img src="./screenshot/evo1.jpg" width="100%" alt="Agent 决定创建 knowledge-graph-structuring 技能">
</td>
<td width="33%" valign="top">
<strong>决策 2:Agent 决定不创建技能</strong><br>
<sub>运营者让 Agent 通读书稿给结构化批评,Hard Trigger 同样触发了进化信号,但 Agent 自己判断"这本质是编辑工作,核心能力是阅读+判断,不是流程,硬封装反而限制灵活度",<strong>主动拒绝</strong>了技能创建</sub>
<br><br>
<img src="./screenshot/evo2.jpg" width="100%" alt="Agent 主动拒绝创建技能 — 因为是编辑工作,不该固化">
</td>
<td width="33%"></td>
</tr>
</table>

注意 evo2 这条 —— Agent 给出的拒绝理由是有内容的(初稿看骨架、二稿看节奏、终稿看字句),不是模板化的"我无法处理"。这种"自己说不"的能力来自 Agent 的全权判断;而它决定"说 yes"之后,质量门仍会独立把关。

### 🔄 纠错自进化 — 同样的错误不犯第二次

AI 助手每次新建会话都犯同样的错？AllBot 不会。它有一套纠错记忆系统，保证同样的错误只犯一次。

- **双路径检测** — Agent 自报错误，或会话结束时系统自动从对话中提取纠错记录。
- **去重 + 强化** — 重复的错误不会新建记录，而是增加权重，确保高频问题优先被看到。
- **系统提示注入** — 纠错记录注入到 Agent 每一轮都能看到的系统提示中，而不是放在可能不被读取的文件里。

同样的坑，踩过一次就够了。

### 🔌 可插拔架构

不绑死任何一家。国内国际随意切换，`allbot onboard` 向导自动发现已配置的 API Key。

| 国内                                              | 国际主流                                        | 聚合 / 自部署                                      |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| DeepSeek · 通义千问 · Kimi · MiniMax · 智谱 GLM … | Claude · Gemini · Grok · Mistral · Perplexity … | OpenRouter · Together · Ollama · LMStudio · vLLM … |

切换模型只需一行：

```bash
allbot config set agent.model "deepseek/deepseek-chat"
allbot config set agent.model "anthropic/claude-sonnet-4-20250514"
```

### 🌐 中英自动切换

CLI 界面、配置向导、认知层 prompt 全部根据系统语言自动切换：

- **CLI** — 检测 `LANG` / `LC_ALL` 环境变量，banner、帮助文本、命令描述、向导对话自动中英文
- **认知层** — 根据 Persona 中的 `preferredLanguage`，洞察生成 prompt、纠错注入、进化信号全部 locale 感知
- **文档** — 13 种语言的自动翻译流水线（zh / ja / ko / es / pt-BR / de / fr / ar / it / tr / uk / id / pl）

```bash
export LANG=zh_CN.UTF-8   # 中文
export LANG=en_US.UTF-8   # English
# 或显式指定：
export ALLBOT_CLI_LOCALE=zh-CN
```

### 🛠️ 完整智能体

**Agent 循环**：推理 → 调用工具 → 观察 → 继续推理，支持流式输出、上下文压缩、子智能体并行派生。内置代码执行、网页抓取、PDF 操作、图片/视频/音乐生成、TTS 语音合成、Canvas 画布等工具。

**记忆系统**：多存储后端，语义搜索历史对话。会话记忆、每日整合、手动整理三个系统协同维护 Agent 上下文。

- **会话记忆** — 每次对话结束自动生成结构化摘要（决策、待办、话题），按日期归档到 `memory/YYYY-MM-DD.md`，按话题拆分到独立主题文件。8KB 预算自动平衡，高频内容内联，低频内容存指针。
- **每日整合** — 定时扫描历史会话，LLM 提取结构化知识（领域知识、行为模式、偏好、目标），Jaccard 去重后写入 Persona 画像、Fragment 片段库和纠错存储。你的认知模型每天都在进化。
- **智能检索** — 双引擎架构：FTS 全文搜索 + sqlite-vec 向量语义搜索（配 embedding provider 后启用）。混合检索自动平衡关键词匹配和语义相关性。
- **手动整理** — 内置 `memory-organize` 技能，四步流程：垃圾回收（清理过期内容）→ 深度扫描（发现遗漏）→ 整理去重（跨文件消重）→ 预算检查（保持精简）。

**技能市场**：数十个内置技能（github、weather、summarize、coding-agent、notion、obsidian、taskflow 等），更多从 ClawHub 安装：

```bash
allbot skills install <skill-name>
```

### 📱 Android 手机本地运行 — 把 AI 伙伴装进口袋

大多数 AI 助手要么是云端 SaaS(数据离开你的设备),要么是需要服务器的自部署项目。**AllBot 可以直接装进 Android 手机,完整 agent 在本地运行**——不是连回你服务器的瘦客户端,是手机本身就是 agent。

**只需要下载一个 APK,不需要电脑、不需要命令行、不需要 GitHub 账号。** [AllBot Launcher APK](https://github.com/SxLiuYu/allbot/releases/tag/launcher)(约 41MB,内置 Termux)会引导你完成所有步骤。

**三步搞定:**

1. **下载 `allbot-launcher.apk`** —— 从 [GitHub Release](https://github.com/SxLiuYu/allbot/releases/tag/launcher) 下载到手机
2. **安装 APK**(允许"未知来源") —— 打开 Launcher,它会自动安装内置的 Termux
3. **点击「复制命令并打开 Termux」** —— 在 Termux 里长按粘贴、回车,AllBot 自动安装并启动

Launcher 主界面、控制面板、实际移动端对话三张截图并排:

<table>
<tr>
<td width="33%" valign="top">
<strong>Launcher 主界面</strong><br>
<sub>打开 APK 后看到的第一个画面,展示 AllBot 品牌 + 一键安装 Termux 的引导按钮</sub>
<br><br>
<img src="./screenshot/Android1.jpg" width="100%" alt="AllBot Launcher APK 主界面">
</td>
<td width="33%" valign="top">
<strong>控制面板(认知系统全貌)</strong><br>
<sub>启动后 AllBot Control 在手机浏览器里跑起来。左侧导航的每一项都是真实的认知子系统 UI 入口:<strong>聊天 / 代理 / 认知 / 洞察 / 进化 / 纠错 / 技能 / 使用情况 / 历史 / 定时任务 / 设置</strong>。右侧显示当前洞察的来源(<code>Source: Web Search --- LEDGER: Scaling Agentic Document Editing...</code>),证明 knowledge mode 的网络搜索是真实在工作</sub>
<br><br>
<img src="./screenshot/Android3.jpg" width="100%" alt="AllBot Control 移动端 — 认知系统全功能 sidebar 可见">
</td>
<td width="33%" valign="top">
<strong>实际移动端对话</strong><br>
<sub>AllBot 在手机端给你写的实质内容(把 Git commit 类比为依赖图,讨论 Agent 如何辅助哲学写作的一致性检查)。不是 toy demo,是真实运行时产生的深度内容</sub>
<br><br>
<img src="./screenshot/Android2.jpg" width="100%" alt="移动端实际对话 — 哲学写作 + Agent 协作">
</td>
</tr>
</table>

**为什么这件事值得做:**

- **数据不出手机** — 对话历史、Persona 画像、纠错记忆、技能全部存在手机本地。没有第三方服务器中转。
- **离线可用** — 只要 LLM provider 能访问(本机 Ollama / 局域网 vLLM 完全离线),你就有一个随身 AI 伙伴。配云端 LLM 也可,流量走你自己的 API Key。
- **主动洞察走系统通知** — PRISM 门控 + Android 通知,AllBot 在你通勤、午休时主动给你发洞察,和你日常用飞书/微信的体验一致。

**📱 完整运行流程(26 秒加速回放)**

从手机桌面启动 AllBot → 打开控制面板 → 对话响应(视频已加速,便于快速预览,实际耗时更长):

<a href="./screenshot/Android5.mp4?raw=true" target="_blank" title="点击在新页面播放 26 秒加速回放">
  <img src="./screenshot/Android5-poster.jpg" width="32%" alt="Android 启动到对话响应 - 点击播放加速回放">
</a>

**[▶ 播放加速回放](./screenshot/Android5.mp4?raw=true)**(MP4,4MB,点击在新页面播放)

**已有 Termux 的技术用户** 可以跳过 Launcher APK,直接跑:

```bash
curl -fsSL https://github.com/SxLiuYu/allbot/raw/main/scripts/install-termux.sh | bash
```

> 想了解 Launcher APK 的工作原理、保活配置、Termux 兼容性工程问题?详见 [`android/README.md`](./android/README.md) 和 [Termux 部署指南](./docs/platforms/termux.md)。

## 🚀 快速开始

### 准备工作

开始前你需要准备：

| 条件            | 说明                     | 获取方式                                                                                                                                                                                                                                  |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM API Key** | 至少一个 AI 提供商的密钥 | [DeepSeek](https://platform.deepseek.com/) · [Claude](https://console.anthropic.com/) · [Gemini](https://aistudio.google.com/apikey) · [通义千问](https://dashscope.console.aliyun.com/) · [Kimi](https://platform.moonshot.cn/) 任选其一 |
| **消息渠道**    | 用于收发消息             | [飞书](https://open.feishu.cn/)（推荐，向导支持扫码自动创建）· [微信](./docs/channels/wechat.md)（一等渠道，运行 `allbot channels login --channel wechat` 接入）· 上游频道（Telegram/Discord/Slack 等）没有打包代码，仅保留文档参考  |

### 安装（推荐方式）

**macOS / Linux** — 一条命令搞定：

```bash
curl -fsSL https://github.com/SxLiuYu/allbot/raw/main/scripts/install.sh | bash
```

脚本会自动：检测系统 → 安装 Node.js（如未安装）→ 安装 AllBot → 启动配置向导。

**Windows** — PowerShell：

```powershell
iwr -useb https://github.com/SxLiuYu/allbot/raw/main/scripts/install.ps1 | iex
```

安装完成后，向导会引导你配置 LLM 提供商、飞书机器人、网关等。飞书机器人支持**扫码自动创建**（10 秒搞定，无需手动在开放平台操作）。

### 启动

```bash
allbot gateway --port 18789 --verbose
```

启动后在飞书里找到你的机器人，发一条消息。AllBot 自动开始构建你的认知画像。

主动洞察和任务系统默认关闭，需要时在 `~/.allbot/allbot.json` 里显式开启：

```json
{
  "cognitive": {
    "proactive": { "enabled": true },
    "tasks": { "enabled": true }
  }
}
```

开启后，几轮对话它会主动推送第一条洞察。

<details>
<summary><b>📦 其他安装方式</b></summary>

#### Android 手机

直接下载 [AllBot Launcher APK](https://github.com/SxLiuYu/allbot/releases/tag/launcher),三步搞定 —— 详见上文 [📱 Android 手机本地运行](#-android-手机本地运行--把-ai-伙伴装进口袋) 章节。

#### npm 全局安装（已有 Node.js 22+ 环境）

```bash
npm install -g allbot
allbot onboard   # 交互式向导，自动配置
```

> ⚠️ **包名不是这个项目**：npm 上的 [`allbot`](https://www.npmjs.com/package/allbot)
> 是 2015 年的另一个 chatbot 框架（`bot-lab/allbot`，0.1.70）。本项目尚未发布到 npm，
> 上面那条命令装的是别人的包。**目前请用下面的从源码安装。**

从源码装（当前唯一受支持的方式）：

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
pnpm install
pnpm build
node allbot.mjs onboard
```

装好后 `node allbot.mjs` 就是 `allbot` 命令；想全局调用可以 `npm link` 或加 alias。

#### Docker 部署

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
bash scripts/docker/setup.sh   # 一键部署脚本（推荐）
```

或手动构建：

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
docker build -t allbot:local .
docker compose up -d
```

#### 中文一键部署脚本（从源码运行）

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
bash setup-cn.sh
```

#### 从源码构建

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
pnpm install --registry https://registry.npmmirror.com  # 国内镜像加速
pnpm build
allbot onboard   # 交互式向导
# 从 OpenClaw 迁移？运行：allbot migrate
```

</details>

### 配置

**必需**：至少一个 LLM 提供商的 API Key + 至少一个消息渠道凭证。

```bash
# LLM API Key — 任选一个提供商，取消对应行的注释
# export DEEPSEEK_API_KEY="your-key"         # DeepSeek
# export ANTHROPIC_API_KEY="your-key"        # Claude
# export GOOGLE_API_KEY="your-key"           # Gemini
# export ZAI_API_KEY="your-key"              # 智谱 GLM

# 飞书频道（也可在向导中扫码自动配置）
allbot config set channels.feishu.appId "your-app-id"
allbot config set channels.feishu.appSecret "your-app-secret"
```

**可选**：网络搜索增强洞察时效性。

```bash
export EXA_API_KEY="your-key"
export TAVILY_API_KEY="your-key"
```

配置文件位于 `~/.allbot/allbot.json`，支持热重载。认知层总开关 `cognitive.enabled` 默认开启；其中主动推送 `cognitive.proactive.enabled` 和任务系统 `cognitive.tasks.enabled` 默认关闭，需要显式设为 `true`。设为 `cognitive.enabled: false` 会关闭整个认知层。详细配置参考 `AGENTS.md`。

## 与 OpenClaw 的关系

AllBot 最初 fork 自 [OpenClaw](https://github.com/openclaw/openclaw) 的 Gateway 架构和 Plugin SDK 边界,在此之上构建了独立的认知层(主动洞察、自我进化、纠错记忆)和重写的记忆整合系统。OpenClaw 提供的地基(Gateway、Agent 循环、工具生态)让我们能专注于差异化部分。

基座层面的工程改造(TypeBox 类型迁移、pi-ai SDK 升级、1220 处 lint 修复、Windows/Android bug 修复、Plugin SDK 补完)对使用者基本不可见,详见 commit 历史。

v2026.7.19 起，AllBot 在基座之上加固了多项安全机制，这些是 AllBot 独有、不向上游贡献的差异化：

- **配置覆盖保护**：gateway 拒绝静默写入会让 allbot.json 缩水 50% 的 stub 写入（防止 env-var 拼写错误吞掉真实 operator 配置）
- **认知层并发安全**：persona / correction / fragment 三个 store 全部加 per-user 文件锁，5 个并发 writer 不再互踩
- **Prompt injection 防御**：web search 结果用 `<untrusted_source>` 包装 + 后过滤拒绝指令性洞察；correction 记录字段做注入短语过滤 + 长度上限
- **工具 schema LLM 友好化**：所有 17 处 `Type.Union` 改为 `stringEnum` + flat Object，国内中小模型（Qwen / Kimi / MiniMax）调用工具的成功率显著提升
- **供应链卫生**：`pnpm.overrides` 强制升级 7 个高危依赖；high CVE 从 27 降到 3（剩余 3 个为深层 transitive，不可达 chat-input）

> 想要精简的体验?配置里设 `cognitive.enabled: false` 即可关闭整个认知层,回到「加固基座 + 重写记忆层」的状态。

## 致谢

AllBot 站在 [OpenClaw](https://github.com/openclaw/openclaw)(由 Peter Steinberger 和社区构建)的肩膀上。

### 学术研究

认知系统的设计借鉴了以下研究：

**基础理论**

- Green, D. M., & Swets, J. A. (1966). _Signal detection theory and psychophysics_. Wiley.
- Thompson, W. R. (1933). On the likelihood that one unknown probability exceeds another in view of the evidence of two samples. _Biometrika_, 25(3/4), 285–294.
- Altman, I., & Taylor, D. A. (1973). _Social penetration: The development of interpersonal relationships_. Holt, Rinehart & Winston.
- Gentner, D. (1983). Structure-mapping: A theoretical framework for analogy. _Cognitive Science_, 7(2), 155–170.

**人机关系与推荐系统**

- Bickmore, T. W., & Picard, R. W. (2005). Establishing and maintaining long-term human-computer relationships. _ACM Transactions on Computer-Human Interaction_, 12(2), 293–327.
- Kotkov, D., Wang, S., & Veijalainen, J. (2016). A survey of serendipity in recommender systems. _Knowledge-Based Systems_, 111, 180–192.

**LLM 画像与记忆**

- DEEPER: Directed Persona Refinement. (2025). _Proceedings of ACL 2025_. 32.2% error reduction via active contradiction resolution in persona maintenance.
- PERSONAMEM: Persona-Aware Memory in LLMs. (2025). _Proceedings of COLM 2025_. Benchmark showing LLMs achieve ~50% accuracy on evolving profile tasks.
- DV365: Dynamic User Representations over 365 Days. (2025). _Proceedings of KDD 2025_. Instagram's multi-slicing user embedding architecture.
- GemiRec: Gemini-Powered Recommendations. (2025). Xiaohongshu's multi-interest vector architecture with codebook quantization.
- PIE: Personalized Interest Exploration. (2023). _Proceedings of WWW 2023_. Personalized PageRank with bandit exploration.
- ProfiLLM: Fully Implicit User Profiling from Chatbot Interactions. (2025).

### 开源依赖

[飞书开放平台](https://open.feishu.cn/)、[Vitest](https://vitest.dev/)、[Playwright](https://playwright.dev/)、[tsdown](https://github.com/nicepkg/tsdown)、[Zod](https://zod.dev/)。

## 开发

三个子项目的工具链各自独立，互不干扰：

```bash
# 根目录（服务器端）
pnpm install
pnpm build              # 含 tsdown、插件 SDK、控制台 UI
pnpm test               # 全量单测
pnpm check              # 类型 + lint + 各类边界检查
node scripts/test-projects.mjs src/tasks/sync   # 只跑一个目录

# mobile/（手机端）
cd mobile
./gradlew :app:testDebugUnitTest     # JVM 单测
./gradlew :app:assembleDebug         # 出 APK
# 需要 local.properties 写 sdk.dir=<你的 Android SDK>

# voice/（语音端）
cd voice/charlie
pip install -r requirements-core.txt
python -m pytest tests/              # 60+ 用例
```

改完 `mobile/` 或 `voice/` 的**上游代码**时注意：这两个目录是上游快照，从上游拉更新会与品牌替换和地址改写冲突，每次都要手工合并，方式和冲突点写在 `mobile/VENDOR.md`、`voice/VENDOR.md`。

提交前请跑 `pnpm check`（服务器端）或对应子项目的测试。`AGENTS.md` 里有仓库级约定与验证协议。

## 参与

- **报问题**：[开 Issue](https://github.com/SxLiuYu/allbot/issues/new/choose)。附上版本（`node allbot.mjs --version` 或 App 的「关于」页）、操作系统、复现步骤。
- **提改动**：fork 后开 PR。三个子项目分开提，别混在一个 PR 里。
- **手机端的问题**：App 里「关于 › 反馈问题」能一键复制诊断信息，贴进 Issue 最省事。

## 许可证

| 范围 | 许可证 | 文件 |
|---|---|---|
| 根目录（allbot 服务器端） | MIT | [`LICENSE`](LICENSE) |
| `mobile/`（Mika / 言出） | Apache-2.0 | [`mobile/LICENSE`](mobile/LICENSE)、[`mobile/NOTICE`](mobile/NOTICE) |
| `voice/charlie/`（Charlie） | MIT | [`voice/charlie/LICENSE`](voice/charlie/LICENSE) |
| `voice/Baize/` | Apache-2.0 | [`voice/Baize/LICENSE`](voice/Baize/LICENSE) |

各自的署名与来源见 `mobile/VENDOR.md`、`voice/VENDOR.md`，以及根目录的 [`NOTICE`](NOTICE)。

如果你二次发行，三份许可证要一起带上，别只留根目录那份。
