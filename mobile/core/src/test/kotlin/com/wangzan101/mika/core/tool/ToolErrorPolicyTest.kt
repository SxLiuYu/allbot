package com.wangzan101.mika.core.tool

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolErrorPolicyTest {
    private val all = setOf("phone_observe", "phone_tap", "phone_back", "phone_launch_app",
        "phone_find_visually", "phone_system_command")

    private fun decide(tool: String = "phone_tap", code: String?, streak: Int = 1, available: Set<String> = all) =
        ToolErrorPolicy.decide(tool, code, streak, available)

    @Test fun badArgumentsStopWithInstructions() {
        val a = decide(code = "invalid_arguments")
        assertTrue(a is ErrorAction.Stop)
        assertTrue((a as ErrorAction.Stop).reason.contains("参数"))
    }

    @Test fun missingTargetRefreshesThenFallsBackToSight() {
        assertEquals(ErrorAction.RefreshScreenThenRetry, decide(code = "element_not_found", streak = 1))
        val second = decide(code = "element_not_found", streak = 2)
        assertEquals(ErrorAction.Fallback("phone_find_visually", (second as ErrorAction.Fallback).reason), second)
        val blind = decide(code = "ref_expired", streak = 2, available = all - "phone_find_visually")
        assertTrue(blind is ErrorAction.Stop)
    }

    @Test fun deadBackButtonSwitchesToSystemKeyThenStops() {
        assertEquals(ErrorAction.RefreshScreenThenRetry, decide("phone_back", "action_failed", 1))
        val second = decide("phone_back", "action_failed", 2)
        assertEquals("phone_system_command", (second as ErrorAction.Fallback).tool)
        val third = decide("phone_back", "action_failed", 3)
        assertTrue(third is ErrorAction.Stop)
        assertTrue((third as ErrorAction.Stop).reason.contains("返回"))
    }

    @Test fun targetInAnotherWindowObservesInsteadOfTapping() {
        val a = decide(code = "opened_elsewhere")
        assertEquals("phone_observe", (a as ErrorAction.Fallback).tool)
    }

    @Test fun notReadyLaunchesBeforeActing() {
        val a = decide(code = "no_app_open")
        assertEquals("phone_launch_app", (a as ErrorAction.Fallback).tool)
        val b = decide(code = "phone_unavailable", available = all - "phone_launch_app")
        assertEquals("phone_observe", (b as ErrorAction.Fallback).tool)
    }

    @Test fun confirmationIsLeftToTheGate() {
        val a = decide(code = "confirmation_required")
        assertTrue(a is ErrorAction.Stop)
        assertTrue((a as ErrorAction.Stop).reason.contains("确认"))
    }

    @Test fun transientFailureWaitsAndRetries() {
        assertEquals(ErrorAction.RetryAfter(500, 2), decide(code = "action_failed"))
        assertEquals(ErrorAction.RetryAfter(500, 2), decide(code = "timeout"))
    }

    @Test fun unknownCodesStopInsteadOfLoops() {
        assertTrue(decide(code = "weird_new_error") is ErrorAction.Stop)
        assertTrue(decide(code = null) is ErrorAction.Stop)
    }
}
