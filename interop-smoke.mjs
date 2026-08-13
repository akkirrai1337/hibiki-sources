import fs from "node:fs";
import { pathToFileURL } from "node:url";

const modules = [
  ["rust", process.env.ANILIBERTY_WASM_PATH || "aniliberty-wasm/target/wasm32-wasip1/release/aniliberty_wasm.wasm"],
  ["yummy", process.env.YUMMYANIME_WASM_PATH || "yummyanime-wasm/target/wasm32-wasip1/release/yummyanime_wasm.wasm"],
  ["kotlin", "kotlin-wasm-reference/build/compileSync/wasmWasi/main/productionExecutable/kotlin/beakokit-kotlin-wasm-reference.wasm"],
];

const episode = {
  id: "episode-1",
  ordinal: 1,
  name: "Episode 1",
  hls_720: "https://cache.libria.fun/videos/episode-1/720.m3u8",
  duration: 1400,
  opening: { start: 1, stop: 100 },
  ending: { start: null, stop: null },
  hls_1080: "javascript:alert(1)",
};

const release = {
  id: 413,
  name: { main: "Naruto", english: "Naruto", alternative: null },
  year: 2007,
  type: { value: "TV" },
  episodes_total: 1,
  is_ongoing: false,
  description: "Fixture release",
  poster: { src: "/storage/poster.jpg" },
  genres: [{ name: "Action" }],
  episodes: [episode],
};

const yummyTitle = {
  anime_id: 100,
  title: "Yummy fixture",
  title_en: "Yummy Fixture",
  title_orig: "Yummy Fixture Original",
  poster: "//cdn.example/yummy.jpg",
  type: "tv",
  anime_status: "released",
  episodes: { count: 1 },
  description: "Yummy fixture description",
  genres: [{ title: "Action", alias: "action" }],
};

const yummyVideo = {
  number: "1",
  title: "Episode 1",
  iframe_url: "https://player.example/yummy/episode-1",
  data: { dubbing: "Fixture dubbing", player: "Fixture player" },
  video_id: "yummy-video-1",
  skips: { opening: { time: 10, length: 20 } },
};

const yummyInvalidVideo = {
  ...yummyVideo,
  iframe_url: "javascript:alert(1)",
};
const requestedUrls = [];

function hostBody(url, sourceName) {
  requestedUrls.push(url);
  const expectedHost = sourceName === "yummy" ? "api.yani.tv" : sourceName === "rust" ? "anilibria.top" : null;
  if (expectedHost && (new URL(url).protocol !== "https:" || new URL(url).hostname !== expectedHost)) {
    throw new Error(`${sourceName}: request escaped the package host allowlist: ${url}`);
  }
  if (url.includes("http-malformed")) return "{";
  if (url.startsWith("https://api.yani.tv")) {
    if (url.includes("/anime/100/videos")) return JSON.stringify({ response: [yummyInvalidVideo, yummyVideo] });
    if (url.includes("/anime/100")) return JSON.stringify({ response: yummyTitle });
    return JSON.stringify({ response: [yummyTitle] });
  }
  const sourceRelease = sourceName === "rust"
    ? release
    : { ...release, episodes: [{ ...episode, hls_1080: undefined }] };
  if (url.includes("anime/catalog/releases")) return JSON.stringify({ data: [sourceRelease] });
  if (url.includes("anime/releases/")) return JSON.stringify({ data: sourceRelease });
  throw new Error(`Unexpected host URL: ${url}`);
}

function wasiImports(getMemory) {
    return {
      environ_sizes_get: (count, bufferSize) => {
      const memory = getMemory();
      memory.buffer.slice(count, count + 4).fill(0);
      memory.buffer.slice(bufferSize, bufferSize + 4).fill(0);
      return 0;
    },
    environ_get: () => 0,
    fd_write: (fd, iovs, iovsLen, written) => {
      const memory = getMemory();
      new DataView(memory.buffer).setUint32(written, 0, true);
      return 0;
    },
    proc_exit: (code) => { throw new Error(`WASI proc_exit(${code})`); },
    random_get: (pointer, length) => {
      const memory = getMemory();
      new Uint8Array(memory.buffer, pointer, length).fill(0);
      return 0;
    },
  };
}

async function loadModule(name, relativePath) {
  const moduleUrl = /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("/")
    ? pathToFileURL(relativePath)
    : new URL(relativePath, import.meta.url);
  const bytes = fs.readFileSync(moduleUrl);
  let instance;
  const imports = {
    wasi_snapshot_preview1: {},
    host: {
      call(pointer, length) {
        const memory = instance.exports.memory;
        const request = JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)));
        const body = hostBody(request.payload.url, name);
        const response = JSON.stringify({
          requestId: request.requestId,
          payload: { statusCode: request.payload.url.includes("http-500") ? 503 : 200, headers: {}, body },
          errorCode: null,
          errorMessage: null,
          protocolVersion: 1,
        });
        const encoded = new TextEncoder().encode(response);
        const responsePointer = instance.exports.beakokit_alloc(encoded.length);
        new Uint8Array(memory.buffer, responsePointer, encoded.length).set(encoded);
        return (BigInt(responsePointer) << 32n) | BigInt(encoded.length);
      },
    },
  };
  const temporaryMemory = new WebAssembly.Memory({ initial: 32 });
  let activeMemory = temporaryMemory;
  Object.assign(imports.wasi_snapshot_preview1, wasiImports(() => activeMemory));
  const result = await WebAssembly.instantiate(bytes, imports);
  instance = result.instance;
  const memory = instance.exports.memory;
  activeMemory = memory;
  if (memory.buffer.byteLength === 0) memory.grow(1);
  return { name, instance, memory };
}

function callEncoded(module, input) {
  const { instance, memory } = module;
  instance.exports.beakokit_reset();
  const pointer = instance.exports.beakokit_alloc(input.length);
  if (pointer < 0) {
    throw new Error(`${module.name}: allocator returned ${pointer} for ${input.length} bytes with memory ${memory.buffer.byteLength}`);
  }
  const requiredBytes = pointer + input.length - memory.buffer.byteLength;
  if (requiredBytes > 0) memory.grow(Math.ceil(requiredBytes / 65536));
  new Uint8Array(memory.buffer, pointer, input.length).set(input);
  const packed = instance.exports.beakokit_call(pointer, input.length);
  return decodePacked(module, packed);
}

function decodePacked(module, packed) {
  const { instance, memory } = module;
  const responsePointer = Number((packed >> 32n) & 0xffffffffn);
  const responseLength = Number(packed & 0xffffffffn);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, responsePointer, responseLength)));
}

function callInvalidPointer(module) {
  module.instance.exports.beakokit_reset();
  return decodePacked(module, module.instance.exports.beakokit_call(-1, 1));
}

function call(module, operation, payload) {
  const request = JSON.stringify({ requestId: `${module.name}-${operation}`, operation, payload, protocolVersion: 1 });
  return callEncoded(module, new TextEncoder().encode(request));
}

function assertRuntimeError(module, input, expectedMessage) {
  const response = callEncoded(module, new TextEncoder().encode(input));
  assertErrorEnvelope(module.name, response, expectedMessage);
}

function assertErrorEnvelope(name, response, expectedMessage) {
  assertErrorShape(name, response);
  if (!response.errorMessage.includes(expectedMessage)) {
    throw new Error(`${name}: malformed runtime error envelope: ${JSON.stringify(response)}`);
  }
}

function assertErrorRequestId(name, response, operation) {
  const expected = `${name}-${operation}`;
  if (response.requestId !== expected) throw new Error(`${name}: ${operation} error returned requestId '${response.requestId}' instead of '${expected}'`);
}

function assertErrorShape(name, response) {
  if (typeof response.requestId !== "string" || !response.requestId.trim() || response.protocolVersion !== 1 || response.payload !== null || response.errorCode !== "SOURCE_FAILURE" || typeof response.errorMessage !== "string" || !response.errorMessage.trim() || response.errorMessage.length > 1024 || /[\u0000-\u001f\u007f]/.test(response.errorMessage)) {
    throw new Error(`${name}: malformed runtime error envelope: ${JSON.stringify(response)}`);
  }
}

function assertStrictTitleMetadata(name, title, context) {
  if (!title || typeof title !== "object") {
    throw new Error(`${name}: ${context} returned no title metadata`);
  }
  if (!String(title.russianName || title.originalName || title.englishName || "").trim()) {
    throw new Error(`${name}: ${context} has no display title`);
  }
  if (!/^https?:\/\//.test(title.posterUrl || "")) {
    throw new Error(`${name}: ${context} has no usable poster URL`);
  }
  if (!Number.isInteger(title.episodeCount) || title.episodeCount <= 0) {
    throw new Error(`${name}: ${context} has no valid episode count`);
  }
  if (title.availableEpisodeCount !== null && title.availableEpisodeCount !== undefined && (!Number.isInteger(title.availableEpisodeCount) || title.availableEpisodeCount < 0 || title.availableEpisodeCount > title.episodeCount)) {
    throw new Error(`${name}: ${context} has inconsistent available episode count`);
  }
  if (!Array.isArray(title.genres) || title.genres.length === 0 || title.genres.some((genre) => {
    if (typeof genre !== "string" || !genre.trim()) return true;
    return /^[a-z0-9_-]+$/.test(genre.trim());
  })) {
    throw new Error(`${name}: ${context} has missing or service-formatted genres`);
  }
}

function assertCatalogResponse(name, response, limit, context) {
  const items = response.payload?.items;
  if (!Array.isArray(items)) throw new Error(`${name}: ${context} returned no catalog items array`);
  if (items.length > limit) throw new Error(`${name}: ${context} returned ${items.length} items for limit ${limit}`);
  const ids = items.map((item) => item?.id);
  if (ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._~-]+$/.test(id.trim()) || id.trim() === "." || id.trim() === "..")) throw new Error(`${name}: ${context} contains an invalid item id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${name}: ${context} contains duplicate item ids`);
}

function assertResponseIdentity(name, response, operation) {
  const expected = `${name}-${operation}`;
  if (response.requestId !== expected) throw new Error(`${name}: ${operation} returned requestId '${response.requestId}' instead of '${expected}'`);
  if (response.protocolVersion !== 1) throw new Error(`${name}: ${operation} returned unsupported protocol version '${response.protocolVersion}'`);
  if (response.errorCode !== null || response.errorMessage !== null) throw new Error(`${name}: ${operation} returned an error envelope for a successful smoke request`);
  if (!response.payload || typeof response.payload !== "object") throw new Error(`${name}: ${operation} returned no payload`);
}

function assertPlaybackResponse(name, groups, links, episodeCount) {
  const playbackGroups = groups.payload?.groups;
  if (!Array.isArray(playbackGroups) || playbackGroups.length === 0) throw new Error(`${name}: playback returned no groups`);
  const groupIds = playbackGroups.map((group) => group?.id);
  if (groupIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(groupIds).size !== groupIds.length || playbackGroups.some((group) => typeof group.title !== "string" || !group.title.trim())) throw new Error(`${name}: playback groups have invalid ids or titles`);
  for (const group of playbackGroups) {
    if (!Array.isArray(group.episodes) || group.episodes.length === 0) throw new Error(`${name}: playback group ${group.id} has no episodes`);
    const episodeIds = group.episodes.map((episode) => episode?.id);
    if (episodeIds.some((id) => typeof id !== "string" || !id.trim() || id.split("/").some((segment) => !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..")) || new Set(episodeIds).size !== episodeIds.length) throw new Error(`${name}: playback group ${group.id} has invalid or duplicate episode ids`);
    if (group.episodes.some((episode) => typeof episode.number !== "number" || !Number.isFinite(episode.number) || episode.number <= 0 || episode.number > episodeCount)) throw new Error(`${name}: playback group ${group.id} has an invalid episode number`);
  }
  const playerLinks = links.payload?.links;
  if (!Array.isArray(playerLinks) || playerLinks.length === 0 || playerLinks.some((link) => !/^https?:\/\//.test(link?.url || "") || typeof link.type !== "string" || !link.type.trim())) throw new Error(`${name}: playback returned incomplete links`);
  if (new Set(playerLinks.map((link) => link.url)).size !== playerLinks.length) throw new Error(`${name}: playback returned duplicate links`);
}

for (const [name, path] of modules) {
  const module = await loadModule(name, path);
  if (name !== "kotlin") {
    module.instance.exports.beakokit_reset();
    if (module.instance.exports.beakokit_alloc(-1) >= 0 || module.instance.exports.beakokit_alloc(0x7fffffff) >= 0) {
      throw new Error(`${name}: allocator accepted an invalid length`);
    }
    const invalidPointer = callInvalidPointer(module);
    assertErrorEnvelope(name, invalidPointer, "runtime request pointer is invalid");
    assertRuntimeError(
      module,
      JSON.stringify({ requestId: `${name}-oversized`, operation: "SEARCH", payload: { blob: "x".repeat(300 * 1024) } }),
      "runtime request exceeds size limit",
    );
    const hostFailure = call(module, "SEARCH", { query: "http-500", limit: 20, offset: 0 });
    assertErrorEnvelope(name, hostFailure, "503");
    const malformedHostResponse = call(module, "SEARCH", { query: "http-malformed", limit: 20, offset: 0 });
    assertErrorEnvelope(name, malformedHostResponse, "JSON");
    assertErrorEnvelope(name, call(module, "SEARCH", { query: "fixture", limit: 0, offset: 0 }), "pagination limit is out of range");
    assertErrorEnvelope(name, call(module, "SEARCH", { query: "fixture", limit: 20, offset: -1 }), "pagination offset is out of range");
    assertErrorEnvelope(name, call(module, "SEARCH", { query: "fixture", limit: 51, offset: 0 }), "pagination limit is out of range");
    assertErrorEnvelope(name, call(module, "SEARCH", { query: 42, limit: 20, offset: 0 }), "search query must be a string");
    assertErrorEnvelope(name, call(module, "SEARCH", { query: "x".repeat(257), limit: 20, offset: 0 }), "search query is too long");
    assertErrorEnvelope(name, call(module, "SEARCH", { query: "bad\u0000query", limit: 20, offset: 0 }), "search query contains control characters");
    assertErrorEnvelope(name, call(module, "SEARCH", { typeAliases: ["x".repeat(65)] }), "filter field typeAliases item 0 is too long");
    assertErrorEnvelope(name, call(module, "SEARCH", { typeAliases: ["bad\u0000type"] }), "filter field typeAliases item 0 contains control characters");
    assertErrorEnvelope(name, call(module, "SEARCH", { yearFrom: 1899 }), "yearFrom is invalid");
    assertErrorEnvelope(name, call(module, "SEARCH", { yearFrom: 2025, yearTo: 2024 }), "year range is inverted");
  }
  if (name !== "kotlin") {
    assertRuntimeError(module, JSON.stringify({ operation: "SEARCH", payload: {} }), "requestId");
    assertRuntimeError(module, JSON.stringify({ requestId: "x".repeat(129), operation: "SEARCH", payload: {}, protocolVersion: 1 }), "requestId is too long");
    assertRuntimeError(module, JSON.stringify({ requestId: "bad\u0000id", operation: "SEARCH", payload: {}, protocolVersion: 1 }), "control characters");
    assertRuntimeError(module, JSON.stringify({ requestId: `${name}-null-payload`, operation: "SEARCH", payload: null, protocolVersion: 1 }), "payload must be an object");
    assertRuntimeError(module, JSON.stringify({ requestId: `${name}-bad-version`, operation: "SEARCH", payload: {}, protocolVersion: 99 }), "unsupported runtime protocol version");
    assertErrorShape(name, callEncoded(module, new TextEncoder().encode("{")));
    assertErrorShape(name, callEncoded(module, new TextEncoder().encode(JSON.stringify({ requestId: `${name}-unknown`, operation: "UNKNOWN", payload: {}, protocolVersion: 1 }))));
    const missingDetails = call(module, "DETAILS", {});
    assertErrorEnvelope(name, missingDetails, "missing");
    assertErrorRequestId(name, missingDetails, "DETAILS");
    const missingGroups = call(module, "PLAYBACK_GROUPS", {});
    assertErrorEnvelope(name, missingGroups, "missing");
    assertErrorRequestId(name, missingGroups, "PLAYBACK_GROUPS");
    const missingLinks = call(module, "PLAYER_LINKS", {});
    assertErrorEnvelope(name, missingLinks, "missing");
    assertErrorRequestId(name, missingLinks, "PLAYER_LINKS");
    assertErrorEnvelope(name, call(module, "DETAILS", { id: "../invalid-title" }), "invalid");
  }
  const sourceId = name === "yummy" ? "100" : "413";
  const search = call(module, "SEARCH", { query: name === "yummy" ? "fixture" : "naruto", limit: 20, offset: 0 });
  const searchPageTwo = call(module, "SEARCH", { query: name === "yummy" ? "fixture" : "naruto", limit: 20, offset: 20 });
  const searchPageTwoUrl = requestedUrls.at(-1) || "";
  const latest = name === "yummy" ? call(module, "LATEST", { limit: 20, offset: 0 }) : null;
  const details = call(module, "DETAILS", { id: sourceId });
  const groups = call(module, "PLAYBACK_GROUPS", { titleId: sourceId });
  const links = call(module, "PLAYER_LINKS", {
    titleId: sourceId, groupId: sourceId, episodeId: name === "yummy" ? "1" : "episode-1", episodeNumber: 1,
  });
  for (const [operation, response] of [["SEARCH", search], ["SEARCH", searchPageTwo], ["DETAILS", details], ["PLAYBACK_GROUPS", groups], ["PLAYER_LINKS", links]]) {
    assertResponseIdentity(name, response, operation);
  }
  if (latest) {
    assertResponseIdentity(name, latest, "LATEST");
    assertCatalogResponse(name, latest, 20, "latest");
    latest.payload.items.forEach((item, index) => assertStrictTitleMetadata(name, item, `latest item ${index}`));
  }
  if (!search.payload?.items?.length) throw new Error(`${name}: search failed`);
  assertCatalogResponse(name, search, 20, "search");
  search.payload.items.forEach((item, index) => assertStrictTitleMetadata(name, item, `search item ${index}`));
  assertCatalogResponse(name, searchPageTwo, 20, "search page 2");
  searchPageTwo.payload.items.forEach((item, index) => assertStrictTitleMetadata(name, item, `search page 2 item ${index}`));
  if (name === "rust" && !searchPageTwoUrl.includes("page=2")) throw new Error(`${name}: search page 2 did not request page=2: ${searchPageTwoUrl}`);
  if (name === "yummy" && !searchPageTwoUrl.includes("offset=20")) throw new Error(`${name}: search page 2 did not request offset=20: ${searchPageTwoUrl}`);
  assertStrictTitleMetadata(name, details.payload, "details");
  if (details.payload?.id !== sourceId) throw new Error(`${name}: details failed`);
  if (!groups.payload?.groups?.[0]?.episodes?.length) throw new Error(`${name}: groups failed`);
  assertPlaybackResponse(name, groups, links, details.payload.episodeCount);
  const expectedLink = name === "yummy" ? "player.example/yummy" : "720.m3u8";
  if (!links.payload?.links?.[0]?.url?.includes(expectedLink)) throw new Error(`${name}: links failed`);
  console.log(`${name}: SEARCH, DETAILS, PLAYBACK_GROUPS, PLAYER_LINKS passed`);
}
