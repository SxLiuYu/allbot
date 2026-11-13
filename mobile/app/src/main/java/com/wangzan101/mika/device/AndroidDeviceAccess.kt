package com.wangzan101.mika.device

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.UserManager
import android.text.InputType
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import com.wangzan101.mika.cap.phone.a11y.ScreenAccessibility
import com.wangzan101.mika.core.device.CredentialKind
import com.wangzan101.mika.core.device.DeviceAccess
import com.wangzan101.mika.core.device.DeviceAccessPort
import com.wangzan101.mika.core.device.DeviceCredential
import com.wangzan101.mika.core.device.DeviceState
import com.wangzan101.mika.settings.DeviceAccessSettings
import com.wangzan101.mika.settings.KeystoreKeyCipher
import com.wangzan101.mika.shell.IMikaShell
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** App 级唯一实例:设置页与经过认证的 MCP 共用,不经过模型、屏幕工具或运行记录。 */
class AndroidDeviceAccess(context: Context, helper: () -> IMikaShell?) {
    val settings = DeviceAccessSettings(File(context.filesDir, "settings"), KeystoreKeyCipher("mika-device-access"))
    val access = DeviceAccess(AndroidDeviceAccessPort(context, helper), settings)
}

internal class AndroidDeviceAccessPort(context: Context, private val helper: () -> IMikaShell?) : DeviceAccessPort {
    private val power = context.getSystemService(PowerManager::class.java)
    private val keyguard = context.getSystemService(KeyguardManager::class.java)
    private val user = context.getSystemService(UserManager::class.java)

    override suspend fun state() = withContext(Dispatchers.IO) {
        DeviceState(power.isInteractive, keyguard.isKeyguardLocked, keyguard.isDeviceLocked,
            keyguard.isDeviceSecure, helper() != null, user.isUserUnlocked)
    }

    override suspend fun wake(): Boolean = withContext(Dispatchers.IO) { runCatching { helper()?.wakeDevice() == true }.getOrDefault(false) }
    override suspend fun dismiss(): Boolean = withContext(Dispatchers.IO) { runCatching { helper()?.dismissDeviceKeyguard() == true }.getOrDefault(false) }

    /**
     * 只认主屏 SystemUI 中唯一、类型匹配的密码框。SIM PIN/无法识别的厂商页不尝试。
     * 凭据按键要只投给 SystemUI 的窗口,靠安卓 13 起的定向注入;更早的系统在占位之前就报不支持,不留下暂停。
     */
    override suspend fun credentialReady(kind: CredentialKind): Boolean = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return@withContext false
        if (!power.isInteractive || !keyguard.isKeyguardLocked || !keyguard.isDeviceLocked) return@withContext false
        val service = ScreenAccessibility.instance.value ?: return@withContext false
        val fields = mutableListOf<AccessibilityNodeInfo>()
        fun visit(n: AccessibilityNodeInfo, depth: Int, sim: Boolean = false) {
            if (depth > 30 || fields.size > 1) return
            val id = n.viewIdResourceName.orEmpty()
            val simChallenge = sim || "sim" in id.lowercase()
            if (n.isVisibleToUser && !simChallenge) {
                val numeric = n.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_NUMBER
                if (KeyguardFields.matches(kind, id, n.className?.toString().orEmpty(), n.isPassword, n.isEditable, numeric)) fields += n
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { visit(it, depth + 1, simChallenge) }
        }
        service.windowsOn(Display.DEFAULT_DISPLAY).forEach { window ->
            window.root?.takeIf { it.packageName?.toString() == "com.android.systemui" }?.let { visit(it, 0) }
        }
        val field = fields.singleOrNull() ?: return@withContext false
        field.isFocused || field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    }

    override suspend fun enter(credential: DeviceCredential): Boolean {
        if (!credentialReady(credential.kind)) return false
        return withContext(Dispatchers.IO) {
            val bytes = ByteArray(credential.value.size) { credential.value[it].code.toByte() }
            try { runCatching { helper()?.enterDeviceCredential(credential.kind.ordinal, bytes) == true }.getOrDefault(false) }
            finally { bytes.fill(0) }
        }
    }
}
