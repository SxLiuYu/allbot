package com.wangzan101.mika.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OnboardingTest {
    private fun inputs(
        hasMain: Boolean = false,
        modelDone: Boolean = false,
        phoneNeeded: Boolean = true,
        phoneSeen: Boolean = false,
        primaryUse: PrimaryUse = PrimaryUse.UNSET,
    ) = Onboarding.Inputs(hasMain, modelDone, phoneNeeded, phoneSeen, primaryUse)

    @Test fun freshInstallStartsWithWelcomeThenModelThenPhone() {
        val i = inputs()
        assertEquals(OnboardingStep.Welcome, Onboarding.start(i))
        assertEquals(OnboardingStep.Model, Onboarding.next(OnboardingStep.Welcome, i))
        assertEquals(OnboardingStep.Phone, Onboarding.next(OnboardingStep.Model, i))
        assertNull(Onboarding.next(OnboardingStep.Phone, i))
    }

    @Test fun configuredModelSkipsFirstTwoSteps() {
        assertEquals(OnboardingStep.Phone, Onboarding.start(inputs(hasMain = true)))
        assertNull(Onboarding.start(inputs(hasMain = true, phoneSeen = true)))
        assertNull(Onboarding.start(inputs(hasMain = true, phoneNeeded = false)))
    }

    @Test fun modelSetupDoneOnceIsNotRepeatedEvenIfModelsWereRemoved() {
        assertEquals(OnboardingStep.Phone, Onboarding.start(inputs(modelDone = true)))
        assertNull(Onboarding.start(inputs(modelDone = true, phoneSeen = true)))
    }

    @Test fun phoneStepSkippedWhenReadyOrSeen() {
        assertNull(Onboarding.next(OnboardingStep.Model, inputs(phoneNeeded = false)))
        assertNull(Onboarding.next(OnboardingStep.Model, inputs(phoneSeen = true)))
    }

    @Test fun dotsFollowSteps() {
        assertEquals(listOf(0, 1, 2), OnboardingStep.entries.map(Onboarding::dot))
    }

    /** 选「先用来接打电话」的人不该被要求配 App 主模型：电话链路根本不读它。 */
    @Test fun callsOnlyUserSkipsModelSetup() {
        val callsOnly = inputs(primaryUse = PrimaryUse.CALLS)
        assertEquals(OnboardingStep.Phone, Onboarding.start(callsOnly))
        assertNull(Onboarding.start(inputs(primaryUse = PrimaryUse.CALLS, phoneSeen = true)))
    }

    @Test fun callsUseStartsAtPhoneNotWelcome() {
        assertEquals(OnboardingStep.Phone, Onboarding.firstStepFor(PrimaryUse.CALLS))
        assertEquals(OnboardingStep.Welcome, Onboarding.firstStepFor(PrimaryUse.ASSISTANT))
        // 还没选过（老流程）时保持原行为
        assertEquals(OnboardingStep.Welcome, Onboarding.firstStepFor(PrimaryUse.UNSET))
    }

    @Test fun assistantUseKeepsModelStep() {
        val assistant = inputs(primaryUse = PrimaryUse.ASSISTANT)
        assertEquals(OnboardingStep.Welcome, Onboarding.start(assistant))
        assertEquals(OnboardingStep.Model, Onboarding.next(OnboardingStep.Welcome, assistant))
    }

    /** 已配过主模型的老用户，即使想改用电话也不该被重新走一遍上手。 */
    @Test fun existingModelKeepsCallsUserOut() {
        assertNull(Onboarding.start(inputs(hasMain = true, phoneSeen = true, primaryUse = PrimaryUse.CALLS)))
    }
}
