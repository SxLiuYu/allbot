---
summary: "Enabling and tuning real proactive behaviour: the config that has to exist, and what each gate actually blocks"
read_when:
  - 主动消息一条都没收到，想知道是不是没打开
  - 想配 explicitTopics 关注某几个主题
  - 想调频率、活跃时段、疲劳刹车
title: "Proactive Outreach — Setup and Tuning"
---

# Proactive Outreach — Setup and Tuning

主动层默认**关闭**。这不是一个可以忽略的默认值：`cognitive` 段缺失时 `applyCognitiveDefaults`
会把 `proactive.enabled` 填成 `false`，整条链路（人格、洞察生成、投递）根本不会初始化。
症状是「一切正常但从不主动说话」，而且旧版本日志里没有任何提示。

v2026.11 起网关启动时会明确打印一行：

```
cognitive proactive layer disabled (cognitive.proactive.enabled is false)
```

看到这行就说明配置没开，而不是模型不出东西。

## 最小可用配置

```json
{
  "cognitive": {
    "proactive": {
      "enabled": true,
      "activeHours": { "start": "09:00", "end": "22:00", "timezone": "Asia/Shanghai" }
    },
    "insight": {
      "sources": {
        "explicitTopics": ["Rust", "LLM 推理优化"]
      }
    }
  }
}
```

三个字段的作用：

| 字段                             | 作用           | 不填的后果           |
| -------------------------------- | -------------- | -------------------- |
| `proactive.enabled`              | 总开关         | 整层不启动           |
| `activeHours`                    | 投递时间窗     | 半夜也会发           |
| `insight.sources.explicitTopics` | 显式关注的主题 | 只能靠聊天里推断兴趣 |

## 第一次对话由谁先开口

主动层有个循环依赖：调度器只遍历**已存在人格文件**的用户，而人格只在**用户先发消息**
时创建（`attempt.ts` 需要 `senderId`）。全新部署两者都没有，日志里就是
`timer tick {"userCount":0}`——能回话，永远开不了口。

v2026.11 加了一条独立的首次接触通道（`scheduler/first-contact.ts`），不依赖聊天历史：

- 从 session store 里找带 `lastChannel`/`lastTo` 绑定、但还没有人格的 peer，补种人格；
- 全新部署连绑定都没有时，用 `proactive.firstContactTo` 显式指定收件人；
- 等人格"出生"满 10 分钟（加按用户稳定散列的 0–50 分钟错峰）、且落在 `activeHours` 内，
  发一条自我介绍并问用户关心什么；
- 每个用户**只发一次**，用 `feedbackProfile.firstContactAt` 记在人格里，重启也不会重发；
- 违反静默账本、投递失败都不写这个标记，下一轮可以重试。

它不生成洞察、不走 PRISM 门槛，也不要求来源。理由很直接：对一个从没聊过的人，
agent 手上没有任何信息值得打断他，唯一诚实的动作是先问一句。

```json
{
  "cognitive": {
    "proactive": {
      "enabled": true,
      "firstContactTo": [{ "channel": "feishu", "to": "ou_你的open_id" }],
      "firstContactName": "刘工"
    }
  }
}
```

`to` 用飞书 open_id。如果用户在飞书里给机器人发过任何一句话，session 里就会留下
绑定，之后由补种路径接管，不需要 `firstContactTo`；那条消息本身也算一次对话，
首次接触会跳过，直接进冷启动通道。`firstContactTo` 只服务于「一次都还没聊过、
但希望机器人先打招呼」的场景。

| 字段                  | 作用                                          |
| --------------------- | --------------------------------------------- |
| `firstContactTo`      | 全新部署时问候谁，可多个                      |
| `firstContactName`    | 称呼，不填就不带称呼                          |
| `firstContactEnabled` | 设 `false` 关掉这条通道，其他主动能力不受影响 |

用户回一句之后，人格才真正带上 `totalExchanges`，冷启动通道、洞察和重新联系
就都接上了。日志用 `first contact sent` 和 `first contact skipped`（带原因）区分结果。

## 推送日志

每次主动推送的意图和结果都追加到 `~/.allbot/proactive-push-log/push-YYYY-MM-DD.jsonl`，
一行一条 JSON，`0600` 权限，按天分文件。**没发出去的也会记**，包括被门槛否决、
投递失败、找不到路由的情况，所以"为什么没发"和"重复发了几次"都能事后查。

| 字段                            | 含义                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `outcome`                       | `sent` / `queued` / `vetoed` / `failed` / `no_route`            |
| `kind`                          | `first_contact` 或 `insight`                                    |
| `reason`                        | 否决或失败的具体原因，如 `profile too new`、`absolute floor 1h` |
| `channel` / `to` / `sessionKey` | 实际投递目标                                                    |
| `messageId`                     | 渠道返回的消息 id，能确认真的送达                               |
| `tookMs`                        | 投递耗时                                                        |

快速查今天发了几次：

```bash
grep '"outcome":"sent"' ~/.allbot/proactive-push-log/push-$(date +%F).jsonl | wc -l
```

`firstContactAt` 存在人格文件里，是"这条问候已发过"的唯一凭据。网关的
`savePersona` 走字段级合并（`cognitive-persona-merge.ts`），新字段必须并入白名单，
否则写回时被丢弃，首次接触就会每个 tick 重发一次。

首次接触的投递还绕开了 `~/.allbot/delivery-queue`（`skipQueue: true`）。
那条队列是 write-ahead 的：进程被 `kill -9` 后残留条目会在下次启动由
`recoverPendingDeliveries` 补发，补发不经过调度器，也看不到 `firstContactAt`，
于是重启会多出一条问候。跳过队列后，崩溃最多让这次问候丢失（标记没写，
下一轮重试），不会重复投递。

## 搜索是硬前提，但不需要 key

洞察必须带来源才能投递（`resolve()` 里零来源直接丢弃）。来源只能来自 web search，
所以**搜索不可用时不会产生任何知识型洞察**。

仓库自带的两个扩展覆盖了这条链路，都不需要 API key：

| 扩展         | 契约                 | 作用                            | 装什么              |
| ------------ | -------------------- | ------------------------------- | ------------------- |
| `argo`       | `webSearchProviders` | 聚合 272 个来源的搜索           | `argo-search` 命令  |
| `lightpanda` | `webFetchProviders`  | 无头浏览器把页面渲染成 markdown | `lightpanda` 二进制 |

两个都是 `enabledByDefault: true`，装好命令就走自动探测，`tools.web.search.provider`
不用显式写。命令不在 `PATH` 上就补配置：

```json
{
  "plugins": {
    "entries": {
      "argo": {
        "config": {
          "webSearch": { "command": "/Users/you/.local/bin/argo-search", "timeoutMs": 45000 }
        }
      },
      "lightpanda": {
        "config": { "webFetch": { "command": "/Users/you/.local/bin/lightpanda", "waitMs": 2000 } }
      }
    }
  }
}
```

要用付费 provider（Exa、Brave 等）也可以，显式指定即可：

```json
{
  "tools": { "web": { "search": { "provider": "exa", "exa": { "apiKey": "exa-..." } } } }
}
```

搜索确实不可用时（没装命令、命令报错连续 3 次），v2026.11 会打一条：

```
cognitive insight: web search unavailable — insights cannot be source-grounded
```

并且暂停生成，避免每个事件都白花一次 LLM 调用。每 15 分钟会放行一次探测，
装上命令或补上凭证后无需重启即可自动恢复。

用 `allbot capability web providers --json` 确认哪个 provider 被选中、是否已配凭证；
`allbot capability web search --query "..."` 直接测一次真实检索。

## explicitTopics 的作用

`explicitTopics` 里声明的主题会：

1. 在人格加载时注入为 `source: "explicit"` 的兴趣域，curator 不会把它当作推断兴趣衰减掉；
2. 进入洞察生成 prompt 的兴趣列表；
3. **允许新闻摘要**——用户说"帮我盯着这个"，那"这个主题今天发生了什么"就是他要的东西。
   未被订阅的主题仍然会被 `isNewsSummary` 拒绝，避免把纯新闻播报当成洞察推送。

匹配不区分大小写，`"rust"` 与 `"Rust"` 视为同一个主题，不会重复建域。

## 冷启动：新用户为什么能收到了

旧逻辑有三个叠加的硬门槛，导致新用户数学上不可能收到任何主动消息：

- `computePAccept` 在信任分 0.1 时最高只有 `0.5*0.1 + 0.3*0.5 + 0.2*0.5 = 0.30`，
  而投递阈值是 `3/(7+3) = 0.3`，`pAct` 又经过几何平均进一步压低；
- "new" 生命周期的频率因子 2.0 作为除数，把 `pNeed` 压到 0.04 量级；
- `identify()` 用同样的 0.3 阈值筛机会，低信任用户的任何机会都过不去。

现在有一条独立的冷启动通道，条件全部满足才放行：

- 至少有过 1 次对话（0 次永远不联系）；
- 用户在最近 24 小时内活动过（人还在，不是半个月没影）；
- 信任分用随对话次数上升的先验（0.25 起，每次 +0.05）替代 0.1 地板。

**仍然生效的约束**：静默期（`suppressUntil`）、活跃时段、未响应账本上限（低信任 2 条）、
动态疲劳刹车、投递间隔的随机 hazard。也就是说冷启动只解决"够不着"，不放松"别烦人"。

沉寂后的重新联系（`scheduler/re-engagement.ts`）保持自己的更高门槛：双方沉默 10 天以上才触发，
且要求已有 5 次以上对话——沉默半个月后重新搭话，得有交情做基础。

## 频率由三层共同决定

实际投递节奏不是单一配置项的结果：

1. 动态疲劳刹车（7 日忽略率与连续无实质互动，无每日硬上限）；
2. 随机 hazard 间隔（从 1 小时地板线性爬升到目标间隔；目标间隔取学到的
   `optimalFrequencyHours`，用户回复过就用 F，没回复就用 2F）；
3. 每次的机会门槛（PRISM gate 的 `pAct > C_FA/(C_FN+C_FA)`）。

想更活跃，调 `costFalseNegative`（漏发的代价）比调 `minIntervalHours` 更有效——
后者只是地板。调高 `costFalseNegative` 会降低阈值，让更多机会过关。

## 可观测性

主动调度与真实送达都有对应的观测出口，便于在出问题时快速定位"是没生成、没投递，还是投递了但没被记录"。

### 调度健康探针

- `GET /health/cognitive`
  - 本地（或已鉴权）请求返回 `200` + 详情 `{ ok, stale, reasons, overdueMs, checkedAt, health }`；
    远程未鉴权只返回 `{ ok, stale }`，不泄露内部健康快照。
  - 调度器健康时返回 `200`；以下任一情况判 stale 并返回 `503`：
    启动宽限（15 分钟）过后仍未拿到实例、调度器 `running:false`、tick 卡在 `inFlight` 超过 15 分钟、
    `nextTickAt` 逾期超过 15 分钟、watchdog 心跳（`lastHeartbeatAt`）超过 15 分钟未更新、
    或 `running && !tickInFlight && !timerScheduled`。
- `GET /ready`
  - 当认知调度器被判 stale 时，`failing` 数组包含 `"cognitive-scheduler"`，
    因此整体 `ready:false`、返回 `503`。注意这是**非缓存**检查，每次探针都会重新计算，
    不会因 1 秒 readiness 缓存而漏判。
- `GET /api/status`
  - 新增 `cognitiveSchedulerHealth: { checkedAt, verdict, health }`。
    故障（provider 抛错或注册表无 provider）时降级为 `null`，不会让 `/api/status` 500。

### 普通洞察的真实送达证据（push log）

普通洞察（非首次接触）实时发送后，会在 proactive push log 中补写一条
`kind:"insight" && outcome:"sent"` 记录，作为"真正送达"的证据（首次接触已经有独立的 sent 路径）。

该记录额外携带：

- `sourceCount`：本次洞察引用的 web 搜索来源条数（`record.sources.length`）；
- `deliveryLatencyMs`：从 `generatedAt` 到 `deliveredAt` 的时延；
- `messageId`：渠道返回的消息 id（`record.deliveryMessageId`）；

写入在 `insightDeliveryOutcomeHandler` 中仅对**首次确认**（`record.deliveredAt` 此前为 undefined）进行，
且在 `at` 当天与当天的前一天做幂等去重——同一洞察不会被重复记录第二条 sent。
channel/to 优先从当天/前一天的同 `candidateId` 的 `queued` 记录补取，取不到再回退到
`resolveCognitiveDeliveryTarget` 解析。
