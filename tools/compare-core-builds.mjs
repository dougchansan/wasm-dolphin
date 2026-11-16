import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sectionMap(info) {
  return new Map((info.artifacts?.wasmSections ?? []).map((section) => [section.id, section]));
}

function equalPresent(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null &&
    JSON.stringify(left) === JSON.stringify(right);
}

function declaredToolchain(toolchain) {
  if (!toolchain) return null;
  const { observed, ...declared } = toolchain;
  return declared;
}

export function compareCoreBuildInfo(left, right) {
  const leftSections = sectionMap(left);
  const rightSections = sectionMap(right);
  const section = (id) => ({
    left: leftSections.get(id) ?? null,
    right: rightSections.get(id) ?? null,
    equal: JSON.stringify(leftSections.get(id) ?? null) === JSON.stringify(rightSections.get(id) ?? null)
  });
  const leftConfig = left.configure ?? {};
  const rightConfig = right.configure ?? {};
  const informationalConfigFields = new Set(["buildDir", "outputDir", "nagaArtifact"]);
  const configure = Object.fromEntries(
    [...new Set([...Object.keys(leftConfig), ...Object.keys(rightConfig)])].sort().map((field) => [field, {
      left: leftConfig[field] ?? null,
      right: rightConfig[field] ?? null,
      equal: equalPresent(leftConfig[field], rightConfig[field]),
      informational: informationalConfigFields.has(field),
    }])
  );
  const configurationRecorded = ["nagaLibrarySha256", "wasmCompileFlags", "cmakeCacheSha256"]
    .every((field) => leftConfig[field] != null && rightConfig[field] != null);
  const observationsRecorded = [left.toolchain?.observed, right.toolchain?.observed,
    leftConfig.toolchainObserved, rightConfig.toolchainObserved]
    .every((observation) => observation?.schemaVersion === 1 && observation.tools?.emcc);
  const declaredToolchainEqual = equalPresent(declaredToolchain(left.toolchain), declaredToolchain(right.toolchain));
  const observedToolchainEqual = observationsRecorded
    ? equalPresent(left.toolchain.observed, right.toolchain.observed) : null;
  const report = {
    schemaVersion: 2,
    sourceEqual: equalPresent(left.source, right.source),
    declaredToolchainEqual,
    observedToolchainEqual,
    observationsRecorded,
    toolchainEqual: declaredToolchainEqual && observedToolchainEqual === true,
    configure,
    configurationRecorded,
    configurationEqual: configurationRecorded && Object.values(configure)
      .every((field) => field.informational || field.equal),
    wasmExact: equalPresent(left.artifacts?.wasm?.sha256, right.artifacts?.wasm?.sha256),
    jsNormalizedExact: equalPresent(left.artifacts?.js?.sha256, right.artifacts?.js?.sha256),
    codeSection: section(10),
    dataSection: section(11)
  };
  report.artifactParity = report.wasmExact && report.jsNormalizedExact &&
    report.codeSection.equal && report.dataSection.equal;
  report.reproducible = report.sourceEqual && report.toolchainEqual && report.configurationEqual &&
    report.observationsRecorded && report.artifactParity;
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) {
    console.error("Usage: node tools/compare-core-builds.mjs <left.build.json> <right.build.json>");
    process.exit(2);
  }
  const left = JSON.parse(readFileSync(resolve(leftPath), "utf8"));
  const right = JSON.parse(readFileSync(resolve(rightPath), "utf8"));
  const report = compareCoreBuildInfo(left, right);
  console.log(JSON.stringify(report, null, 2));
  if (!report.reproducible) process.exitCode = 1;
}
