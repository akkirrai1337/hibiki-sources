import fs from "node:fs";
import { pathToFileURL } from "node:url";

const wasmPath = process.env.ANIMEGO_WASM_PATH
  ? pathToFileURL(process.env.ANIMEGO_WASM_PATH)
  : new URL("./target/wasm32-wasip1/release/animego_wasm.wasm", import.meta.url);
const catalogFixture = fs.readFileSync(new URL("./tests/fixtures/catalog-card.html", import.meta.url), "utf8");
const catalogRatingFixture = catalogFixture.replace(
  "<div class=\"ani-list__item-body\">",
  "<div class=\"ani-list__item-body\"><div class=\"rating-badge\">8,7</div>",
);
const interopDetailsFixture = `
  <h1>Complete interop title</h1>
  <script type="application/ld+json">
    {"@type":"TVSeries","name":"Minimal"}
  </script>
  <script type="application/ld+json">
    {"@type":"TVSeries","name":"Complete interop title","image":"/interop-poster.jpg","genre":["Action"],"numberOfEpisodes":12,"aggregateRating":{"ratingValue":"8.8","ratingCount":12},"productionCompany":{"name":"Interop Studio"}}
  </script>
  <div class="entity-row"><div>Source material</div><div>Manga</div></div>
  <div class="entity__title-synonyms"><ul><li>Interop alias</li></ul></div>
`;
const interopFilterFixture = `
  <select name="type"><option value="tv">TV Series</option></select>
  <select name="status"><option value="released">Released</option></select>
  <select name="genres"><option value="action">Action</option></select>
`;
const interopEpisodesFixture = `
  <button data-episode-id="episode-2" data-number="2" data-title="Episode 2"></button>
  <button data-episode-id="episode-1" data-number="1" data-title="Episode 1"></button>
`;
const interopPlayersFixture = `<a data-video="https://player.example/embed/episode-1" data-provider="Aksor" data-translation="Dub">player</a>`;
const requestedUrls = [];

function responseFor(url) {
  requestedUrls.push(url);
  let body;
  if (url.includes("/search/all") || url.includes("/anime/filter") || /^https:\/\/animego\.me\/anime(?:\/\d+)?(?:\?.*)?$/.test(url)) {
    body = JSON.stringify({ status: "success", data: { content: catalogRatingFixture + interopFilterFixture } });
  } else if (url.includes("/anime/krutoy-uchitel-onidzuka-556")) {
    body = interopDetailsFixture;
  } else if (url.includes("/player/videos/episode-1")) {
    body = interopPlayersFixture;
  } else if (url.includes("/player/556")) {
    body = interopEpisodesFixture;
  } else {
    throw new Error(`Unexpected AnimeGo host URL: ${url}`);
  }
  return body;
}

function wasiImports(getMemory) {
  return {
    environ_sizes_get: (count, bufferSize) => {
      const memory = getMemory();
      new DataView(memory.buffer).setUint32(count, 0, true);
      new DataView(memory.buffer).setUint32(bufferSize, 0, true);
      return 0;
    },
    environ_get: () => 0,
    fd_write: (fd, iovs, iovsLen, written) => {
      const memory = getMemory();
      new DataView(memory.buffer).setUint32(written, 0, true);
      return 0;
    },
    clock_time_get: (clockId, precision, timestamp) => {
      new DataView(getMemory().buffer).setBigUint64(timestamp, 0n, true);
      return 0;
    },
    sched_yield: () => 0,
    proc_exit: (code) => { throw new Error(`WASI proc_exit(${code})`); },
    random_get: (pointer, length) => {
      new Uint8Array(getMemory().buffer, pointer, length).fill(0);
      return 0;
    },
  };
}

async function loadModule() {
  const bytes = fs.readFileSync(wasmPath);
  let instance;
  let activeMemory = new WebAssembly.Memory({ initial: 32 });
  const imports = {
    wasi_snapshot_preview1: {},
    host: {
      call(pointer, length) {
        const memory = instance.exports.memory;
        const request = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)));
        const body = responseFor(request.payload.url);
        const encoded = new TextEncoder().encode(JSON.stringify({
          requestId: request.requestId,
          payload: { statusCode: request.payload.url.includes("http-500") ? 503 : 200, headers: {}, body },
          errorCode: null,
          errorMessage: null,
          protocolVersion: 1,
        }));
        const responsePointer = instance.exports.beakokit_alloc(encoded.length);
        new Uint8Array(memory.buffer, responsePointer, encoded.length).set(encoded);
        return (BigInt(responsePointer) << 32n) | BigInt(encoded.length);
      },
    },
  };
  Object.assign(imports.wasi_snapshot_preview1, wasiImports(() => activeMemory));
  ({ instance } = await WebAssembly.instantiate(bytes, imports));
  activeMemory = instance.exports.memory;
  return instance;
}

function decodePacked(instance, packed) {
  const responsePointer = Number((packed >> 32n) & 0xffffffffn);
  const responseLength = Number(packed & 0xffffffffn);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, responsePointer, responseLength)));
}

function callRaw(instance, input) {
  instance.exports.beakokit_reset();
  const pointer = instance.exports.beakokit_alloc(input.length);
  new Uint8Array(instance.exports.memory.buffer, pointer, input.length).set(input);
  return decodePacked(instance, instance.exports.beakokit_call(pointer, input.length));
}

function call(instance, operation, payload) {
  return callRaw(instance, new TextEncoder().encode(JSON.stringify({
    requestId: `animego-${operation}`,
    operation,
    payload,
    protocolVersion: 1,
  })));
}

function assertCatalogResponse(response, limit, context) {
  const items = response.payload?.items;
  if (!Array.isArray(items)) throw new Error(`${context} returned no catalog items array: ${JSON.stringify(response)}`);
  if (items.length > limit) throw new Error(`${context} returned ${items.length} items for limit ${limit}`);
  const ids = items.map((item) => item?.id);
  if (ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._~-]+$/.test(id.trim()) || id.trim() === "." || id.trim() === "..")) throw new Error(`${context} contains an invalid item id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${context} contains duplicate item ids`);
}

function assertCatalogMetadata(response, context) {
  for (const [index, item] of response.payload.items.entries()) {
    if (!String(item.russianName || item.originalName || item.englishName || "").trim() || !/^https?:\/\//.test(item.posterUrl || "") || !Number.isInteger(item.episodeCount) || item.episodeCount <= 0 || !Array.isArray(item.genres) || item.genres.length === 0 || item.genres.some((genre) => typeof genre !== "string" || !genre.trim() || /^[a-z0-9_-]+$/.test(genre.trim()))) {
      throw new Error(`${context} item ${index} has incomplete metadata: ${JSON.stringify(item)}`);
    }
  }
}

function assertFilterOptions(response, context) {
  for (const field of ["sortOptions", "typeOptions", "statusOptions", "genreOptions"]) {
    const options = response.payload?.[field];
    if (!Array.isArray(options)) throw new Error(`${context} has no ${field} array`);
    const ids = options.map((option) => option?.id);
    if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length || options.some((option) => typeof option?.title !== "string" || !option.title.trim())) {
      throw new Error(`${context} has invalid ${field}: ${JSON.stringify(options)}`);
    }
  }
  const capabilities = response.payload?.capabilities;
  if (!Array.isArray(capabilities?.supportedSorts) || !Array.isArray(capabilities?.supportedFilters)) throw new Error(`${context} has invalid capabilities`);
  const sortIds = new Set(response.payload.sortOptions.map((option) => String(option.id).toUpperCase()));
  if (capabilities.supportedSorts.some((sort) => !sortIds.has(String(sort).toUpperCase()))) throw new Error(`${context} advertises an unavailable sort`);
  const filterOptions = {
    TYPE: response.payload.typeOptions,
    STATUS: response.payload.statusOptions,
    INCLUDED_GENRES: response.payload.genreOptions,
    EXCLUDED_GENRES: response.payload.genreOptions,
  };
  for (const filter of capabilities.supportedFilters) {
    if (filter === "YEAR_RANGE") continue;
    if (!Array.isArray(filterOptions[filter]) || filterOptions[filter].length === 0) throw new Error(`${context} advertises an unavailable filter: ${filter}`);
  }
}

function assertResponseIdentity(response, operation) {
  const expected = `animego-${operation}`;
  if (response.requestId !== expected) throw new Error(`${operation} returned requestId '${response.requestId}' instead of '${expected}'`);
  if (response.protocolVersion !== 1) throw new Error(`${operation} returned unsupported protocol version '${response.protocolVersion}'`);
  if (response.errorCode !== null || response.errorMessage !== null) throw new Error(`${operation} returned an error envelope for a successful smoke request`);
  if (!response.payload || typeof response.payload !== "object") throw new Error(`${operation} returned no payload`);
}

function assertPlaybackResponse(groups, links) {
  const playbackGroups = groups.payload?.groups;
  if (!Array.isArray(playbackGroups) || playbackGroups.length === 0) throw new Error(`PLAYBACK_GROUPS returned no groups: ${JSON.stringify(groups)}`);
  for (const group of playbackGroups) {
    if (!Array.isArray(group.episodes) || group.episodes.length === 0) throw new Error(`PLAYBACK_GROUPS returned an empty group: ${JSON.stringify(groups)}`);
    const ids = group.episodes.map((episode) => episode?.id);
    if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length || group.episodes.some((episode) => typeof episode.number !== "number" || !Number.isFinite(episode.number) || episode.number <= 0)) throw new Error(`PLAYBACK_GROUPS returned invalid episodes: ${JSON.stringify(groups)}`);
  }
  const playerLinks = links.payload?.links;
  if (!Array.isArray(playerLinks) || playerLinks.length === 0 || playerLinks.some((link) => !/^https?:\/\//.test(link?.url || "")) || new Set(playerLinks.map((link) => link.url)).size !== playerLinks.length) throw new Error(`PLAYER_LINKS returned invalid links: ${JSON.stringify(links)}`);
}

function assertErrorEnvelope(response, expectedMessage, context) {
  assertErrorShape(response, context);
  if (response.errorCode !== "SOURCE_FAILURE" || !response.errorMessage.includes(expectedMessage)) {
    throw new Error(`${context} returned a malformed error envelope: ${JSON.stringify(response)}`);
  }
}

function assertErrorShape(response, context) {
  if (typeof response.requestId !== "string" || !response.requestId.trim() || response.protocolVersion !== 1 || response.payload !== null || response.errorCode !== "SOURCE_FAILURE" || typeof response.errorMessage !== "string" || !response.errorMessage.trim() || response.errorMessage.length > 1024 || /[\u0000-\u001f\u007f]/.test(response.errorMessage)) {
    throw new Error(`${context} returned a malformed error envelope: ${JSON.stringify(response)}`);
  }
}

const instance = await loadModule();
instance.exports.beakokit_reset();
if (instance.exports.beakokit_alloc(-1) >= 0 || instance.exports.beakokit_alloc(0x7fffffff) >= 0) throw new Error("allocator accepted an invalid length");
instance.exports.beakokit_reset();
const invalidPointer = decodePacked(instance, instance.exports.beakokit_call(-1, 1));
assertErrorEnvelope(invalidPointer, "runtime request pointer is invalid", "invalid pointer");
const invalidRequest = callRaw(instance, new TextEncoder().encode(JSON.stringify({ operation: "SEARCH", payload: {} })));
assertErrorEnvelope(invalidRequest, "requestId", "invalid request");
assertErrorEnvelope(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "x".repeat(129), operation: "SEARCH", payload: {}, protocolVersion: 1 }))), "requestId is too long", "long request id");
assertErrorEnvelope(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "bad\u0000id", operation: "SEARCH", payload: {}, protocolVersion: 1 }))), "control characters", "control request id");
const oversizedRequest = callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animego-oversized", operation: "SEARCH", payload: { blob: "x".repeat(300 * 1024) }, protocolVersion: 1 })));
assertErrorEnvelope(oversizedRequest, "size limit", "oversized request");
assertErrorEnvelope(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animego-null-payload", operation: "SEARCH", payload: null, protocolVersion: 1 }))), "payload must be an object", "null payload");
assertErrorEnvelope(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animego-bad-version", operation: "SEARCH", payload: {}, protocolVersion: 99 }))), "unsupported runtime protocol version", "unsupported protocol");
assertErrorShape(callRaw(instance, new TextEncoder().encode("{")), "malformed JSON");
assertErrorShape(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animego-unknown", operation: "UNKNOWN", payload: {}, protocolVersion: 1 }))), "unknown operation");
assertErrorEnvelope(call(instance, "DETAILS", { id: "../invalid-title" }), "invalid", "invalid details id");
assertErrorEnvelope(call(instance, "PLAYER_LINKS", { titleId: "fixture-556", episodeId: "../invalid-episode" }), "invalid", "invalid episode id");
assertErrorEnvelope(call(instance, "SEARCH", { typeAliases: "tv" }), "must be an array", "scalar filter");
assertErrorEnvelope(call(instance, "SEARCH", { typeAliases: ["tv", 1] }), "must be a string", "non-string filter");
const hostFailure = call(instance, "SEARCH", { query: "http-500", limit: 20, offset: 0 });
assertErrorEnvelope(hostFailure, "503", "HTTP failure");
const search = call(instance, "SEARCH", { query: "onizuka", limit: 20, offset: 0 });
assertResponseIdentity(search, "SEARCH");
assertCatalogResponse(search, 20, "SEARCH");
assertCatalogMetadata(search, "SEARCH");
if (search.errorCode || search.payload?.items?.[0]?.id !== "krutoy-uchitel-onidzuka-556" || search.payload?.items?.[0]?.ratings?.[0]?.value !== 8.7 || !/^https?:\/\//.test(search.payload.items[0].posterUrl || "") || search.payload.items[0].episodeCount !== 43 || search.payload.items[0].genres?.length !== 1 || search.payload.items[0].genres[0] !== "Комедия") {
  throw new Error(`SEARCH failed: ${JSON.stringify(search)}`);
}
const searchPageTwo = call(instance, "SEARCH", { query: "onizuka", limit: 20, offset: 20 });
assertResponseIdentity(searchPageTwo, "SEARCH");
assertCatalogResponse(searchPageTwo, 20, "SEARCH pagination");
assertCatalogMetadata(searchPageTwo, "SEARCH pagination");
if (searchPageTwo.errorCode || !requestedUrls.at(-1)?.includes("page=2")) {
  throw new Error(`SEARCH pagination failed: url=${requestedUrls.at(-1)} response=${JSON.stringify(searchPageTwo)}`);
}

const yearFiltered = call(instance, "SEARCH", { yearFrom: "2020", yearTo: "2024", limit: 20, offset: 0 });
assertResponseIdentity(yearFiltered, "SEARCH");
assertCatalogResponse(yearFiltered, 20, "YEAR_RANGE");
assertCatalogMetadata(yearFiltered, "YEAR_RANGE");
if (yearFiltered.errorCode || !requestedUrls.at(-1)?.includes("year-from-2020-to-2024")) {
  throw new Error(`YEAR_RANGE failed: url=${requestedUrls.at(-1)} response=${JSON.stringify(yearFiltered)}`);
}

const optionFiltered = call(instance, "SEARCH", {
  includedGenreAliases: ["action"], excludedGenreAliases: ["horror"], typeAliases: ["tv series"], statusAliases: ["released"], limit: 20, offset: 0,
});
assertResponseIdentity(optionFiltered, "SEARCH");
assertCatalogResponse(optionFiltered, 20, "FILTERED SEARCH");
assertCatalogMetadata(optionFiltered, "FILTERED SEARCH");
const filteredUrl = requestedUrls.at(-1) || "";
if (optionFiltered.errorCode || !filteredUrl.includes("genres-is-action-or-!horror") || !filteredUrl.includes("type-is-tv%20series") || !filteredUrl.includes("status-is-released")) {
  throw new Error(`FILTERED SEARCH failed: url=${filteredUrl} response=${JSON.stringify(optionFiltered)}`);
}

for (const sort of ["YEAR", "RATING"]) {
  const sorted = call(instance, "SEARCH", { sort, limit: 20, offset: 0 });
  assertResponseIdentity(sorted, "SEARCH");
  assertCatalogResponse(sorted, 20, `${sort} SEARCH`);
  assertCatalogMetadata(sorted, `${sort} SEARCH`);
  const sortUrl = requestedUrls.at(-1) || "";
  const expectedSort = sort === "YEAR" ? "sort=startDate" : "sort=rating";
  if (sorted.errorCode || !sortUrl.includes(expectedSort)) throw new Error(`${sort} sorting failed: url=${sortUrl} response=${JSON.stringify(sorted)}`);
}

const fallbackSorted = call(instance, "SEARCH", { sort: "UNSUPPORTED", limit: 20, offset: 0 });
assertResponseIdentity(fallbackSorted, "SEARCH");
assertCatalogResponse(fallbackSorted, 20, "fallback SEARCH");
assertCatalogMetadata(fallbackSorted, "fallback SEARCH");
const fallbackUrl = requestedUrls.at(-1) || "";
if (fallbackSorted.errorCode || !fallbackUrl.includes("sort=createdAt") || !fallbackUrl.includes("direction=asc")) {
  throw new Error(`fallback sorting failed: url=${fallbackUrl} response=${JSON.stringify(fallbackSorted)}`);
}

const latestPageTwo = call(instance, "LATEST", { limit: 20, offset: 20 });
assertResponseIdentity(latestPageTwo, "LATEST");
assertCatalogResponse(latestPageTwo, 20, "LATEST pagination");
assertCatalogMetadata(latestPageTwo, "LATEST pagination");
if (latestPageTwo.errorCode || !requestedUrls.at(-1)?.endsWith("/anime/2")) {
  throw new Error(`LATEST pagination failed: url=${requestedUrls.at(-1)} response=${JSON.stringify(latestPageTwo)}`);
}

const filters = call(instance, "FILTER_CATALOG", {});
assertResponseIdentity(filters, "FILTER_CATALOG");
assertFilterOptions(filters, "FILTER_CATALOG");
if (filters.errorCode || filters.payload?.typeOptions?.length !== 1 || filters.payload?.typeOptions?.[0]?.title !== "TV Series" || filters.payload?.genreOptions?.length !== 1 || filters.payload?.genreOptions?.[0]?.title !== "Action") {
  throw new Error(`FILTER_CATALOG failed: ${JSON.stringify(filters)}`);
}

const details = call(instance, "DETAILS", { id: "krutoy-uchitel-onidzuka-556" });
assertResponseIdentity(details, "DETAILS");
if (details.errorCode || details.payload?.id !== "krutoy-uchitel-onidzuka-556" || details.payload?.originalName !== "Complete interop title" || !/^https?:\/\//.test(details.payload?.posterUrl || "") || !Number.isInteger(details.payload?.episodeCount) || details.payload.episodeCount <= 0 || !details.payload?.genres?.length || details.payload.genres.some((genre) => /^[a-z0-9_-]+$/.test(genre)) || details.payload?.ratings?.[0]?.value !== 8.8 || details.payload?.ratings?.[0]?.votes !== 12 || details.payload?.synonyms?.[0] !== "Interop alias" || details.payload?.sourceMaterial !== "Manga" || details.payload?.studios?.[0] !== "Interop Studio") {
  throw new Error(`DETAILS failed: ${JSON.stringify(details)}`);
}

const groups = call(instance, "PLAYBACK_GROUPS", { titleId: "krutoy-uchitel-onidzuka-556" });
assertResponseIdentity(groups, "PLAYBACK_GROUPS");
if (groups.errorCode || groups.payload?.groups?.[0]?.episodes?.[0]?.id !== "episode-1" || groups.payload?.groups?.[0]?.episodes?.[0]?.number !== 1 || groups.payload?.groups?.[0]?.episodes?.[0]?.title !== "Episode 1") {
  throw new Error(`PLAYBACK_GROUPS failed: ${JSON.stringify(groups)}`);
}

const links = call(instance, "PLAYER_LINKS", {
  titleId: "krutoy-uchitel-onidzuka-556",
  groupId: "krutoy-uchitel-onidzuka-556",
  episodeId: "episode-1",
  episodeNumber: 1,
});
assertResponseIdentity(links, "PLAYER_LINKS");
if (links.errorCode || !links.payload?.links?.[0]?.url?.includes("player.example") || links.payload?.links?.[0]?.playerName !== "Aksor" || links.payload?.links?.[0]?.translation !== "Dub") {
  throw new Error(`PLAYER_LINKS failed: ${JSON.stringify(links)}`);
}
assertPlaybackResponse(groups, links);

console.log("AnimeGo package WASM smoke passed: SEARCH, SEARCH_PAGINATION, LATEST_PAGINATION, FILTER_CATALOG, DETAILS, PLAYBACK_GROUPS, PLAYER_LINKS");
