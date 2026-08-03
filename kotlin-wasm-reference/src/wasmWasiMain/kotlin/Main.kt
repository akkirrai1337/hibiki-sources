@file:OptIn(
    kotlin.wasm.ExperimentalWasmInterop::class,
    kotlin.wasm.unsafe.UnsafeWasmMemoryApi::class,
)

import kotlin.wasm.WasmExport
import kotlin.wasm.WasmImport
import kotlin.wasm.unsafe.Pointer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private var heapPointer = 4096
private val json = Json { ignoreUnknownKeys = true }

@WasmImport("host", "call")
private external fun hostCall(pointer: Int, length: Int): Long

@WasmExport("beakokit_reset")
fun beakokitReset() {
    heapPointer = 4096
}

@WasmExport("beakokit_alloc")
fun beakokitAlloc(length: Int): Int {
    val pointer = heapPointer
    heapPointer += length.coerceAtLeast(0)
    return pointer
}

@WasmExport("beakokit_call")
fun beakokitCall(pointer: Int, length: Int): Long {
    val requestId = "kotlin-reference"
    val response = runCatching {
        val request = json.parseToJsonElement(readBytes(pointer, length).decodeToString()).jsonObject
        val operation = request["operation"]?.jsonPrimitive?.content ?: error("operation is missing")
        val payload = request["payload"]?.jsonObject ?: error("payload is missing")
        val body = when (operation) {
            "SEARCH" -> search(requestId, payload)
            "DETAILS" -> details(requestId, payload)
            "PLAYBACK_GROUPS" -> playbackGroups(requestId, payload)
            "PLAYER_LINKS" -> playerLinks(requestId, payload)
            else -> error("Unsupported Kotlin reference operation: $operation")
        }
        runtimeSuccess(request["requestId"]?.jsonPrimitive?.content ?: requestId, body)
    }.getOrElse { error ->
        runtimeError(requestId, error.message ?: "Kotlin source failure")
    }
    val responseBytes = response.encodeToByteArray()
    return pack(writeBytes(responseBytes), responseBytes.size)
}

private fun search(requestId: String, payload: JsonObject): JsonObject {
    val query = payload["query"]?.jsonPrimitive?.content.orEmpty()
    val offset = payload["offset"].intValue() ?: 0
    val page = offset / 20 + 1
    val url = "https://anilibria.top/api/v1/anime/catalog/releases?page=$page&limit=20&f[search]=${encodeQuery(query)}"
    val value = http(requestId, url)
    val items = value["data"]?.jsonArray.orEmpty().mapNotNull { it.jsonObject.toTitle() }
    return buildJsonObject { putJsonArray("items") { items.forEach(::add) } }
}

private fun details(requestId: String, payload: JsonObject): JsonObject {
    val id = payload["id"]?.jsonPrimitive?.content ?: error("details id is missing")
    val value = http(requestId, "https://anilibria.top/api/v1/anime/releases/$id")
    return (value["data"] ?: value).jsonObject.toTitle() ?: error("invalid AniLiberty release")
}

private fun playbackGroups(requestId: String, payload: JsonObject): JsonObject {
    val titleId = payload["titleId"].stringValue() ?: error("playback titleId is missing")
    val releaseResponse = http(requestId, "https://anilibria.top/api/v1/anime/releases/$titleId")
    val release = (releaseResponse["data"] ?: releaseResponse).jsonObject
    val episodes = release["episodes"]?.jsonArray.orEmpty().mapNotNull { episode ->
        val value = episode.jsonObject
        val id = value["id"].stringValue() ?: return@mapNotNull null
        val number = value["ordinal"].stringValue()?.toDoubleOrNull() ?: return@mapNotNull null
        if (number <= 0.0) return@mapNotNull null
        buildJsonObject {
            put("id", id)
            put("number", number)
            putNullable("title", value["name"].stringValue())
        }
    }
    return buildJsonObject {
        putJsonArray("groups") {
            if (episodes.isNotEmpty()) add(buildJsonObject {
                put("id", titleId)
                put("title", "AniLiberty")
                put("qualityLabel", "HLS")
                putJsonArray("episodes") { episodes.forEach(::add) }
            })
        }
    }
}

private fun playerLinks(requestId: String, payload: JsonObject): JsonObject {
    val titleId = payload["titleId"].stringValue() ?: error("player links titleId is missing")
    val episodeId = payload["episodeId"].stringValue() ?: error("player links episodeId is missing")
    val releaseResponse = http(requestId, "https://anilibria.top/api/v1/anime/releases/$titleId")
    val release = (releaseResponse["data"] ?: releaseResponse).jsonObject
    val episode = release["episodes"]?.jsonArray.orEmpty().map { it.jsonObject }
        .firstOrNull { it["id"].stringValue() == episodeId }
        ?: error("AniLiberty episode was not found: $episodeId")
    val qualities = listOf(
        "hls_1080" to "1080p", "hls_720" to "720p", "hls_480" to "480p",
        "hls_360" to "360p", "hls_240" to "240p",
    )
    return buildJsonObject {
        putJsonArray("links") {
            qualities.forEach { (field, quality) ->
                episode[field].stringValue()?.takeIf(String::isNotBlank)?.let { url ->
                    add(buildJsonObject {
                        put("url", url)
                        put("type", "DIRECT_HLS")
                        put("quality", quality)
                        putJsonObject("headers") { put("Referer", "https://anilibria.top/") }
                        put("playerName", "AniLiberty")
                        put("translation", "AniLiberty")
                        putJsonArray("segments") { episodeSegments(episode).forEach(::add) }
                        put("videoId", JsonNull)
                    })
                }
            }
        }
    }
}

private fun episodeSegments(episode: JsonObject): List<JsonElement> {
    val duration = episode["duration"].stringValue()?.toLongOrNull()
    return listOf("opening" to "OPENING", "ending" to "ENDING").mapNotNull { (field, type) ->
        val segment = episode[field]?.jsonObject ?: return@mapNotNull null
        val start = segment["start"].stringValue()?.toLongOrNull()?.coerceAtLeast(0) ?: return@mapNotNull null
        val rawEnd = segment["stop"].stringValue()?.toLongOrNull() ?: return@mapNotNull null
        val end = duration?.let { rawEnd.coerceAtMost(it) } ?: rawEnd
        if (end <= start) return@mapNotNull null
        buildJsonObject {
            put("type", type)
            put("startMs", start * 1000)
            put("endMs", end * 1000)
        }
    }
}

private fun http(requestId: String, url: String): JsonObject {
    val request = buildJsonObject {
        put("requestId", "$requestId-http")
        put("operation", "HTTP_REQUEST")
        putJsonObject("payload") {
            put("method", "GET")
            put("url", url)
            putJsonObject("headers") { put("Accept", "application/json") }
            put("body", JsonNull)
            put("timeoutMillis", 30_000)
            put("maxResponseBytes", 8 * 1024 * 1024)
        }
        put("protocolVersion", 1)
    }
    val requestBytes = request.toString().encodeToByteArray()
    val packed = hostCall(writeBytes(requestBytes), requestBytes.size)
    val responsePointer = (packed ushr 32).toInt()
    val responseLength = packed.toInt()
    require(responsePointer >= 0 && responseLength >= 0) { "host HTTP request failed" }
    val response = json.parseToJsonElement(readBytes(responsePointer, responseLength).decodeToString()).jsonObject
    response["errorMessage"].stringValue()?.let { error(it) }
    return response["payload"]?.jsonObject?.get("body")?.jsonPrimitive?.content
        ?.let { json.parseToJsonElement(it).jsonObject }
        ?: error("host HTTP response did not contain a JSON body")
}

private fun JsonObject.toTitle(): JsonObject? {
    val id = this["id"].stringValue() ?: return null
    val names = this["name"]?.jsonObject ?: return null
    val russianName = names["main"].stringValue() ?: return null
    val englishName = names["english"].stringValue()
    val poster = this["poster"]?.jsonObject
    val posterPath = poster?.get("optimized")?.jsonObject?.get("src").stringValue()
        ?: poster?.get("src").stringValue()
    return buildJsonObject {
        put("id", id)
        put("russianName", russianName)
        put("englishName", englishName)
        put("originalName", englishName ?: russianName)
        put("japaneseName", JsonNull)
        putJsonArray("synonyms") {
            names["alternative"].stringValue()
                ?.split(',')?.map(String::trim)?.filter(String::isNotBlank)
                ?.forEach { add(JsonPrimitive(it)) }
        }
        putNullable("year", this@toTitle["year"].intValue())
        putNullable("type", this@toTitle["type"]?.jsonObject?.get("value").stringValue())
        putNullable("episodeCount", this@toTitle["episodes_total"].intValue())
        putNullable("posterUrl", posterPath?.let { if (it.startsWith("http")) it else "https://anilibria.top$it" })
        putNullable("status", this@toTitle["is_ongoing"].booleanValue()?.let { if (it) "ongoing" else "released" })
        putNullable("description", this@toTitle["description"].stringValue())
        put("nextEpisodeAt", JsonNull)
        putJsonArray("genres") {
            this@toTitle["genres"]?.jsonArray.orEmpty().forEach { genre ->
                genre.jsonObject["name"].stringValue()?.let { add(JsonPrimitive(it)) }
            }
        }
        putJsonArray("ratings") { }
        put("ageRating", JsonNull)
        put("viewCount", JsonNull)
        putJsonArray("screenshots") { }
        put("trailer", JsonNull)
        put("sourceMaterial", JsonNull)
        putJsonArray("studios") { }
        putJsonArray("mainCharacters") { }
        putJsonArray("similarAnime") { }
        putJsonArray("franchiseAnime") { }
        putJsonArray("relatedAnime") { }
        put("season", JsonNull)
        put("availableEpisodeCount", JsonNull)
        put("posterFallbackUrl", JsonNull)
    }
}

private fun runtimeSuccess(requestId: String, payload: JsonObject): String = buildJsonObject {
    put("requestId", requestId)
    put("payload", payload)
    put("errorCode", JsonNull)
    put("errorMessage", JsonNull)
    put("protocolVersion", 1)
}.toString()

private fun runtimeError(requestId: String, message: String): String = buildJsonObject {
    put("requestId", requestId)
    put("payload", JsonNull)
    put("errorCode", "SOURCE_FAILURE")
    put("errorMessage", message)
    put("protocolVersion", 1)
}.toString()

private fun readBytes(pointer: Int, length: Int): ByteArray = ByteArray(length.coerceAtLeast(0)) { index ->
    Pointer((pointer + index).toUInt()).loadByte()
}

private fun JsonElement?.stringValue(): String? =
    if (this == null || this is JsonNull) null else jsonPrimitive.content

private fun JsonElement?.intValue(): Int? = stringValue()?.toIntOrNull()

private fun JsonElement?.booleanValue(): Boolean? = stringValue()?.toBooleanStrictOrNull()

private fun JsonObjectBuilder.putNullable(key: String, value: String?) {
    put(key, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun JsonObjectBuilder.putNullable(key: String, value: Int?) {
    put(key, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun writeBytes(bytes: ByteArray): Int {
    val pointer = beakokitAlloc(bytes.size)
    bytes.forEachIndexed { index, byte -> Pointer((pointer + index).toUInt()).storeByte(byte) }
    return pointer
}

private fun pack(pointer: Int, length: Int): Long =
    (pointer.toLong() shl 32) or (length.toLong() and UInt.MAX_VALUE.toLong())

private fun encodeQuery(value: String): String = buildString {
    value.encodeToByteArray().forEach { byte ->
        val unsigned = byte.toInt() and 0xff
        if (unsigned in 0x41..0x5a || unsigned in 0x61..0x7a || unsigned in 0x30..0x39 || unsigned in listOf(0x2d, 0x5f, 0x2e, 0x7e)) {
            append(unsigned.toChar())
        } else {
            append('%')
            append("0123456789ABCDEF"[unsigned ushr 4])
            append("0123456789ABCDEF"[unsigned and 0x0f])
        }
    }
}

@Suppress("UNUSED_VARIABLE")
private fun referenceMemoryApiExample(pointer: Int): Byte {
    return Pointer(pointer.toUInt()).loadByte()
}
