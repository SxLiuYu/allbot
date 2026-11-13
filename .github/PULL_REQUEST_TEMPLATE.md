## 改了什么

<!-- 一句话说清。如果修的是 bug，写明现象。 -->

## 为什么

<!-- 关联 Issue 号（Closes #123），或说明动机。 -->

## 属于哪一端

- [ ] 根目录（AllBot 服务器端）
- [ ] `mobile/`（手机端·言出）
- [ ] `voice/`（语音硬件端·Charlie）

## 怎么验证的

<!--
勾选并补实测结论。没跑的项目留空，不要勾。
-->

- [ ] `pnpm check` 通过
- [ ] `pnpm format:check` 通过
- [ ] `pnpm test` 通过（或只跑了：`node scripts/test-projects.mjs <路径>`）
- [ ] `./gradlew :app:testDebugUnitTest` 通过（手机端）
- [ ] `python -m pytest tests/` 通过（语音端）
- [ ] 真机 / 真实环境验证过，结论如下：

## 有没有副作用

<!-- 破坏性变更、配置默认值变化、需要用户手动做什么。没有就写「无」。 -->

## 截图

<!-- 涉及界面时贴前后对比；命令行改动贴输出。 -->
