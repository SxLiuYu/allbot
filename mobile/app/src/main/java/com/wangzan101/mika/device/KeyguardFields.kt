package com.wangzan101.mika.device

import com.wangzan101.mika.core.device.CredentialKind

/**
 * 通用规则:只认 SystemUI 里带密码标志的输入框;编辑框按输入类型区分 PIN(数字)和密码(非数字)。
 * 安卓原版锁屏的 PIN 框是自己画的(`pinEntry` / `PasswordTextView`),不声明 editable,只按原版的这组名字放行;
 * 其余不可编辑的控件、SIM PIN 一律不认,认不准就不输入。
 */
internal object KeyguardFields {
    fun matches(kind: CredentialKind, id: String, className: String, password: Boolean, editable: Boolean, numeric: Boolean): Boolean {
        if (!password || !id.startsWith("com.android.systemui:id/") || "sim" in id.lowercase()) return false
        val pinView = id == "com.android.systemui:id/pinEntry" && className == "com.android.keyguard.PasswordTextView"
        return when (kind) {
            CredentialKind.Pin -> pinView || editable && numeric
            CredentialKind.Password -> editable && !numeric
        }
    }
}
