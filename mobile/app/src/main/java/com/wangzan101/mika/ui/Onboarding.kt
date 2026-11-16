package com.wangzan101.mika.ui

import android.content.Context

/** 首次上手的三步。 */
enum class OnboardingStep { Welcome, Model, Phone }

/**
 * 用户第一次打开时想先用的能力。
 *
 * 为什么要这个：电话链路完全不读 App 主模型（`ProviderStore.roles.main`），但以前首次启动
 * 一律要求「欢迎 → 配置模型 → 手机操作」，只打算用 AI 接电话的人也得先配一个与电话无关的
 * 模型。选了 [CALLS] 就不再要求配置主模型，直接进电话初始化。
 */
enum class PrimaryUse { UNSET, CALLS, ASSISTANT }

/**
 * 首次打开时走哪几步(纯函数,便于测试)。和手机引导一样按「看过没有」判断,不每次都弹:
 * - 欢迎和配置模型:还没有主模型、也没在上手流程里配过模型时才走。已经配过模型的(包括老用户)直接跳过。
 * - 手机操作:系统够新、手机操作还没就绪、引导没看过时走。
 *
 * [PrimaryUse.CALLS] 只跳过「配置模型」这一步：电话不需要主模型，硬塞进去只会让人以为
 * 电话依赖它。手机操作引导仍然保留——AI 接电话要用内置助手接管通话音频。
 */
object Onboarding {
    data class Inputs(
        val hasMainModel: Boolean,
        val modelSetupDone: Boolean,
        /** 系统够新且手机操作还没就绪。 */
        val phoneNeeded: Boolean,
        val phoneGuideSeen: Boolean,
        /** 用户选的首要用途；[PrimaryUse.UNSET] 表示还没问过（老流程）。 */
        val primaryUse: PrimaryUse = PrimaryUse.UNSET,
    )

    fun start(i: Inputs): OnboardingStep? = when {
        !i.hasMainModel && !i.modelSetupDone && i.primaryUse != PrimaryUse.CALLS -> OnboardingStep.Welcome
        i.phoneNeeded && !i.phoneGuideSeen -> OnboardingStep.Phone
        else -> null
    }

    /**
     * 走完用途选择后的第一步。选 [PrimaryUse.CALLS] 直接进手机操作引导（电话要用内置助手
     * 接管通话音频），跳过整个模型配置；选助手或还没选时仍从欢迎页开始。
     */
    fun firstStepFor(use: PrimaryUse): OnboardingStep =
        if (use == PrimaryUse.CALLS) OnboardingStep.Phone else OnboardingStep.Welcome

    /** [step] 做完后的下一步;没有了为 null(进对话)。 */
    fun next(step: OnboardingStep, i: Inputs): OnboardingStep? = when (step) {
        OnboardingStep.Welcome -> OnboardingStep.Model
        OnboardingStep.Model -> if (i.phoneNeeded && !i.phoneGuideSeen) OnboardingStep.Phone else null
        OnboardingStep.Phone -> null
    }

    /** 底部分页点:三步里的第几步。 */
    fun dot(step: OnboardingStep): Int = step.ordinal
    const val DOTS = 3
}

/** 上手流程里「配置模型」做完没有;存在本机。 */
class OnboardingState(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun modelSetupDone(): Boolean = prefs.getBoolean(MODEL_DONE, false)

    fun markModelSetupDone() {
        prefs.edit().putBoolean(MODEL_DONE, true).apply()
    }

    /** 用户选的首要用途；还没问过时为 [PrimaryUse.UNSET]。 */
    fun primaryUse(): PrimaryUse {
        val stored = prefs.getString(PRIMARY_USE, null) ?: return PrimaryUse.UNSET
        return PrimaryUse.entries.firstOrNull { it.name == stored } ?: PrimaryUse.UNSET
    }

    fun setPrimaryUse(use: PrimaryUse) {
        prefs.edit().putString(PRIMARY_USE, use.name).apply()
    }

    /** 问过就不能反复弹：老用户升级上来也不该被拦住。 */
    fun primaryUseAsked(): Boolean = prefs.getBoolean(PRIMARY_USE_ASKED, false)

    fun markPrimaryUseAsked() {
        prefs.edit().putBoolean(PRIMARY_USE_ASKED, true).apply()
    }

    private companion object {
        const val PREFS = "onboarding"
        const val MODEL_DONE = "model_setup_done"
        const val PRIMARY_USE = "primary_use"
        const val PRIMARY_USE_ASKED = "primary_use_asked"
    }
}
