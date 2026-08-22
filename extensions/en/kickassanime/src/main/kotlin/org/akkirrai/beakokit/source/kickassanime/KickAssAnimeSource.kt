package org.akkirrai.beakokit.source.kickassanime

import org.akkirrai.beakokit.api.AnimeSource
import org.akkirrai.beakokit.api.ConfigurableSource
import org.akkirrai.beakokit.api.HealthCheckSource
import org.akkirrai.beakokit.api.LatestSource
import org.akkirrai.beakokit.api.PlaybackGroup
import org.akkirrai.beakokit.api.PlaybackSource
import org.akkirrai.beakokit.api.SourceCacheTtl
import org.akkirrai.beakokit.api.SourceCapability
import org.akkirrai.beakokit.api.SourceConfigField
import org.akkirrai.beakokit.api.SourceConfigSchema
import org.akkirrai.beakokit.api.SourceConfigValueKind
import org.akkirrai.beakokit.api.SourceContext
import org.akkirrai.beakokit.api.SourceId
import org.akkirrai.beakokit.api.SourceInfo
import org.akkirrai.beakokit.api.SourceLanguage
import org.akkirrai.beakokit.api.SourceOperation
import org.akkirrai.beakokit.model.AnimeSearchFilterCatalog
import org.akkirrai.beakokit.model.AnimeSearchRequest
import org.akkirrai.beakokit.model.AnimeTitle
import org.akkirrai.beakokit.model.CatalogCapabilities
import org.akkirrai.beakokit.model.Episode
import org.akkirrai.beakokit.model.PlayerLink
import org.akkirrai.beakokit.source.kickassanime.internal.KickAssAnimeClient

/** Standalone source-extension entry point, loaded via [org.akkirrai.beakokit.api.SourceExtensionContract]. */
class KickAssAnimeSource(
    context: SourceContext,
) : AnimeSource, LatestSource, PlaybackSource, ConfigurableSource, HealthCheckSource {
    private val execution = context.sourceExecutionPolicy
    private val baseUrl = context.config.value(BASE_URL_KEY)?.trim()?.trimEnd('/')?.takeIf(String::isNotBlank)
        ?: DEFAULT_BASE_URL
    private val client = KickAssAnimeClient(
        client = context.httpClient,
        baseUrl = baseUrl,
        logger = context.logger,
    )

    override val info: SourceInfo = INFO
    override val configSchema: SourceConfigSchema = CONFIG_SCHEMA
    override val catalogCapabilities: CatalogCapabilities
        get() = client.capabilities

    override suspend fun checkHealth() {
        execution.execute(INFO.id, SourceOperation.HEALTH_CHECK) { client.trending(1) }
    }

    override suspend fun search(query: String): List<AnimeTitle> =
        search(AnimeSearchRequest(query = query))

    override suspend fun search(request: AnimeSearchRequest): List<AnimeTitle> =
        execution.execute(INFO.id, SourceOperation.SEARCH, "request:$request", SourceCacheTtl.SEARCH_MILLIS) { client.search(request) }

    override suspend fun getSearchFilterCatalog(): AnimeSearchFilterCatalog =
        execution.execute(INFO.id, SourceOperation.FILTER_CATALOG, "default", SourceCacheTtl.FILTER_CATALOG_MILLIS) { client.getSearchFilterCatalog() }

    override suspend fun latest(limit: Int): List<AnimeTitle> = execution.execute(INFO.id, SourceOperation.LATEST, "limit:$limit", SourceCacheTtl.LATEST_MILLIS) {
        client.latest(page = 1).take(limit)
    }

    override suspend fun getById(id: String): AnimeTitle =
        execution.execute(INFO.id, SourceOperation.DETAILS, id, SourceCacheTtl.DETAILS_MILLIS) { client.getById(id) }

    override suspend fun getPlaybackGroups(title: AnimeTitle): List<PlaybackGroup> = execution.execute(INFO.id, SourceOperation.PLAYBACK_GROUPS, title.id, SourceCacheTtl.PLAYBACK_GROUPS_MILLIS) {
        client.getLanguages(title.id).mapNotNull { language ->
            val episodes = client.getEpisodes(title.id, language)
            if (episodes.isEmpty()) null else PlaybackGroup(
                id = language,
                title = LANGUAGE_LABELS[language] ?: language,
                episodes = episodes,
            )
        }
    }

    override suspend fun getPlayerLinks(
        title: AnimeTitle,
        group: PlaybackGroup,
        episode: Episode,
    ): List<PlayerLink> = execution.execute(INFO.id, SourceOperation.PLAYER_LINKS) {
        client.getPlayerLinks(title.id, episode.id)
    }

    companion object {
        const val BASE_URL_KEY = "base_url"

        val CONFIG_SCHEMA = SourceConfigSchema(
            listOf(SourceConfigField(BASE_URL_KEY, SourceConfigValueKind.HTTPS_URL)),
        )

        private const val DEFAULT_BASE_URL = "https://kaa.lt"

        private val LANGUAGE_LABELS = mapOf(
            "ja-JP" to "Japanese (Sub)",
            "en-US" to "English (Dub)",
            "es-419" to "Spanish (Dub)",
            "ko-KR" to "Korean (Dub)",
            "zh-CN" to "Chinese (Dub)",
        )

        val INFO = SourceInfo(
            id = SourceId("kickassanime"),
            name = "KickAssAnime",
            languages = setOf(SourceLanguage.ENGLISH),
            primaryLanguage = SourceLanguage.ENGLISH,
            website = DEFAULT_BASE_URL,
            iconUrl = "https://www.google.com/s2/favicons?sz=128&domain=kaa.lt",
            capabilities = setOf(
                SourceCapability.LATEST_RELEASES,
                SourceCapability.PLAYBACK,
            ),
        )
    }
}
