export const DEFAULT_UPSTREAM_CORE_URL = "./cores/dolphin/dolphin-core-upstream.js";
export const DISCIO_UPSTREAM_CORE_URL = "./cores/dolphin/dolphin-upstream.js";
export const WORKERFS_MOUNT_DIR = "/workerfs";

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
