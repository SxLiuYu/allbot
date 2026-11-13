# 贡献指南

感谢你愿意参与 AllBot。这个仓库装的是同一个智能体的三种形态，各自动手前请先挑对目录。

| 目录      | 是什么                | 技术栈                   | 主要入口                     |
| --------- | --------------------- | ------------------------ | ---------------------------- |
| 根目录    | 服务器端              | Node.js ≥22 + TypeScript | `src/`、`extensions/`、`ui/` |
| `mobile/` | 手机端（言出）        | Android / Kotlin         | `app/`、`core/`              |
| `voice/`  | 语音硬件端（Charlie） | Python 3.12 + FastAPI    | `voice/charlie/`             |

## 开始之前

**服务器端**

```bash
git clone https://github.com/SxLiuYu/allbot.git
cd allbot
pnpm install
pnpm build
```

需要 Node.js ≥ 22。包管理器固定为 pnpm 10.32.1（见 `package.json` 的 `packageManager` 字段），版本不符会自切换并出问题。

**手机端**

```bash
cd mobile
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
```

需要 JDK 17 与 Android SDK。在 `mobile/local.properties` 写一行 `sdk.dir=<你的 SDK 路径>`（该文件不入库）。

**语音端**

```bash
cd voice/charlie
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-core.txt
python -m pytest tests/
```

需要 ffmpeg：macOS `brew install ffmpeg`，Linux `apt install ffmpeg`，Windows `winget install ffmpeg`。

## 提交前必须跑的检查

| 改动范围 | 命令                                     | 说明                                       |
| -------- | ---------------------------------------- | ------------------------------------------ |
| 根目录   | `pnpm check`                             | 类型 + lint + 各项边界检查，全绿才提交     |
| 根目录   | `pnpm format:check`                      | 格式化（oxfmt），不合格用 `pnpm format` 修 |
| 根目录   | `pnpm test`                              | 全量测试，CI 里跑约 40 分钟                |
| 单目录   | `node scripts/test-projects.mjs src/xxx` | 只跑一个目录，快得多                       |
| 手机端   | `./gradlew :app:testDebugUnitTest`       | JVM 单测                                   |
| 语音端   | `python -m pytest tests/`                | 60+ 用例                                   |

注意：本地跑测试默认**关掉模块隔离**以提速，所以偶发的跨文件 mock 污染只在本地出现。CI 上是隔离的。遇到「单跑通过、一起跑失败」时先怀疑这个。

## 代码约定

- TypeScript ESM，严格类型。禁用 `any`（`typescript/no-explicit-any` 为 error）。
- 格式化与 lint 用 **Oxlint / Oxfmt**，不是 ESLint / Prettier。
- 不允许 `@ts-nocheck`；要抑制规则必须写清原因。
- 外部边界（配置、webhook、CLI 输出、持久化 JSON、第三方 API 响应）一律走 zod 或现有 schema 帮手。
- 文件控制在 ~700 行内，超了就抽帮手，不要复制成 `V2`。
- 不要用 `?? 0`、空串、空对象、魔法字符串当哨兵值。
- 同一个模块不要混用 `await import("x")` 与静态 `import`，懒加载走专门的 `*.runtime.ts` 边界。
- 英文文档与注释用美式拼写。产品名写 **AllBot**，CLI / 包名 / 路径写 `allbot`。

完整约定在 [`AGENTS.md`](AGENTS.md)。

## 测试约定

- 框架 Vitest。测试文件与被测代码同目录（`*.test.ts`），端到端用 `*.e2e.test.ts`。
- 测试要自己清理：定时器、环境变量、全局变量、mock、socket、临时目录、模块状态。
- 不要在 `beforeEach` 里对重模块用 `vi.resetModules()` + `await import(...)`，用 `beforeAll` + 重置 mock。
- 不要为了让检查通过而改基线、快照或「预期失败」文件。
- 认知层的真实 LLM 测试是本地专用，不接 CI（缺 API Key），改 `src/cognitive/evolution/` 或 `src/cognitive/insight/` 后请本地跑一次：

```bash
ALLBOT_LIVE_TEST=1 ZAI_API_KEY=$ZAI_API_KEY pnpm test src/cognitive/evolution/evolution-live-e2e.test.ts
```

## 提交规范

- 一个提交只做一件事，不要在同一个提交里混入无关重构。
- 消息用祈使句写清动作，例如 `fix(feishu): 修掉卡片按钮点不动`。
- 格式：`<type>(<scope>): <subject>`，type 取 `feat` / `fix` / `docs` / `test` / `chore` / `refactor`。

## 提交 PR

1. fork 后从 `main` 开分支。
2. 提交前跑完上表里对应的检查。
3. PR 描述写清：改了什么、为什么、怎么验证的。
4. 三个子项目分开提 PR，不要混在一起。
5. CI 必须绿。

## 改动 `mobile/` 与 `voice/` 的特殊说明

这两个目录是上游项目的品牌改造快照，**不带上游 git 历史**：

- `mobile/` ← [wangzan101/Mika](https://github.com/wangzan101/Mika) @ `2dce3bb4`（Apache-2.0）
- `voice/` ← [Charlie](https://github.com/SxLiuYu/charlie-voice-assistant) @ `710d2c4`（MIT）

从上游拉更新会与品牌替换、地址改写冲突，每次都要手工合并。冲突点与逐项改动写在 [`mobile/VENDOR.md`](mobile/VENDOR.md)、[`voice/VENDOR.md`](voice/VENDOR.md)，动手前务必读。

## 许可证

提交即表示同意以本仓库对应部分的许可证发布：根目录 MIT、`mobile/` Apache-2.0、`voice/charlie/` MIT。详见 [`NOTICE`](NOTICE)。
