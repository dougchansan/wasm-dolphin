// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawnSync } from "node:child_process";

const MAX_SIGNED_INTPTR_MASK = 0x7fff_ffff_ffff_ffffn;

export function parseWindowsCpuAffinityMask(value, platform = process.platform) {
  const text = String(value ?? "").trim();
  if (!text) return { enabled: false, requestedMask: null };
  if (platform !== "win32") {
    throw new Error("PERF_CPU_AFFINITY_MASK is supported only on Windows");
  }
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) {
    throw new Error(
      `Invalid PERF_CPU_AFFINITY_MASK "${text}"; use a non-zero decimal or 0x-prefixed hexadecimal mask`
    );
  }
  const mask = BigInt(text);
  if (mask === 0n || mask > MAX_SIGNED_INTPTR_MASK) {
    throw new Error(
      `Invalid PERF_CPU_AFFINITY_MASK "${text}"; mask must be between 1 and 0x${MAX_SIGNED_INTPTR_MASK.toString(16)}`
    );
  }
  return { enabled: true, requestedMask: `0x${mask.toString(16)}` };
}

export async function launchWithWindowsCpuAffinity(
  launch,
  configuration,
  {
    platform = process.platform,
    processId = process.pid,
    runPowerShell = runAffinityPowerShell,
  } = {}
) {
  const parsed = typeof configuration === "object" && configuration !== null
    ? configuration
    : parseWindowsCpuAffinityMask(configuration, platform);
  const identity = {
    enabled: parsed.enabled,
    requested: parsed.enabled ? { processId, mask: parsed.requestedMask } : null,
    snapshot: null,
    applied: null,
    restored: null,
  };
  if (!parsed.enabled) {
    return { value: await launch(), cpuAffinity: identity };
  }
  if (platform !== "win32") {
    throw new Error("PERF_CPU_AFFINITY_MASK is supported only on Windows");
  }

  const originalMask = normalizeObservedMask(await runPowerShell("read", { processId }));
  identity.snapshot = { processId, mask: originalMask };
  let value;
  let launchError = null;
  try {
    const appliedMask = normalizeObservedMask(await runPowerShell("set", {
      processId,
      mask: parsed.requestedMask,
    }));
    if (appliedMask !== parsed.requestedMask) {
      throw new Error(
        `PERF_CPU_AFFINITY_MASK was not applied: requested ${parsed.requestedMask}, observed ${appliedMask}`
      );
    }
    identity.applied = { processId, mask: appliedMask };
    value = await launch();
  } catch (error) {
    launchError = error;
  }

  let restoreError = null;
  try {
    const restoredMask = normalizeObservedMask(await runPowerShell("set", {
      processId,
      mask: originalMask,
    }));
    if (restoredMask !== originalMask) {
      throw new Error(
        `Benchmark parent affinity was not restored: expected ${originalMask}, observed ${restoredMask}`
      );
    }
    identity.restored = { processId, mask: restoredMask };
  } catch (error) {
    restoreError = error;
  }

  if (restoreError) {
    await value?.browser?.close?.().catch(() => {});
    const suffix = launchError ? `; launch also failed: ${launchError.message}` : "";
    throw new Error(`${restoreError.message}${suffix}`, { cause: restoreError });
  }
  if (launchError) throw launchError;
  return { value, cpuAffinity: identity };
}

function normalizeObservedMask(value) {
  const parsed = parseWindowsCpuAffinityMask(value, "win32");
  if (!parsed.enabled) throw new Error("Windows returned an empty process affinity mask");
  return parsed.requestedMask;
}

function runAffinityPowerShell(operation, { processId, mask }) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error(`Invalid benchmark parent process id: ${processId}`);
  }
  const setStatement = operation === "set"
    ? `$mask=[Int64]::Parse('${mask.slice(2)}',[Globalization.NumberStyles]::HexNumber,[Globalization.CultureInfo]::InvariantCulture);$p.ProcessorAffinity=[IntPtr]::new($mask);$p.Refresh();`
    : "";
  if (operation !== "read" && operation !== "set") {
    throw new Error(`Unsupported process affinity operation: ${operation}`);
  }
  const script = [
    "$ErrorActionPreference='Stop';",
    `$p=Get-Process -Id ${processId};`,
    setStatement,
    "$value=[UInt64]$p.ProcessorAffinity.ToInt64();",
    "[Console]::Out.Write(('0x{0:x}' -f $value));",
  ].join("");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `& { ${script} }`],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.error) {
    throw new Error(`Unable to ${operation} Windows process affinity: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`Unable to ${operation} Windows process affinity: ${detail}`);
  }
  return String(result.stdout).trim();
}
