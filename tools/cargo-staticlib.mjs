import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Cargo's compiler-artifact message identifies the archive for this invocation,
// including an up-to-date (fresh) result. Never choose a leftover archive merely
// because its historical filename exists in target/.
// https://doc.rust-lang.org/cargo/reference/external-tools.html#artifact-messages
export function selectCargoStaticLibrary(output, { manifestPath, targetName }) {
  const artifacts = [];
  let finished = false;
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trimStart().startsWith("{")) continue;
    const message = JSON.parse(line);
    if (message.reason === "build-finished") finished = message.success === true;
    if (message.reason !== "compiler-artifact" ||
        message.target?.name !== targetName ||
        !message.target?.crate_types?.includes("staticlib") ||
        typeof message.manifest_path !== "string" ||
        resolve(message.manifest_path) !== resolve(manifestPath)) continue;
    for (const filename of message.filenames ?? []) {
      if (typeof filename !== "string" || !filename.endsWith(".a")) continue;
      artifacts.push({
        path: resolve(filename),
        packageId: message.package_id,
        targetName,
        fresh: message.fresh === true,
      });
    }
  }
  if (!finished) throw new Error("Cargo did not report a successful completed build");
  if (artifacts.length !== 1) {
    throw new Error(`Cargo must report exactly one ${targetName} static library; found ${artifacts.length}`);
  }
  if (!existsSync(artifacts[0].path)) {
    throw new Error(`Cargo-reported static library is missing: ${artifacts[0].path}`);
  }
  return artifacts[0];
}
