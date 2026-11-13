package com.wangzan101.mika.core.uistate

/**
 * 这一屏的无障碍树够不够用;不够用时写进读屏结果的 treeQuality。
 * [Partial]:树缺了一块(控件大多没名字,或屏上有不少字树里没有);[Unusable]:树里几乎读不到东西;
 * [Protected]:防截屏页面,画面也看不到(照旧按 protected 处理)。
 */
internal enum class TreeQuality(val wire: String) {
    Adequate("adequate"), Partial("partial"), Unusable("unusable"), Protected("protected"),
}

/**
 * 一次判断。[quality] 为 null:光看树判不准,要读屏上文字再定(读不到字就一直是 null);[reason] 是不够用的原因,附画面时就是 imageReason。
 * [canvas]:这一屏有一块是 App 自己画的(网页画布、地图、视频层),元素表读不到里面的内容;字读回来之后也留着,
 * 好让模型知道「读不到」不等于「页面没加载出来」。
 */
internal data class TreeCheck(val quality: TreeQuality?, val reason: String? = null, val canvas: Boolean = false) {
    /** 树缺东西或不能用:模型要靠画面或屏上文字补。 */
    val poor: Boolean get() = quality == TreeQuality.Partial || quality == TreeQuality.Unusable
}

/**
 * 先用便宜的树判,判不准再读屏上文字(OCR)比一比。树「明显够用」才不读字:有名字的元素够多、控件大多有名字、
 * App 窗口里没有一大块一个字也没有的区域(画布、地图、图片、读不到内容的网页)。其余拿不准的一律读字,宁可多读一次。
 */
internal object TreeAdequacy {
    /** 有名字的元素少于这个数就拿不准:只有几个字的简单页面和树缺了一大块看起来一样。 */
    private const val ENOUGH_NAMED = 6
    /** 子树里一个字也没有的节点占屏幕这么大(0–1)就是一块盲区。 */
    private const val BLIND_AREA = 0.2
    /** 自绘层(网页画布、地图、视频层)占屏幕这么大(0–1)时,看它里面有没有一大块没字的画布。 */
    private const val CANVAS_AREA = 0.5
    /** 自绘层里一整块没字的画布占屏幕这么大(0–1):画上去的内容没进树,判成自绘页面。 */
    private const val CANVAS_BLIND_AREA = 0.3
    /** 自绘层的节点名:这几类里面画的字通常不会逐个进无障碍树。 */
    private val CANVAS_ROLES = setOf("WebView", "SurfaceView", "TextureView")
    /** 有这么多个有名字的元素落在里面的,只是垫在下面的底板(背景图、容器),不算盲区。 */
    private const val NAMED_INSIDE = 3
    /** OCR 补出这么多行树里没有的字,就算树缺了一块。 */
    private const val MISSING_LINES = 3
    private const val APPLICATION = "application"

    fun ofTree(s: ScreenSnapshot): TreeCheck {
        if (s.protected) return TreeCheck(TreeQuality.Protected)
        if (s.unreadableApp != null && s.elements.none { it.meaningful }) return TreeCheck(TreeQuality.Unusable, "unreadable_window")
        if (!s.hasWindow && s.web == null) return TreeCheck(TreeQuality.Adequate)
        if (s.elements.isEmpty()) return TreeCheck(TreeQuality.Unusable, "empty_elements")
        val named = s.elements.filter { it.name.isNotBlank() }
        val controls = s.elements.filter { it.clickable || it.editable }
        // resourceId 常是开发者内部编号,不能当成用户能认出的控件名称。
        val namedControls = controls.count { it.name.isNotBlank() || !it.placeholder.isNullOrBlank() }
        if (controls.isNotEmpty() && (namedControls == 0 || (controls.size >= 4 && namedControls * 3 <= controls.size)))
            return TreeCheck(if (named.isEmpty()) TreeQuality.Unusable else TreeQuality.Partial, "unlabeled_controls")
        if (named.isEmpty()) return TreeCheck(TreeQuality.Unusable, "no_text")
        // 自绘页面里画的字通常不进树:哪怕节点数够,也读一遍屏上文字
        val canvas = sparseCanvas(s)
        if (named.size < ENOUGH_NAMED || canvas || blindArea(s, named)) return TreeCheck(null, canvas = canvas)
        return TreeCheck(TreeQuality.Adequate)
    }

    /** 树判不准时按 OCR 补出的、树里没有的字([missing],已去掉认错的行)定下来;没读到字([missing] 为 null)照旧判不准。 */
    fun withText(tree: TreeCheck, missing: List<VisibleTextLine>?): TreeCheck {
        if (tree.quality != null || missing == null) return tree
        return if (missing.size >= MISSING_LINES) TreeCheck(TreeQuality.Partial, "text_outside_tree", tree.canvas)
        else TreeCheck(TreeQuality.Adequate, canvas = tree.canvas)
    }

    /** App 窗口里有一块盲区:子树一个字也没有、够大,而且不是垫在有名字的元素下面的底板。 */
    private fun blindArea(s: ScreenSnapshot, named: List<UiElement>): Boolean {
        var found = false
        // 返回这棵子树里有没有字;一遍走完,每个节点只看一次
        fun visit(node: UiTreeNode): Boolean {
            var text = hasText(node)
            for (child in node.children) if (visit(child)) text = true
            if (!text && !found && area(node.bounds) >= BLIND_AREA && named.count { inside(it.bounds, node.bounds) } < NAMED_INSIDE) found = true
            return text
        }
        s.windows.filter { it.type == APPLICATION }.forEach { w -> w.nodes.forEach { visit(it) } }
        return found
    }

    /**
     * 自绘层占了半屏以上,里面还有一整块没有文字的大画布(蚂蚁森林的场景图、地图、视频层):
     * 画上去的内容没进树。看的是「整棵子树有没有字」,不是文字节点自身的面积——
     * 底部一排按钮的名字面积不小,却说明不了中间那块画布读得到。
     */
    private fun sparseCanvas(s: ScreenSnapshot): Boolean {
        var found = false
        fun visit(node: UiTreeNode) {
            if (!found && node.role in CANVAS_ROLES && area(node.bounds) >= CANVAS_AREA) {
                // 返回这棵子树里有没有字;整块都没字又够大,就是一块读不到的画布
                fun check(n: UiTreeNode): Boolean {
                    var text = hasText(n)
                    for (c in n.children) if (check(c)) text = true
                    if (!text && area(n.bounds) >= CANVAS_BLIND_AREA) found = true
                    return text
                }
                node.children.forEach(::check)
            }
            if (!found) node.children.forEach(::visit)
        }
        s.windows.filter { it.type == APPLICATION }.forEach { w -> w.nodes.forEach { visit(it) } }
        return found
    }

    private fun hasText(n: UiTreeNode) =
        !n.text.isNullOrBlank() || !n.description.isNullOrBlank() || !n.hintText.isNullOrBlank()

    private fun area(b: List<Int>): Double =
        if (b.size != 4) 0.0 else (b[2] - b[0]).coerceAtLeast(0).toDouble() * (b[3] - b[1]).coerceAtLeast(0) / (999.0 * 999.0)

    private fun inside(e: List<Int>, b: List<Int>): Boolean {
        if (e.size != 4 || b.size != 4) return false
        val x = (e[0] + e[2]) / 2; val y = (e[1] + e[3]) / 2
        return x in b[0]..b[2] && y in b[1]..b[3]
    }
}
