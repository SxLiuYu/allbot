# mobile/ — 上游来源与改动记录

这个目录是 [Mika](https://github.com/wangzan101/Mika) 的源码，品牌改造为「言出」，随 AllBot 一起发行。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/wangzan101/Mika |
| 上游提交 | `2dce3bb42bbd0291c11ddbe930cd70fb6271cd27`（2026-11-12，`sims 为空时说明原因:是没给电话权限,不是没插卡`) |
| 许可证 | Apache-2.0，见 `mobile/LICENSE` 与 `mobile/NOTICE` |
| 收录时间 | 2026-11-13 |
| 历史 | 上游 423 个提交**未带进本仓库**。要追溯就在上游按上面的 SHA 查。 |

上游代码按原样收录，目录结构与包名（`com.wangzan101.mika`）不改。

## 本仓库对上游做的改动

### 1. 品牌：Mika → 言出 / Yanchu

- `applicationId` 为 `com.suoshou.yide`；`namespace` 与 Kotlin 包名仍是 `com.wangzan101.mika`（2669 处引用不改包名）。
- 216 个 `strings.xml` 里的 Mika 换成 言出/Yanchu；launcher 图标换成黑底白「言」字。
- 桌面图标名仍是 `Yanchu`（`app_name` 带 `translatable="false"`，中文包加它会被 `StringResourcesTest` 拦）。

### 2. 对外地址指向本仓库

全部在 [`app/src/main/java/com/wangzan101/mika/about/MikaLinks.kt`](app/src/main/java/com/wangzan101/mika/about/MikaLinks.kt) 一处：

| 常量 | 现在指向 |
|---|---|
| `REPO` | `https://github.com/SxLiuYu/allbot` |
| `README` | `.../tree/main/mobile#readme` |
| `RELEASES` / `LATEST_RELEASE_API` | 本仓库的 Releases |
| `NEW_ISSUE` | 本仓库 Issues |
| `X` / `X_HANDLE` / `X_GROUP` | 上游作者与交流群，保留署名 |

`ApkIntegrity.requireOfficialUrl` 从 `MikaLinks.RELEASES` 派生，所以下载只接受本仓库 `releases/download/` 下的 `.apk`。

### 3. 电话功能（`app/src/main/java/com/wangzan101/mika/calls/`）

在上游 `2dce3bb4` 之外新增或修改：

- `LocalRealtimeSession.kt`（新增）与 `LocalRealtimeSessionTest.kt`（新增）
- `CallPcmBridge.kt`、`CallRuntime.kt`、`VolcRealtimeClient.kt`（修改）

音频双向出声未验证：需要火山（Volcengine）凭证，且必须真人听。详见 `docs/` 下的通话说明。

### 4. 剪裁：只留手机端

`TaskRun.kt` 顶层 `PHONE_ONLY=true`，web 和 sandbox 一律传 null；设置页隐藏「网站登录 / 沙箱 / 电脑连接」；侧栏删除浏览器入口。

## 没带进来的东西

- `.tmp/`、`build/`、`.gradle/`、`node_modules/`
- `local.properties`（含本机 SDK 路径）
- 上游的 4 个 GIF 演示与 `docs/media/` 之外的截图保留，31MB 的 `app/src/main/assets/runtime/rootfs.tar.xz` 保留（沙箱运行必需）

## 怎么构建

```bash
cd mobile
./gradlew :app:assembleDebug          # Windows: gradlew.bat
```

需要 JDK 17 与 Android SDK。`local.properties` 自己建，写 `sdk.dir=<你的 SDK 路径>`。

## 怎么从上游拉更新

```bash
git remote add mika https://github.com/wangzan101/Mika.git
git fetch mika
# 看差异：上游 main 相对 2dce3bb4 改了什么
git diff 2dce3bb4 mika/main -- app core
```

品牌替换与地址改写会与上游冲突，每次都要重新跑一遍（脚本未随仓库提供）。
