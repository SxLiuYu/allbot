package com.wangzan101.mika.core.tool

import com.wangzan101.mika.core.capability.CapabilityKey

/**
 * 读此刻那块屏的指纹(不含 ref);没有接屏、还没读过为 null。
 * 由界面状态在装配时挂上,工具引擎只认这个口(见 PackageDependencyTest:引擎不引用界面状态)。
 */
fun interface ScreenFingerprints {
    fun current(): Long?
}

internal val SCREEN_FINGERPRINTS = CapabilityKey<ScreenFingerprints>("screen_fingerprints")
