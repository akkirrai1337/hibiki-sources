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
  if (url.includes("/search?q=demo") || url.endsWith("/latest-updated")) return catalogHtml;
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
      const encoded = new TextEncoder().encode(JSON.stringify({ requestId: request.requestId, payload: { statusCode: 200, headers: {}, body }, errorCode: null, errorMessage: null, protocolVersion: 1 }));
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

function assertResponseIdentity(response, operation) {
  const expected = `animepahe-${operation}`;
  if (response.requestId !== expected) throw new Error(`${operation} returned requestId '${response.requestId}' instead of '${expected}'`);
}

const instance = await loadModule();
instance.exports.beakokit_reset();
if (instance.exports.beakokit_alloc(-1) >= 0 || instance.exports.beakokit_alloc(0x7fffffff) >= 0) throw new Error("allocator accepted an invalid length");
instance.exports.beakokit_reset();
const invalidPointer = decodePacked(instance, instance.exports.beakokit_call(-1, 1));
if (invalidPointer.errorMessage !== "runtime request pointer is invalid") throw new Error(`invalid pointer was not rejected: ${JSON.stringify(invalidPointer)}`);
const invalidRequest = callRaw(instance, new TextEncoder().encode(JSON.stringify({ operation: "SEARCH", payload: {} })));
if (invalidRequest.errorCode !== "SOURCE_FAILURE" || !invalidRequest.errorMessage?.includes("requestId")) throw new Error(`invalid request was not rejected: ${JSON.stringify(invalidRequest)}`);
const oversizedRequest = callRaw(instance, new TextEncoder().encode(JSON.stringify({ requestId: "animepahe-oversized", operation: "SEARCH", payload: { blob: "x".repeat(300 * 1024) }, protocolVersion: 1 })));
if (oversizedRequest.errorCode !== "SOURCE_FAILURE" || !oversizedRequest.errorMessage?.includes("size limit")) throw new Error(`oversized request was not rejected: ${JSON.stringify(oversizedRequest)}`);
const search = call(instance, "SEARCH", { query: "demo", limit: 20, offset: 0 });
assertResponseIdentity(search, "SEARCH");
assertCatalogResponse(search, 20, "SEARCH");
if (search.errorCode || search.payload?.items?.[0]?.id !== "demo" || search.payload.items[0].episodeCount !== 12 || !/^https?:\/\//.test(search.payload.items[0].posterUrl || "") || search.payload.items[0].genres?.length !== 1 || search.payload.items[0].genres[0] !== "Action") throw new Error(`SEARCH failed: ${JSON.stringify(search)}`);
const filters = call(instance, "FILTER_CATALOG", {});
assertResponseIdentity(filters, "FILTER_CATALOG");
if (filters.errorCode || filters.payload?.sortOptions?.[0]?.id !== "relevance") throw new Error(`FILTER_CATALOG failed: ${JSON.stringify(filters)}`);
const details = call(instance, "DETAILS", { id: "demo" });
assertResponseIdentity(details, "DETAILS");
if (details.errorCode || details.payload?.id !== "demo" || details.payload?.episodeCount !== 12 || details.payload?.genres?.[0] !== "Action") throw new Error(`DETAILS failed: ${JSON.stringify(details)}`);
const groups = call(instance, "PLAYBACK_GROUPS", { titleId: "demo" });
assertResponseIdentity(groups, "PLAYBACK_GROUPS");
const episodeId = groups.payload?.groups?.[0]?.episodes?.[0]?.id;
if (groups.errorCode || episodeId !== "demo/s1") throw new Error(`PLAYBACK_GROUPS failed: ${JSON.stringify(groups)}`);
const links = call(instance, "PLAYER_LINKS", { episodeId });
assertResponseIdentity(links, "PLAYER_LINKS");
if (links.errorCode || !links.payload?.links?.[0]?.url?.includes("player.example")) throw new Error(`PLAYER_LINKS failed: ${JSON.stringify(links)}`);
console.log("AnimePahe package WASM smoke passed: SEARCH, FILTER_CATALOG, DETAILS, PLAYBACK_GROUPS, PLAYER_LINKS");
