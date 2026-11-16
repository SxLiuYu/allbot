package com.wangzan101.mika.calls

/**
 * 电话功能的初始化进度：把散落在权限、助手连接、通知、音频实测、后端连接里的判定
 * 收成一个列表。
 *
 * 之前这些条件同时体现在「启用」「准备」「自动接听」「后台常驻」「已实测音频」五个开关上，
 * 用户不知道还差哪一步，只能一个个试。这里给出确定性的步骤列表，界面照着渲染即可；
 * 判定规则与 `CallPolicy.callerAllowed` 保持同源，不新增放行条件。
 */
enum class CallSetupStep {
    DEVICE_PERMISSIONS,
    BUILTIN_HELPER,
    NOTIFICATIONS,
    AUDIO_VERIFIED,
    BACKEND,
    ;

    companion object {
        /**
         * 已完成哪些步骤。顺序即界面的展示顺序，从系统权限到服务连接由外到内。
         *
         * 注意这里只描述**是否具备条件**，不代表允许自动接听——后者还要看用户是否打开
         * 自动接听开关、号码是否在白名单里，那些是 [CallPolicy] 的职责。
         */
        fun completed(config: CallConfig, state: CallRuntimeState): Set<CallSetupStep> = buildSet {
            if (state.phonePermissionGranted && state.audioReady) add(DEVICE_PERMISSIONS)
            if (state.shellConnected) add(BUILTIN_HELPER)
            if (state.notificationsAvailable && state.prepared) add(NOTIFICATIONS)
            if (config.audioVerified) add(AUDIO_VERIFIED)
            if (config.backendReady) add(BACKEND)
        }

        /** 还差哪几步；顺序与 [entries] 一致。 */
        fun missing(config: CallConfig, state: CallRuntimeState): List<CallSetupStep> {
            val done = completed(config, state)
            return entries.filterNot { it in done }
        }

        /** 全部就绪 = 可以放心打开自动接听。 */
        fun ready(config: CallConfig, state: CallRuntimeState): Boolean = missing(config, state).isEmpty()
    }
}
