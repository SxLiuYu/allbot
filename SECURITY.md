# 安全策略

## 上报漏洞

**不要在公开 Issue 里写漏洞细节。**

用 GitHub 的私密漏洞上报：[Report a vulnerability](https://github.com/SxLiuYu/allbot/security/advisories/new)

上报时请尽量给出：

- 受影响的部分（根目录服务器端 / `mobile/` 手机端 / `voice/` 语音端）与版本
- 复现步骤或 PoC
- 影响范围（能读到什么、能控制什么、是否需要已认证）
- 你认为的严重程度

我们会在 7 天内确认收到，并在修复发布后致谢（除非你要求匿名）。

## 支持范围

| 部分                        | 版本         | 说明                                     |
| --------------------------- | ------------ | ---------------------------------------- |
| 根目录（AllBot 服务器端）   | 最新 release | MIT                                      |
| `mobile/`（言出）           | 最新 release | Apache-2.0，上游 Mika 的漏洞也请一并告知 |
| `voice/charlie/`（Charlie） | 最新 release | MIT                                      |
| `voice/Baize/`              | 最新 release | Apache-2.0，第三方子树                   |

更早的版本不承诺修复，但欢迎上报，我们会判断是否需要回补。

## 已知的设计取舍（不是漏洞）

这些是刻意的行为，上报前请先确认不是误解：

- `mobile/` 的应用可以操作手机上的其他 App（无障碍服务 + 虚拟屏）。这是产品功能，不是越权。
- `voice/` 的语音端不能批准危险动作。`/api/device/approvals/:id` 恒返回 403 并写审计。
- 默认所有主动推送、任务系统、技能自进化都是**关闭**的，要显式在配置里开启。
- `voice/firmware/` 不随 git 分发固件，固件走 Release。固件本身不含 WiFi 与服务器凭证（NVS 已擦除）。

## 部署侧建议

- 不要把 `.env` 或 `~/.allbot/allbot.json` 提交进任何仓库。
- 网关必须启用 token 或密码认证；公网暴露时套 HTTPS 反向代理。
- `mobile/` 的模型 API Key 用 Android Keystore 加密存储，不要试图用 adb 直接写配置文件。
- 从源码跑一直用 `pnpm install --frozen-lockfile`，避免锁文件漂移引入未审依赖。

## 依赖漏洞

Dependabot 的安全更新是开启的；常规版本升级由维护者用 pnpm 直接做（版本更新类 PR 已关闭，避免堆积）。
