export const DEFAULT_UPSTREAM_CORE_URL = "./cores/dolphin/dolphin-core-upstream.js";
export const DEFAULT_UPSTREAM_CORE_SHA256 = "03df79d2eb4be6c1e05d58d79ad4ab9590a9407c19fa5ae70e088401f424af3f";
export const DISCIO_UPSTREAM_CORE_URL = "./cores/dolphin/dolphin-upstream.js";
export const WORKERFS_MOUNT_DIR = "/workerfs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function requestedUpstreamCoreBuild(search = globalThis.location?.search ?? "") {
  const requested = new URLSearchParams(search).get("coreid")?.toLowerCase().replace(/^sha256:/, "") ?? "";
  if (!requested) {
    return {
      coreId: `sha256:${DEFAULT_UPSTREAM_CORE_SHA256}`,
      sha256: DEFAULT_UPSTREAM_CORE_SHA256,
      coreUrl: DEFAULT_UPSTREAM_CORE_URL,
      candidate: false
    };
  }
  if (!SHA256_PATTERN.test(requested)) {
    throw new Error("coreid must be a SHA-256 content hash");
  }
  return {
    coreId: `sha256:${requested}`,
    sha256: requested,
    coreUrl: `./build/core-candidates/${requested}/dolphin-core-upstream.js`,
    candidate: true
  };
}

export async function sha256Hex(bytes) {
  const view = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyUpstreamCoreWasm(coreUrl, expectedSha256, baseUrl = globalThis.location?.href) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) throw new Error("Expected core SHA-256 is invalid");
  const absoluteCoreUrl = new URL(coreUrl, baseUrl).href;
  const wasmUrl = new URL("dolphin-core-upstream.wasm", absoluteCoreUrl).href;
  const response = await fetch(wasmUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Core WASM fetch returned ${response.status}`);
  const wasmBinary = await response.arrayBuffer();
  const actualSha256 = await sha256Hex(wasmBinary);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Core WASM SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return { coreUrl: absoluteCoreUrl, wasmUrl, wasmBinary, sha256: actualSha256 };
}

export function sanitizeDiscFileName(name) {
  const fallback = "disc.iso";
  const normalized = String(name || fallback)
    .replace(/[\\/]/g, "_")
    .replace(/[^a-z0-9._ -]/gi, "_")
    .trim();

  if (!normalized || normalized === "." || normalized === "..") {
    return fallback;
  }

  return normalized;
}

export function workerFsDiscPath(name) {
  return `${WORKERFS_MOUNT_DIR}/${sanitizeDiscFileName(name)}`;
}
