package com.wangzan101.mika.calls

/**
 * 通话后端是哪种服务。
 *
 * 以前只有「有没有火山凭据」「有没有本地地址」两个布尔值，界面只能靠字符串是否为空
 * 反推该显示哪套配置项，结果三种情况混在一页里：普通用户看到火山 App ID/Access Key，
 * 自建用户看到完整 WebSocket URL。这里把它显式化，界面和状态判断都只读这一个值。
 *
 * 存储上向后兼容：老版本没有这个字段，读的时候按已有数据推导（见 [infer]），不迁移、
 * 不覆盖旧键，所以回退到老版本 App 也能正常读。
 */
enum class CallBackendKind {
    /** 还没配任何后端。要先进设置向导，不该允许自动接听。 */
    UNCONFIGURED,

    /** 官方云端服务：地址和凭据打包成一份服务配置，用户不直接看到 URL/token。 */
    CLOUD,

    /** 自建服务：用户自己填 ws(s):// 地址。 */
    CUSTOM,

    /** 火山引擎实时语音：传统 API Key 或旧版 App ID + Access Key。 */
    VOLCENGINE,
    ;

    /** 这个服务类型下需要用户填的配置是否已经存在。只判「填了」，不判「连通」。 */
    fun isConfigured(config: CallConfig): Boolean = when (this) {
        UNCONFIGURED -> false
        CLOUD, CUSTOM -> !config.localEndpoint.isNullOrBlank()
        VOLCENGINE -> config.credentialsConfigured
    }

    companion object {
        /**
         * 老数据推导。优先级：显式字段 > 自建地址 > 火山凭据 > 未配置。
         *
         * 云端的服务和自建服务共用 `local_endpoint` 这一列，所以「有地址」时还要看显式
         * kind 才能区分；显式 kind 缺失（老版本写入）时一律按 [CUSTOM]，因为老版本只支持
         * 手工填地址这一种。
         */
        fun infer(explicit: CallBackendKind?, config: CallConfig): CallBackendKind = when {
            explicit != null && explicit != UNCONFIGURED -> explicit
            !config.localEndpoint.isNullOrBlank() -> CUSTOM
            config.credentialsConfigured -> VOLCENGINE
            explicit == UNCONFIGURED -> UNCONFIGURED
            else -> UNCONFIGURED
        }
    }
}
