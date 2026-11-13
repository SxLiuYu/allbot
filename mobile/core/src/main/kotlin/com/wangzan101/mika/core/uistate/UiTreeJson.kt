package com.wangzan101.mika.core.uistate

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * 给模型看的手机窗口层级;只省去空字段和默认状态。
 * 节点多时按 [MAX_NODES] 裁剪:先留有内容的那部分,空壳只在余量里留(见 [Budget])。
 */
object UiTreeJson {
    /**
     * 一次读屏最多带多少个节点。屏幕一大,无障碍树里多半是 Layout 套 Layout 的空壳(实测某屏 68 个节点里
     * 38 个既没有文字也没有 ref),它们只用来表达从属关系,却要占掉数 KB。
     */
    const val MAX_NODES = 60

    /** 节点超预算时,那一行给模型看的话。 */
    fun droppedNote(dropped: Int): String = "…$dropped more nodes not shown; use phone_query to find a specific control"

    /**
     * 这些 role 是布局容器:只用来摆位置,没有自己承载的内容。名字里带以下片段的都算
     * (LinearLayout、FrameLayout、ViewGroup、RecyclerView、ScrollView……)。
     * 其余 role(Button、TextView、ImageView、EditText……)哪怕是空的也留下:它自己就是一个控件。
     */
    private val CONTAINER_MARKERS = listOf("Layout", "ViewGroup", "RecyclerView", "ScrollView", "ViewPager",
        "CoordinatorLayout", "DecorView", "ContentFrame", "ListView", "GridView", "View", "Root")

    private fun isContainerRole(role: String): Boolean =
        CONTAINER_MARKERS.any { role.contains(it, ignoreCase = true) }

    fun windows(s: ScreenSnapshot, maxNodes: Int = MAX_NODES): JsonArray {
        val budget = Budget(maxNodes, s.windows)
        return buildJsonArray {
            for (w in s.windows) add(buildJsonObject {
                // 窗口内的 resourceId 与包名同前缀时只留后缀(见 [trimIds]),这里说一次前缀是什么
                val pkg = w.packageName
                if (pkg != null && w.nodes.any { sharesPackage(it, pkg) }) put(ID_PREFIX_KEY, "$pkg:id/")
                put("id", w.id)
                put("type", w.type)
                put("layer", w.layer)
                w.title?.let { put("title", it) }
                pkg?.let { put("packageName", it) }
                if (w.active) put("active", true)
                if (w.focused) put("focused", true)
                put("nodes", JsonArray(trimIds(budget.emit(w.nodes), pkg)))
                if (budget.dropped > 0) put("dropped", budget.dropped)
            })
        }
    }

    /** 资源 ID 与窗口包名同前缀时省掉前缀的窗口键;节点上的 resourceId 这时只剩 `:id/名字`。 */
    private const val ID_PREFIX_KEY = "resourceIdPrefix"

    /** 这个子树里有没有节点的 resourceId 与 [pkg] 同前缀(有才值得在窗口上说一次)。 */
    private fun sharesPackage(n: UiTreeNode, pkg: String): Boolean {
        val prefix = "$pkg:id/"
        return n.resourceId?.startsWith(prefix) == true || n.children.any { sharesPackage(it, pkg) }
    }

    /** 一个节点的 resourceId 与窗口包名同前缀时收敛成 `:id/名字`。 */
    private fun trimOne(o: JsonObject, pkg: String?): JsonObject {
        if (pkg == null) return o
        val prefix = "$pkg:id/"
        val id = (o["resourceId"] as? JsonPrimitive)?.contentOrNull ?: return o
        return if (id.startsWith(prefix)) JsonObject(o + ("resourceId" to JsonPrimitive(":id/" + id.removePrefix(prefix)))) else o
    }

    /** 整棵子树逐个收敛(差异里的新增节点带完整子树)。 */
    private fun trimTree(o: JsonObject, pkg: String?): JsonObject {
        val t = trimOne(o, pkg)
        val kids = t["children"] as? JsonArray ?: return t
        return JsonObject(t + ("children" to JsonArray(kids.map { trimTree(it as JsonObject, pkg) })))
    }

    /**
     * 把 `com.example.app:id/foo` 收敛成 `:id/foo`(窗口上已写 `resourceIdPrefix`)。
     * 一个窗口里同样的包名前缀会重复几十遍,占掉读屏结果的一成多;后缀足够让 phone_query 认出来
     * (它按 contains 比),模型要看全名也能自己拼回去。别的包名(跨应用弹窗)保持原样。
     */
    private fun trimIds(nodes: List<JsonObject>, pkg: String?): List<JsonObject> {
        if (pkg == null) return nodes
        return nodes.map { n ->
            val t = trimOne(n, pkg)
            val kids = t["children"] as? JsonArray ?: return@map t
            JsonObject(t + ("children" to JsonArray(trimIds(kids.map { it as JsonObject }, pkg))))
        }
    }

    /**
     * 空包装层(`LinearLayout` 套一个 `LinearLayout` 套一个按钮)整层去掉,子节点抬到上一层:
     * 它们不表达任何归属,只多占几十字节。一个空壳下挂着**两个以上**子节点时才留着,
     * 那时它确实是一个分组(卡片、列表项)。这一条通常就够省一半字节,不需要动节点数。
     */
    private class Budget(max: Int, windows: List<UiWindowTree>) {
        // 按对象身份记:UiTreeNode 是 data class,两个长得一样的空壳是同一份数据,不能互相顶掉
        private val keep = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<UiTreeNode, Boolean>())
        var dropped = 0
            private set

        init {
            val all = mutableListOf<UiTreeNode>()
            fun walk(nodes: List<UiTreeNode>) { nodes.forEach { all += it; walk(it.children) } }
            windows.forEach { walk(it.nodes) }
            // 没超预算就一个字节都不动:小屏的树保持原样,改动只发生在大屏上
            if (all.size <= max) {
                keep += all
            } else {
                // 留:自己就是控件或有文字的;以及挂着两个以上子节点的分组。只有单个子节点的纯包装层去掉
                val worth = all.filter { hasContent(it) || isGroup(it) }
                if (worth.size <= max) {
                    keep += worth
                } else {
                    val content = worth.filter(::hasContent)
                    keep += content.take(max)
                    keep += worth.filter { !hasContent(it) }.take((max - keep.size).coerceAtLeast(0))
                }
            }
            dropped = all.size - keep.size
        }

        /** 直接挂了两个以上子节点:是个分组(卡片、列表项),留着才有归属可读。 */
        private fun isGroup(n: UiTreeNode) = n.children.size >= 2

        /** 值得单独留的节点:自己承载内容(文字、描述、ref、可点…),或者本身就是一个控件。 */
        private fun hasContent(n: UiTreeNode) = n.text != null || n.description != null || n.ref != null ||
            n.hintText != null || !isContainerRole(n.role) ||
            n.clickable || n.editable || n.scrollable || n.wheel

        /** 重建这一层的节点;没留下但有留下的后代的,把后代抬上来。 */
        fun emit(nodes: List<UiTreeNode>): List<JsonObject> = nodes.flatMap { n ->
            val children = emit(n.children)
            if (n !in keep) children
            else listOf(JsonObject(shallow(n) + (if (children.isEmpty()) emptyMap() else mapOf("children" to JsonArray(children)))))
        }
    }

    private fun node(n: UiTreeNode): JsonObject = JsonObject(shallow(n) +
        (if (n.children.isEmpty()) emptyMap() else mapOf("children" to JsonArray(n.children.map(::node)))))

    private fun shallow(n: UiTreeNode): JsonObject = buildJsonObject {
        put("role", n.role)
        n.ref?.let { put("ref", it) }
        n.text?.let { put("text", it) }
        n.description?.let { put("description", it) }
        n.hintText?.let { put("hintText", it) }
        n.resourceId?.let { put("resourceId", it) }
        put("bounds", JsonArray(n.bounds.map(::JsonPrimitive)))
        if (n.clickable) put("clickable", true)
        if (n.editable) put("editable", true)
        if (n.scrollable) put("scrollable", true)
        if (n.checkable) put("checked", n.checked)
        if (n.selected) put("selected", true)
        if (!n.enabled) put("enabled", false)
        if (n.focused) put("focused", true)
        if (n.secret) put("secret", true)
        if (n.wheel) put("wheel", true)
    }

    /** 路径按窗口和子节点序号定位;同一路径的属性变化只发该节点,新增节点发完整子树。 */
    fun changes(before: ScreenSnapshot, current: ScreenSnapshot): JsonObject {
        val old = index(before.windows)
        val now = index(current.windows)
        // 路径第一段是 w<窗口 id>;同一块屏的全量读法([windows])已经把 resourceId 裁成 `:id/名字`,
        // 差异读法必须用同一套写法,否则模型会在两处看到同一个控件两种名字
        val pkgOf = current.windows.associate { "w${it.id}" to it.packageName }
        fun pkgOf(path: String): String? = pkgOf[path.substringBefore('/')]
        fun trimmed(n: UiTreeNode, path: String): JsonObject = trimOne(shallow(n), pkgOf(path))
        val updated = buildJsonArray {
            for ((path, n) in now) {
                val previous = old[path]
                if (previous == null && parent(path) in now && parent(path) !in old) continue // 新父节点已经带上完整子树
                if (previous == null || shallow(previous) != shallow(n)) add(buildJsonObject {
                    put("path", path)
                    put("node", if (previous == null) trimTree(node(n), pkgOf(path)) else trimmed(n, path))
                })
            }
        }
        val gone = old.keys.filterTo(LinkedHashSet()) { it !in now }
        val removed = buildJsonArray { for (path in gone) if (parent(path) !in gone) add(JsonPrimitive(path)) }
        val prefixes = current.windows.mapNotNull { w ->
            w.packageName?.takeIf { p -> w.nodes.any { sharesPackage(it, p) } }
        }.distinct()
        return buildJsonObject {
            put("updated", updated)
            put("removed", removed)
            // 差异里也可能带 resourceId,前缀一样说一次;多个窗口各带前缀时依次列出
            if (prefixes.size == 1) put(ID_PREFIX_KEY, "${prefixes[0]}:id/")
            else if (prefixes.size > 1) put(ID_PREFIX_KEY, JsonArray(prefixes.map { JsonPrimitive("$it:id/") }))
        }
    }

    fun sameWindows(a: ScreenSnapshot, b: ScreenSnapshot): Boolean =
        a.windows.map { listOf(it.id, it.type, it.layer, it.title, it.packageName, it.active, it.focused) } ==
            b.windows.map { listOf(it.id, it.type, it.layer, it.title, it.packageName, it.active, it.focused) }

    private fun index(windows: List<UiWindowTree>): LinkedHashMap<String, UiTreeNode> = LinkedHashMap<String, UiTreeNode>().also { out ->
        fun walk(prefix: String, nodes: List<UiTreeNode>) {
            nodes.forEachIndexed { i, node ->
                val path = "$prefix/$i"
                out[path] = node
                walk(path, node.children)
            }
        }
        windows.forEach { walk("w${it.id}", it.nodes) }
    }

    private fun parent(path: String): String = path.substringBeforeLast('/', "")
}
