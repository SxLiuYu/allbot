package com.wangzan101.mika.core.tool

import com.wangzan101.mika.core.model.ToolSpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 一个工具发给模型的定义;参数表同时用于生成 schema 和拒绝未知字段。 */
internal class ToolDef(
    val name: String,
    val description: String,
    val props: Map<String, JsonObject> = emptyMap(),
    val required: List<String> = emptyList(),
) {
    val allowed: Set<String> = props.keys + "reason"
    /** 参数里的 reason 是工具自己的字段(比如接管的原因),不是附加的用意说明。 */
    val ownReason = "reason" in props

    /**
     * 发出去的定义。不写 `additionalProperties: false`——每个工具都带一份,合计几百字节,
     * 而未知字段本来就被 [Args] 拒掉,拒的时候还会告诉模型能用哪些,比 schema 里一行声明有用。
     * Gemini 通道会剥掉这个键,少发一次也省得两边不一致。
     */
    fun spec() = ToolSpec(name, description, buildJsonObject {
        put("type", "object")
        put("properties", buildJsonObject {
            props.forEach { (k, v) -> put(k, v) }
            if (!ownReason) put("reason", str(REASON_NOTE))
        })
        put("required", JsonArray(required.map { JsonPrimitive(it) }))
    }.toString())
}

internal fun str(d: String, enum: List<String>? = null) = buildJsonObject {
    put("type", "string"); put("description", d)
    enum?.let { put("enum", JsonArray(it.map(::JsonPrimitive))) }
}

internal fun int(d: String, min: Int? = null, max: Int? = null) = buildJsonObject {
    put("type", "integer"); put("description", d)
    min?.let { put("minimum", it) }; max?.let { put("maximum", it) }
}

internal fun bool(d: String) = buildJsonObject { put("type", "boolean"); put("description", d) }

internal fun strArray(d: String, max: Int) = buildJsonObject {
    put("type", "array"); put("description", d); put("maxItems", max)
    put("items", buildJsonObject { put("type", "string") })
}

/**
 * 每个工具附带的 reason(用意说明)的说法:界面上把它当这一步的说明给用户看,所以和给用户的话一样用用户最近那句话的语言写。
 * 这几句在几十个工具里各带一份,是固定开销里最容易被忽略的一块:能短就短,意思不能丢。
 */
internal const val REASON_NOTE = "Why, in the user's language."

internal const val COORD = "0-999, normalized."
internal const val REF = "@eN from the latest read."
internal const val SNAP = "Its snapshotId; a mismatch returns ref_expired."
