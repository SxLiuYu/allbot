package com.wangzan101.mika.device

import com.wangzan101.mika.core.device.CredentialKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyguardFieldsTest {
    @Test fun stockKeyguardSelfDrawnPinFieldDoesNotNeedEditable() {
        assertTrue(KeyguardFields.matches(CredentialKind.Pin, "com.android.systemui:id/pinEntry",
            "com.android.keyguard.PasswordTextView", true, false, false))
        assertFalse(KeyguardFields.matches(CredentialKind.Password, "com.android.systemui:id/pinEntry",
            "com.android.keyguard.PasswordTextView", true, false, false))
    }

    @Test fun editablePasswordAndPinHaveDistinctTypes() {
        assertTrue(KeyguardFields.matches(CredentialKind.Password, "com.android.systemui:id/passwordEntry", "android.widget.EditText", true, true, false))
        assertTrue(KeyguardFields.matches(CredentialKind.Pin, "com.android.systemui:id/pinEntry", "android.widget.EditText", true, true, true))
        assertFalse(KeyguardFields.matches(CredentialKind.Password, "com.android.systemui:id/pinEntry", "android.widget.EditText", true, true, true))
    }

    @Test fun unknownCustomFieldsAndSimPinsAreNeverEntered() {
        assertFalse(KeyguardFields.matches(CredentialKind.Pin, "com.android.systemui:id/simPinEntry", "com.android.keyguard.PasswordTextView", true, true, true))
        assertFalse(KeyguardFields.matches(CredentialKind.Pin, "other:id/pinEntry", "com.android.keyguard.PasswordTextView", true, true, true))
        assertFalse(KeyguardFields.matches(CredentialKind.Pin, "com.android.systemui:id/unknown", "CustomPasswordView", true, false, false))
        assertFalse(KeyguardFields.matches(CredentialKind.Password, "com.android.systemui:id/passwordEntry", "android.widget.EditText", false, true, false))
    }
}
