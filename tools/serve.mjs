import { spawn } from "node:child_process";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const shouldOpen = args.includes("--open");
const portArgument = args.find((argument) => /^\d+$/.test(argument));
const root = realpathSync(process.cwd());
const preferredPort = Number(process.env.PORT || portArgument || 8080);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

function resolveRequestPath(url) {
  try {
    const rawPath = decodeURIComponent(url.split(/[?#]/, 1)[0]);
    if (rawPath.split(/[/\\]/).some((part) => part.startsWith("."))) return null;
    const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);

    let candidate = realpathSync(join(root, pathname));
    if (statSync(candidate).isDirectory()) candidate = realpathSync(join(candidate, "index.html"));

    const pathFromRoot = relative(root, candidate);
    if (isAbsolute(pathFromRoot) || pathFromRoot.split(sep).some((part) => part.startsWith(".")))
      return null;
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  const filePath = resolveRequestPath(request.url || "/");

  if (!filePath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const contentType = mimeTypes.get(extname(filePath)) ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp"
  });
  createReadStream(filePath).pipe(response);
});

// Open the page in the user's browser. Best effort by design: a failure here
// must not take the server down, because the printed URL still works.
function openInBrowser(url) {
  const command =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No launcher available; the URL above is the fallback.
  }
}

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      listen(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    const address = server.address();
    const url = `http://${host}:${address.port}/`;
    console.log(`wasm-dolphin running at ${url}`);
    console.log("Open it in Chrome, then drag a disc image onto the page.");
    if (shouldOpen) {
      openInBrowser(url);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  listen(preferredPort);
}

export { server, listen };
