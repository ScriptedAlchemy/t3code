// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Maintainer sync runs with only Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { checkPack } from "../src/check.ts";
import { fileFingerprint, type UpstreamManifest } from "../src/files.ts";

const checkoutArgument = process.argv[2];
if (!checkoutArgument) {
  console.error("Usage: node packages/pstack/scripts/sync.ts <pstack-t3code checkout>");
  process.exit(1);
}

const checkout = NodePath.resolve(checkoutArgument);
const source = NodePath.join(checkout, "plugins/pstack");
const packageDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const upstream = NodePath.join(packageDir, "upstream");
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const subtreeHash = git("rev-parse", "HEAD:plugins/pstack");
if (
  git("status", "--porcelain", "--untracked-files=all", "--", "plugins/pstack")
    .split("\n")
    .some((line) => line && !line.endsWith("/.DS_Store"))
) {
  throw new Error(
    "Commit changes to the checkout's plugins/pstack/ before syncing a pinned snapshot.",
  );
}
const plugin: unknown = JSON.parse(
  NodeFS.readFileSync(NodePath.join(source, "plugin.json"), "utf8"),
);
if (
  typeof plugin !== "object" ||
  plugin === null ||
  !("version" in plugin) ||
  typeof plugin.version !== "string"
) {
  throw new Error("plugins/pstack/plugin.json has no version");
}
const paths = git("ls-tree", "-r", "--name-only", "-z", "HEAD:plugins/pstack")
  .split("\0")
  .filter((path) => path && NodePath.basename(path) !== ".DS_Store");
NodeFS.rmSync(upstream, { recursive: true, force: true });
const files: Record<string, { sha256: string; executable: boolean }> = {};
for (const path of paths) {
  const from = NodePath.join(source, path);
  const to = NodePath.join(upstream, path);
  NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
  NodeFS.copyFileSync(from, to);
  NodeFS.chmodSync(to, NodeFS.statSync(from).mode & 0o777);
  files[path] = fileFingerprint(to);
}
const manifest: UpstreamManifest = {
  repository: "https://github.com/ScriptedAlchemy/pstack-t3code",
  commit,
  subtreeHash,
  version: plugin.version,
  files,
};
NodeFS.writeFileSync(
  NodePath.join(packageDir, "UPSTREAM.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const problems = checkPack(packageDir);
for (const problem of problems) console.error(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(
  `pstack ${manifest.version}: ${paths.length} files, subtree ${subtreeHash}; pack checks passed.`,
);
