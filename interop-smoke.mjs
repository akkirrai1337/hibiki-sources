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
  episodes_count: 1,
  description: "Yummy fixture description",
  genres: [{ alias: "action" }],
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

function hostBody(url, sourceName) {
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
          payload: { statusCode: 200, headers: {}, body },
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
  if (response.errorCode !== "SOURCE_FAILURE" || !response.errorMessage?.includes(expectedMessage)) {
    throw new Error(`${module.name}: expected runtime error containing '${expectedMessage}'`);
  }
}

for (const [name, path] of modules) {
  const module = await loadModule(name, path);
  if (name !== "kotlin") {
    const invalidPointer = callInvalidPointer(module);
    if (invalidPointer.errorMessage !== "runtime request pointer is invalid") {
      throw new Error(`${name}: invalid pointer was not rejected precisely`);
    }
    assertRuntimeError(
      module,
      JSON.stringify({ requestId: `${name}-oversized`, operation: "SEARCH", payload: { blob: "x".repeat(300 * 1024) } }),
      "runtime request exceeds size limit",
    );
  }
  if (name !== "kotlin") {
    assertRuntimeError(module, JSON.stringify({ operation: "SEARCH", payload: {} }), "requestId");
  }
  const sourceId = name === "yummy" ? "100" : "413";
  const search = call(module, "SEARCH", { query: name === "yummy" ? "fixture" : "naruto", limit: 20, offset: 0 });
  const details = call(module, "DETAILS", { id: sourceId });
  const groups = call(module, "PLAYBACK_GROUPS", { titleId: sourceId });
  const links = call(module, "PLAYER_LINKS", {
    titleId: sourceId, groupId: sourceId, episodeId: name === "yummy" ? "1" : "episode-1", episodeNumber: 1,
  });
  if (!search.payload?.items?.length) throw new Error(`${name}: search failed`);
  if (details.payload?.id !== sourceId) throw new Error(`${name}: details failed`);
  if (!groups.payload?.groups?.[0]?.episodes?.length) throw new Error(`${name}: groups failed`);
  const expectedLink = name === "yummy" ? "player.example/yummy" : "720.m3u8";
  if (!links.payload?.links?.[0]?.url?.includes(expectedLink)) throw new Error(`${name}: links failed`);
  console.log(`${name}: SEARCH, DETAILS, PLAYBACK_GROUPS, PLAYER_LINKS passed`);
}
