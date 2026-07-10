import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function sectionMap(info) {
  return new Map((info.artifacts?.wasmSections ?? []).map((section) => [section.id, section]));
}

export function compareCoreBuildInfo(left, right) {
  const leftSections = sectionMap(left);
  const rightSections = sectionMap(right);
  const section = (id) => ({
    left: leftSections.get(id) ?? null,
    right: rightSections.get(id) ?? null,
    equal: JSON.stringify(leftSections.get(id) ?? null) === JSON.stringify(rightSections.get(id) ?? null)
  });
  const report = {
    schemaVersion: 1,
    sourceEqual: JSON.stringify(left.source) === JSON.stringify(right.source),
    toolchainEqual: JSON.stringify(left.toolchain) === JSON.stringify(right.toolchain),
    wasmExact: left.artifacts?.wasm?.sha256 === right.artifacts?.wasm?.sha256,
    jsNormalizedExact: left.artifacts?.js?.sha256 === right.artifacts?.js?.sha256,
    codeSection: section(10),
    dataSection: section(11)
  };
  report.reproducible = report.sourceEqual && report.toolchainEqual && report.wasmExact &&
    report.jsNormalizedExact && report.codeSection.equal && report.dataSection.equal;
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
