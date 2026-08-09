import fs from "node:fs";

const wasmPath = new URL("./target/wasm32-wasip1/release/animego_wasm.wasm", import.meta.url);
const catalogFixture = fs.readFileSync(new URL("./tests/fixtures/catalog-card.html", import.meta.url), "utf8");
const detailsFixture = fs.readFileSync(new URL("./tests/fixtures/details.html", import.meta.url), "utf8");
const filterFixture = `
  <input name="type_tv" data-title="Сериал" value="tv">
  <input name="status_released" data-title="Вышел" value="released">
  <input name="genres_action" data-title="Экшен" value="action">
`;
const episodesFixture = `
  <button data-episode="episode-2" data-episode-number="2" data-episode-title="Episode 2"></button>
  <button data-episode="episode-1" data-episode-number="1" data-episode-title="Episode 1"></button>
`;
const playersFixture = `<a data-player="https://player.example/embed/episode-1" data-provider-title="Aksor" data-translation-title="Артист">player</a>`;

function responseFor(url) {
  let body;
  if (url.includes("/search/all") || url.includes("/anime/filter") || url === "https://animego.me/anime") {
    body = JSON.stringify({ status: "success", data: { content: catalogFixture + filterFixture } });
  } else if (url.includes("/anime/krutoy-uchitel-onidzuka-556")) {
    body = detailsFixture;
  } else if (url.includes("/player/videos/episode-1")) {
    body = playersFixture;
  } else if (url.includes("/player/556")) {
    body = episodesFixture;
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
          payload: { statusCode: 200, headers: {}, body },
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

function call(instance, operation, payload) {
  instance.exports.beakokit_reset();
  const input = new TextEncoder().encode(JSON.stringify({
    requestId: `animego-${operation}`,
    operation,
    payload,
    protocolVersion: 1,
  }));
  const pointer = instance.exports.beakokit_alloc(input.length);
  new Uint8Array(instance.exports.memory.buffer, pointer, input.length).set(input);
  const packed = instance.exports.beakokit_call(pointer, input.length);
  const responsePointer = Number((packed >> 32n) & 0xffffffffn);
  const responseLength = Number(packed & 0xffffffffn);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, responsePointer, responseLength)));
}

const instance = await loadModule();
const search = call(instance, "SEARCH", { query: "onizuka", limit: 20, offset: 0 });
if (search.errorCode || search.payload?.items?.[0]?.id !== "krutoy-uchitel-onidzuka-556") {
  throw new Error(`SEARCH failed: ${JSON.stringify(search)}`);
}

const filters = call(instance, "FILTER_CATALOG", {});
if (filters.errorCode || filters.payload?.typeOptions?.length !== 1 || filters.payload?.genreOptions?.length !== 1) {
  throw new Error(`FILTER_CATALOG failed: ${JSON.stringify(filters)}`);
}

const details = call(instance, "DETAILS", { id: "krutoy-uchitel-onidzuka-556" });
if (details.errorCode || details.payload?.id !== "krutoy-uchitel-onidzuka-556" || details.payload?.episodeCount !== 43) {
  throw new Error(`DETAILS failed: ${JSON.stringify(details)}`);
}

const groups = call(instance, "PLAYBACK_GROUPS", { titleId: "krutoy-uchitel-onidzuka-556" });
if (groups.errorCode || groups.payload?.groups?.[0]?.episodes?.[0]?.id !== "episode-1") {
  throw new Error(`PLAYBACK_GROUPS failed: ${JSON.stringify(groups)}`);
}

const links = call(instance, "PLAYER_LINKS", {
  titleId: "krutoy-uchitel-onidzuka-556",
  groupId: "krutoy-uchitel-onidzuka-556",
  episodeId: "episode-1",
  episodeNumber: 1,
});
if (links.errorCode || !links.payload?.links?.[0]?.url?.includes("player.example")) {
  throw new Error(`PLAYER_LINKS failed: ${JSON.stringify(links)}`);
}

console.log("AnimeGo package WASM smoke passed: SEARCH, FILTER_CATALOG, DETAILS, PLAYBACK_GROUPS, PLAYER_LINKS");
