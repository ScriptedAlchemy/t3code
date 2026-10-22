import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: { target: { type: "string" }, out: { type: "string" } },
});
const targets = {
  "aarch64-apple-darwin": ["darwin", "arm64", "libt3_project_memory.dylib"],
  "x86_64-apple-darwin": ["darwin", "x64", "libt3_project_memory.dylib"],
  "aarch64-unknown-linux-gnu": ["linux", "arm64", "libt3_project_memory.so"],
  "x86_64-unknown-linux-gnu": ["linux", "x64", "libt3_project_memory.so"],
  "aarch64-pc-windows-msvc": ["win32", "arm64", "t3_project_memory.dll"],
  "x86_64-pc-windows-msvc": ["win32", "x64", "t3_project_memory.dll"],
};
const target =
  values.target ??
  Object.keys(targets).find(
    (key) => targets[key][0] === process.platform && targets[key][1] === process.arch,
  );
if (!target || !Object.hasOwn(targets, target))
  throw new Error("Unsupported project-memory build target");
const [platform, arch, library] = targets[target];
const result = NodeChildProcess.spawnSync(
  "cargo",
  [
    ...(platform === "win32" && process.platform !== "win32" ? ["xwin"] : []),
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    NodePath.join(root, "Cargo.toml"),
    "--target",
    target,
    "--target-dir",
    NodePath.join(root, "target"),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const out = NodePath.resolve(values.out ?? NodePath.join(root, "build"));
NodeFS.mkdirSync(out, { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(root, "target", target, "release", library),
  NodePath.join(out, `project-memory-${platform}-${arch}.node`),
);
NodeFS.copyFileSync(NodePath.join(root, "LICENSE"), NodePath.join(out, "LICENSE"));
