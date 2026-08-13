import fs from "node:fs";
import { pathToFileURL } from "node:url";

const wasmPath = process.env.ANIMEPAHE_WASM_PATH
  ? pathToFileURL(process.env.ANIMEPAHE_WASM_PATH)
  : new URL("./target/wasm32-wasip1/release/animepahe_wasm.wasm", import.meta.url);

const catalogHtml = `<div class="anime-item"><a class="anime-poster" href="/anime/demo"><img src="/poster.jpg"></a><div class="anime-detail"><div class="anime-name"><a href="/anime/demo">Demo</a></div><div class="anime-meta"><span class="anime-type">TV</span><span class="anime-episodes">12 Eps</span><span class="anime-year">2026</span></div><div class="anime-genre"><a>Action</a></div></div></div>`;
const detailsHtml = `<div class="page-detail"><h1>Demo</h1><div class="anime-poster"><img src="/poster.jpg"></div><div class="anime-synopsis">Demo description</div><div class="anime-info"><p><strong>Type:</strong><a>TV</a></p><p><strong>Episode:</strong> 12</p><p><strong>Aired:</strong> Jul 7, 2026</p></div><div class="anime-genre"><a>Action</a></div></div>`;
const episodesJson = JSON.stringify({ data: [{ session: "s1" }] });
const playHtml = `<script>allEpisodes: [{"md5_id":"s1","chapter_number":1,"title":"Episode 1"}], episodesPerDropdown</script>`;
const serversJson = JSON.stringify({ servers: [{ url: "https://player.example/episode-1", name: "Provider" }] });

function hostBody(url) {
  if (url.includes("/search?q=") || url.endsWith("/latest-updated")) return catalogHtml;
  if (url.endsWith("/anime/demo")) return detailsHtml;
  if (url.includes("/viewApi?m=release&id=demo")) return episodesJson;
  if (url.endsWith("/play/demo/s1")) return playHtml;
  if (url.endsWith("/anime/get-servers/s1")) return serversJson;
  throw new Error(`Unexpected AnimePahe host URL: ${url}`);
}

function wasiImports(getMemory) {
  return {
    environ_sizes_get: (count, bufferSize) => {
      const view = new DataView(getMemory().buffer);
      view.setUint32(count, 0, true); view.setUint32(bufferSize, 0, true); return 0;
    },
    environ_get: () => 0,
    fd_write: (fd, iovs, iovsLen, written) => { new DataView(getMemory().buffer).setUint32(written, 0, true); return 0; },
    clock_time_get: (clockId, precision, timestamp) => { new DataView(getMemory().buffer).setBigUint64(timestamp, 0n, true); return 0; },
    sched_yield: () => 0,
    proc_exit: (code) => { throw new Error(`WASI proc_exit(${code})`); },
    random_get: (pointer, length) => { new Uint8Array(getMemory().buffer, pointer, length).fill(0); return 0; },
  };
}

async function loadModule() {
  const bytes = fs.readFileSync(wasmPath);
  let instance;
  let memory = new WebAssembly.Memory({ initial: 32 });
  const imports = {
    wasi_snapshot_preview1: {},
    host: { call(pointer, length) {
      const request = JSON.parse(new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, pointer, length)));
      const body = hostBody(request.payload.url);
      const encoded = new TextEncoder().encode(JSON.stringify({ requestId: request.requestId, payload: { statusCode: request.payload.url.includes("http-500") ? 503 : 200, headers: {}, body }, errorCode: null, errorMessage: null, protocolVersion: 1 }));
      const responsePointer = instance.exports.beakokit_alloc(encoded.length);
      new Uint8Array(instance.exports.memory.buffer, responsePointer, encoded.length).set(encoded);
      return (BigInt(responsePointer) << 32n) | BigInt(encoded.length);
    } },
  };
  Object.assign(imports.wasi_snapshot_preview1, wasiImports(() => memory));
  ({ instance } = await WebAssembly.instantiate(bytes, imports));
  memory = instance.exports.memory;
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
  return callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: `animepahe-${operation}`, operation, payload, protocolVersion: 1 })));
}

function assertCatalogResponse(response, limit, context) {
  const items = response.payload?.items;
  if (!Array.isArray(items)) throw new Error(`${context} returned no catalog items array: ${JSON.stringify(response)}`);
  if (items.length > limit) throw new Error(`${context} returned ${items.length} items for limit ${limit}`);
  const ids = items.map((item) => item?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error(`${context} contains a blank item id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${context} contains duplicate item ids`);
}

function assertCatalogMetadata(response, context) {
  for (const [index, item] of response.payload.items.entries()) {
    if (!/^https?:\/\//.test(item.posterUrl || "") || !Number.isInteger(item.episodeCount) || item.episodeCount <= 0 || !Array.isArray(item.genres) || item.genres.length === 0 || item.genres.some((genre) => typeof genre !== "string" || !genre.trim() || /^[a-z0-9_-]+$/.test(genre.trim()))) {
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
    if (!Array.isArray(filterOptions[filter]) || filterOptions[filter].length === 0) throw new Error(`${context} advertises an unavailable filter: ${filter}`);
  }
}

function assertResponseIdentity(response, operation) {
  const expected = `animepahe-${operation}`;
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
const oversizedRequest = callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animepahe-oversized", operation: "SEARCH", payload: { blob: "x".repeat(300 * 1024) }, protocolVersion: 1 })));
assertErrorEnvelope(oversizedRequest, "size limit", "oversized request");
assertErrorEnvelope(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animepahe-null-payload", operation: "SEARCH", payload: null, protocolVersion: 1 }))), "payload must be an object", "null payload");
assertErrorEnvelope(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animepahe-bad-version", operation: "SEARCH", payload: {}, protocolVersion: 99 }))), "unsupported runtime protocol version", "unsupported protocol");
assertErrorShape(callRaw(instance, new TextEncoder().encode("{")), "malformed JSON");
assertErrorShape(callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animepahe-unknown", operation: "UNKNOWN", payload: {}, protocolVersion: 1 }))), "unknown operation");
assertErrorEnvelope(call(instance, "DETAILS", { id: "../invalid-title" }), "invalid", "invalid details id");
const hostFailure = call(instance, "SEARCH", { query: "http-500", limit: 20, offset: 0 });
assertErrorEnvelope(hostFailure, "503", "HTTP failure");
const search = call(instance, "SEARCH", { query: "demo", limit: 20, offset: 0 });
assertResponseIdentity(search, "SEARCH");
assertCatalogResponse(search, 20, "SEARCH");
assertCatalogMetadata(search, "SEARCH");
if (search.errorCode || search.payload?.items?.[0]?.id !== "demo" || search.payload.items[0].episodeCount !== 12 || !/^https?:\/\//.test(search.payload.items[0].posterUrl || "") || search.payload.items[0].genres?.length !== 1 || search.payload.items[0].genres[0] !== "Action") throw new Error(`SEARCH failed: ${JSON.stringify(search)}`);
const filters = call(instance, "FILTER_CATALOG", {});
assertResponseIdentity(filters, "FILTER_CATALOG");
assertFilterOptions(filters, "FILTER_CATALOG");
if (filters.errorCode || filters.payload?.sortOptions?.[0]?.id !== "relevance") throw new Error(`FILTER_CATALOG failed: ${JSON.stringify(filters)}`);
const details = call(instance, "DETAILS", { id: "demo" });
assertResponseIdentity(details, "DETAILS");
if (details.errorCode || details.payload?.id !== "demo" || !/^https?:\/\//.test(details.payload?.posterUrl || "") || !Number.isInteger(details.payload?.episodeCount) || details.payload.episodeCount <= 0 || !Array.isArray(details.payload?.genres) || details.payload.genres.length === 0 || details.payload.genres.some((genre) => typeof genre !== "string" || !genre.trim() || /^[a-z0-9_-]+$/.test(genre.trim())) || details.payload.genres[0] !== "Action") throw new Error(`DETAILS failed: ${JSON.stringify(details)}`);
const groups = call(instance, "PLAYBACK_GROUPS", { titleId: "demo" });
assertResponseIdentity(groups, "PLAYBACK_GROUPS");
const episodeId = groups.payload?.groups?.[0]?.episodes?.[0]?.id;
if (groups.errorCode || episodeId !== "demo/s1") throw new Error(`PLAYBACK_GROUPS failed: ${JSON.stringify(groups)}`);
const links = call(instance, "PLAYER_LINKS", { episodeId });
assertResponseIdentity(links, "PLAYER_LINKS");
if (links.errorCode || !links.payload?.links?.[0]?.url?.includes("player.example")) throw new Error(`PLAYER_LINKS failed: ${JSON.stringify(links)}`);
assertPlaybackResponse(groups, links);
console.log("AnimePahe package WASM smoke passed: SEARCH, FILTER_CATALOG, DETAILS, PLAYBACK_GROUPS, PLAYER_LINKS");
