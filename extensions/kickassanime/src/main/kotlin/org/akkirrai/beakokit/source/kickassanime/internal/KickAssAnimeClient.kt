package org.akkirrai.beakokit.source.kickassanime.internal

import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.akkirrai.beakokit.api.SourceErrorKind
import org.akkirrai.beakokit.api.SourceException
import org.akkirrai.beakokit.api.SourceLogLevel
import org.akkirrai.beakokit.api.SourceLogger
import org.akkirrai.beakokit.http.bodyOrThrow
import org.akkirrai.beakokit.model.AnimeSearchFilter
import org.akkirrai.beakokit.model.AnimeSearchFilterCatalog
import org.akkirrai.beakokit.model.AnimeSearchRequest
import org.akkirrai.beakokit.model.AnimeSearchSort
import org.akkirrai.beakokit.model.AnimeTitle
import org.akkirrai.beakokit.model.CatalogCapabilities
import org.akkirrai.beakokit.model.CatalogFeature
import org.akkirrai.beakokit.model.Episode
import org.akkirrai.beakokit.model.PlayerLink
import org.akkirrai.beakokit.model.PlayerType
import org.akkirrai.beakokit.model.SearchFilterOption
import java.util.Base64

/**
 * KickAssAnime's public JSON API. All catalog and episode-listing calls go through the
 * configurable [baseUrl] mirror; search is always served from the primary [SEARCH_BASE_URL]
 * because the other domains are plain redirects with no search index of their own.
 */
internal class KickAssAnimeClient(
    private val client: HttpClient,
    private val baseUrl: String = DEFAULT_BASE_URL,
    private val preferredLanguage: String = DEFAULT_LANGUAGE,
    logger: SourceLogger = SourceLogger.NONE,
) {
    private val apiUrl = "${baseUrl.trimEnd('/')}/api/show"

    val name: String = "KickAssAnime"
    val capabilities = CatalogCapabilities(
        supportedSorts = setOf(AnimeSearchSort.RELEVANCE),
        supportedFilters = setOf(
            AnimeSearchFilter.TYPE,
            AnimeSearchFilter.STATUS,
            AnimeSearchFilter.INCLUDED_GENRES,
            AnimeSearchFilter.YEAR_RANGE,
        ),
        features = setOf(CatalogFeature.LATEST_RELEASES),
    )

    init {
        logger.log(SourceLogLevel.DEBUG, "$name configured with base URL $baseUrl", null)
    }

    suspend fun trending(page: Int): List<AnimeTitle> = requestJson(
        "$apiUrl/trending",
        listOf("page" to page),
    ).let { root ->
        root.asObject()?.array("result").orEmpty().mapNotNull { it.asObject()?.let(::toTitle) }
    }

    suspend fun latest(page: Int): List<AnimeTitle> = requestJson(
        "$apiUrl/recent",
        listOf("type" to "all", "page" to page),
    ).let { root ->
        root.asObject()?.array("result").orEmpty().mapNotNull { it.asObject()?.let(::toTitle) }
    }

    suspend fun search(request: AnimeSearchRequest): List<AnimeTitle> {
        val adapted = capabilities.adapt(request)
        val page = (adapted.offset.coerceAtLeast(0) / adapted.limit.coerceAtLeast(1)) + 1
        val query = adapted.query.trim()
        val encodedFilters = encodeFilters(adapted)
        val root = if (query.isBlank()) {
            requestJson(
                "$SEARCH_BASE_URL/api/anime",
                buildList {
                    add("page" to page)
                    encodedFilters?.let { add("filters" to it) }
                },
            )
        } else {
            requestJsonPost(
                "$SEARCH_BASE_URL/api/fsearch",
                buildJsonObject {
                    put("page", page)
                    put("query", query)
                    encodedFilters?.let { put("filters", it) }
                },
            )
        }
        return root.asObject()?.array("result").orEmpty().mapNotNull { it.asObject()?.let(::toTitle) }
    }

    /** Reference option lists (genres/types/years) served by KickAssAnime for building search filters. */
    suspend fun getSearchFilterCatalog(): AnimeSearchFilterCatalog {
        val root = requestJson("$apiUrl/filters").asObject()
        val genres = root?.array("genres").orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
        val types = root?.array("types").orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
        return AnimeSearchFilterCatalog(
            sortOptions = listOf(SearchFilterOption("relevance", "Relevance")),
            typeOptions = types.map { SearchFilterOption(it, it.replace('_', ' ').uppercase()) },
            statusOptions = STATUS_OPTIONS,
            genreOptions = genres.map { SearchFilterOption(it, it) },
            capabilities = capabilities,
        )
    }

    /** KickAssAnime only accepts a single type/status/year value; the first of each is used. */
    private fun encodeFilters(request: AnimeSearchRequest): String? {
        val body = buildJsonObject {
            request.includedGenreAliases.filter(String::isNotBlank).takeIf(List<String>::isNotEmpty)?.let { genres ->
                put("genres", buildJsonArray { genres.forEach { genre -> add(JsonPrimitive(genre)) } })
            }
            request.typeAliases.firstOrNull(String::isNotBlank)?.let { put("type", it) }
            request.statusAliases.firstOrNull(String::isNotBlank)?.let { put("status", it) }
            request.yearFrom?.let { put("year", it) }
        }
        if (body.isEmpty()) return null
        return Base64.getEncoder().encodeToString(JSON.encodeToString(JsonObject.serializer(), body).encodeToByteArray())
    }

    suspend fun getById(slug: String): AnimeTitle {
        val id = slug.trim().trim('/').takeIf(String::isNotBlank)
            ?: throw SourceException("KickAssAnime slug is blank")
        val root = requestJson("$apiUrl/$id").asObject()
            ?: throw SourceException("KickAssAnime returned an invalid title: $id", kind = SourceErrorKind.PARSE)
        val title = toTitle(root) ?: throw SourceException("KickAssAnime returned an invalid title: $id", kind = SourceErrorKind.PARSE)
        if (title.availableEpisodeCount != null) return title
        // The catalog/details responses never carry an episode count -- only /episodes does,
        // and that's paginated per-language, so it's only worth fetching for a single opened
        // title (not for every catalog card, which would mean one request per item).
        val episodeCount = try {
            val language = getLanguages(id).firstOrNull()
            language?.let { getEpisodes(id, it).size.takeIf { count -> count > 0 } }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            null
        }
        return if (episodeCount != null) title.copy(availableEpisodeCount = episodeCount) else title
    }

    /** Available dub/sub audio languages for a title, e.g. "ja-JP", "en-US". */
    suspend fun getLanguages(slug: String): List<String> = requestJson("$apiUrl/$slug/language")
        .asObject()
        ?.array("result")
        .orEmpty()
        .mapNotNull { it.jsonPrimitive.contentOrNull }
        .ifEmpty { listOf(preferredLanguage) }

    suspend fun getEpisodes(slug: String, language: String): List<Episode> {
        val firstPage = requestJson("$apiUrl/$slug/episodes", listOf("page" to 1, "lang" to language)).asObject()
            ?: return emptyList()
        val pageCount = firstPage.array("pages").orEmpty().size.coerceAtLeast(1)
        val episodes = mutableListOf<JsonObject>()
        firstPage.array("result").orEmpty().mapNotNullTo(episodes) { it.asObject() }
        for (page in 2..pageCount) {
            val nextPage = requestJson("$apiUrl/$slug/episodes", listOf("page" to page, "lang" to language)).asObject()
                ?: continue
            nextPage.array("result").orEmpty().mapNotNullTo(episodes) { it.asObject() }
        }
        return episodes.mapIndexedNotNull { index, item ->
            val episodeSlug = item.string("slug") ?: return@mapIndexedNotNull null
            val episodeString = item.string("episode_string") ?: return@mapIndexedNotNull null
            val number = episodeString.toDoubleOrNull() ?: (index + 1).toDouble()
            Episode(
                id = "ep-$episodeString-$episodeSlug",
                number = number,
                title = item.string("title"),
            )
        }.distinctBy(Episode::id).sortedBy(Episode::number)
    }

    suspend fun getPlayerLinks(slug: String, episodeId: String): List<PlayerLink> {
        val endpoint = "$apiUrl/$slug/episode/$episodeId"
        val root = requestJson(endpoint).asObject() ?: return emptyList()
        // The manifest URL can be scraped straight out of the embed page's HTML (see git
        // history), but its actual video segments are served from a separate, rotating CDN
        // (*.xyz domains) that WAF-blocks any non-browser HTTP client regardless of headers --
        // confirmed by curl and Ktor both getting HTTP 403 on segment fetches while a real
        // browser's fetch() succeeds. So DIRECT_HLS is a dead end here: only a real browser
        // engine can pull the video, hence EMBED + a host-side WebView extractor.
        return root.array("servers").orEmpty().mapNotNull { element ->
            val server = element.asObject() ?: return@mapNotNull null
            val serverName = server.string("name") ?: return@mapNotNull null
            val src = server.string("src") ?: return@mapNotNull null
            PlayerLink(
                url = resolveServerUrl(src),
                type = PlayerType.EMBED,
                quality = null,
                headers = mapOf("Referer" to "$baseUrl/"),
                playerName = serverName,
            )
        }.distinctBy(PlayerLink::url)
    }

    private fun resolveServerUrl(src: String): String = when {
        src.startsWith("http://") || src.startsWith("https://") -> src
        src.startsWith("//") -> "https:$src"
        src.startsWith("/") -> "$baseUrl$src"
        else -> "$baseUrl/$src"
    }

    private fun toTitle(value: JsonObject): AnimeTitle? {
        val slug = value.string("slug") ?: return null
        val title = value.string("title") ?: value.string("title_en") ?: return null
        val posterSlug = value["poster"].asObject()?.string("hq")
        val status = value.string("status")
        return AnimeTitle(
            id = slug,
            russianName = null,
            englishName = value.string("title_en"),
            originalName = title,
            japaneseName = null,
            synonyms = emptyList(),
            year = value.int("year"),
            type = value.string("type"),
            episodeCount = null,
            posterUrl = posterSlug?.let { "$baseUrl/image/poster/$it.webp" },
            status = when (status) {
                "finished_airing" -> "released"
                "currently_airing" -> "ongoing"
                else -> null
            },
            description = value.string("synopsis"),
            genres = value["genres"].asArray().mapNotNull { it.jsonPrimitive.contentOrNull },
            season = value.string("season").toSeason(),
        )
    }

    private suspend fun requestJson(
        url: String,
        parameters: List<Pair<String, Any>> = emptyList(),
    ): JsonElement = client.get(url) {
        parameters.forEach { (key, value) -> parameter(key, value) }
    }.bodyOrThrow(name)

    private suspend fun requestJsonPost(url: String, body: JsonObject): JsonElement = client.post(url) {
        contentType(ContentType.Application.Json)
        setBody(JSON.encodeToString(JsonObject.serializer(), body))
    }.bodyOrThrow(name)

    private fun JsonElement?.asObject(): JsonObject? = this as? JsonObject

    private fun JsonElement?.asArray(): List<JsonElement> = (this as? JsonArray).orEmpty()

    private fun JsonObject.array(key: String): List<JsonElement>? = (get(key) as? JsonArray)

    private fun JsonObject.string(key: String): String? = get(key)
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        ?.takeIf(String::isNotBlank)

    private fun JsonObject.int(key: String): Int? = get(key)?.jsonPrimitive?.intOrNull

    private fun String?.toSeason(): Int? = when (this?.lowercase()) {
        "winter" -> 1
        "spring" -> 2
        "summer" -> 3
        "fall", "autumn" -> 4
        else -> null
    }

    private companion object {
        const val DEFAULT_BASE_URL = "https://kaa.lt"
        const val SEARCH_BASE_URL = "https://kaa.lt"
        const val DEFAULT_LANGUAGE = "ja-JP"
        val JSON = Json { ignoreUnknownKeys = true }
        val STATUS_OPTIONS = listOf(
            SearchFilterOption("finished", "Finished Airing"),
            SearchFilterOption("airing", "Currently Airing"),
        )
    }
}
