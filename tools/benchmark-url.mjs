const INTENTIONAL_BLANK_WGPU_PROBES = new Set([
  "inline-upload",
  "worker-upload",
  "null-drain",
]);

export function buildVisibleHarnessUrl(baseUrl) {
  const url = new URL(baseUrl);
  const requestedProbe = url.searchParams.get("wgpurenderprobe");
  const removedProbe = INTENTIONAL_BLANK_WGPU_PROBES.has(requestedProbe)
    ? requestedProbe
    : null;
  if (removedProbe) url.searchParams.delete("wgpurenderprobe");
  return { url, removedProbe };
}

export function buildPerfScenarioUrl(baseUrl, params = {}) {
  const url = new URL(baseUrl);
  const inheritedProbe = url.searchParams.get("wgpurenderprobe");
  const scenarioOwnsProbe = Object.hasOwn(params, "wgpurenderprobe");
  if (INTENTIONAL_BLANK_WGPU_PROBES.has(inheritedProbe) && !scenarioOwnsProbe) {
    throw new Error(
      `BASE_URL must not inherit wgpurenderprobe=${inheritedProbe}; ` +
      "declare the probe in the benchmark scenario instead"
    );
  }

  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return {
    url,
    uploadProbeMode: INTENTIONAL_BLANK_WGPU_PROBES.has(
      url.searchParams.get("wgpurenderprobe")
    ),
  };
}
