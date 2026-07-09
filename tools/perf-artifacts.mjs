import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function describeFile(filePath, { hash = true } = {}) {
  if (!filePath) return null;
  const info = await stat(filePath);
  const startedAt = performance.now();
  const sha256 = hash ? await hashFile(filePath) : null;
  return {
    name: path.basename(filePath),
    bytes: info.size,
    sha256,
    hashDurationMs: hash ? Math.round(performance.now() - startedAt) : null,
  };
}

export async function collectRunMetadata({
  root,
  url,
  browserName,
  browserChannel,
  browserVersion,
  browserExecutable,
  headed,
  durationSeconds,
  sampleMs,
  screenshotEverySeconds,
  captureScreenshots,
  showDebugPanel,
  romPath,
  hashRom = true,
  corePath,
  saveStateUrl,
  saveStateAt,
  inputScript,
  sceneLabel,
  startedAt = new Date().toISOString(),
}) {
  const dirtyPaths = (git(root, ["status", "--porcelain=v1"]) || "")
    .split(/\r?\n/)
    .filter(Boolean);
  const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model.trim()).filter(Boolean))];
  const [rom, core] = await Promise.all([
    describeFile(romPath, { hash: hashRom }),
    describeFile(corePath, { hash: true }),
  ]);

  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: null,
    git: {
      commit: git(root, ["rev-parse", "HEAD"]),
      branch: git(root, ["branch", "--show-current"]),
      dirty: dirtyPaths.length > 0,
      dirtyPaths,
    },
    runtime: {
      node: process.version,
      argv: process.argv.slice(1),
    },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModels,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    browser: {
      name: browserName,
      channel: browserChannel || null,
      version: browserVersion || null,
      executable: browserExecutable ? path.basename(browserExecutable) : null,
      headed: Boolean(headed),
    },
    benchmark: {
      url,
      durationSeconds,
      sampleMs,
      screenshotEverySeconds,
      captureScreenshots: Boolean(captureScreenshots),
      showDebugPanel: Boolean(showDebugPanel),
      sceneLabel: sceneLabel || null,
      saveStateUrl: saveStateUrl || null,
      saveStateAt: saveStateUrl ? saveStateAt : null,
      inputScriptSha256: createHash("sha256").update(String(inputScript || "")).digest("hex"),
    },
    artifacts: {
      rom,
      core,
    },
  };
}

export function parseProfileMetrics(helper = "", frameProfile = "") {
  const core = /\bcoreprof\s+xfb_dt:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+decode:([\d.]+)\s+avg:([\d.]+)\s+max:([\d.]+)\s+vo_sync:([\d.]+)\/max([\d.]+)\s+vo_pub:([\d.]+)\/max([\d.]+)\s+vo_total:([\d.]+)\/max([\d.]+)\s+swxfb:([\d.]+)\s+conv:([\d.]+)\s+copy:([\d.]+)/.exec(helper);
  const frame = /\bloop:([\d.]+)\s+pump:([\d.]+)\s+run:([\d.]+)\s+api:([\d.]+)\s+cap:([\d.]+)\s+copy:([\d.]+)\s+present:([\d.]+)\s+draw:([\d.]+)\s+hash:([\d.]+)\s+paced:([\d.]+)\s+copy:([\d.]+)MB\/s\s+cap:(\d+)\s+shown:(\d+)/.exec(frameProfile);
  const number = (match, index) => (match ? Number(match[index]) : null);

  return {
    coreXfbIntervalMs: number(core, 1),
    coreXfbAverageIntervalMs: number(core, 2),
    coreXfbMaxIntervalMs: number(core, 3),
    coreXfbDecodeMs: number(core, 4),
    coreXfbAverageDecodeMs: number(core, 5),
    coreXfbMaxDecodeMs: number(core, 6),
    videoOutputSyncMs: number(core, 7),
    videoOutputMaxSyncMs: number(core, 8),
    videoOutputPublishMs: number(core, 9),
    videoOutputMaxPublishMs: number(core, 10),
    videoOutputTotalMs: number(core, 11),
    videoOutputMaxTotalMs: number(core, 12),
    softwareXfbTotalMs: number(core, 13),
    softwareXfbConvertMs: number(core, 14),
    softwareXfbCopyMs: number(core, 15),
    jsLoopMs: number(frame, 1),
    jsPumpMs: number(frame, 2),
    jsRunMs: number(frame, 3),
    jsApiMs: number(frame, 4),
    jsCaptureMs: number(frame, 5),
    jsCopyMs: number(frame, 6),
    jsPresentMs: number(frame, 7),
    jsDrawMs: number(frame, 8),
    jsHashMs: number(frame, 9),
    jsPacedMs: number(frame, 10),
    jsCopyMegabytesPerSecond: number(frame, 11),
    jsCaptureCount: number(frame, 12),
    jsPresentCount: number(frame, 13),
  };
}

export function recordsToCsv(records) {
  if (!records?.length) return "";
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const lines = [columns.map(csvCell).join(",")];
  for (const record of records) {
    lines.push(columns.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
