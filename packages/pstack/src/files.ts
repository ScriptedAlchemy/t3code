// @effect-diagnostics nodeBuiltinImport:off - Pack inspection is synchronous and independent of the server runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export function packFiles(root: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .flatMap((entry) =>
      entry.isDirectory()
        ? packFiles(NodePath.join(root, entry.name)).map((path) => `${entry.name}/${path}`)
        : [entry.name],
    )
    .sort();
}

export function fileFingerprint(path: string) {
  return {
    sha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
    executable: (NodeFS.statSync(path).mode & 0o111) !== 0,
  };
}

export interface UpstreamManifest {
  readonly repository: string;
  readonly commit: string;
  readonly subtreeHash: string;
  readonly version: string;
  readonly files: Readonly<
    Record<string, { readonly sha256: string; readonly executable: boolean }>
  >;
}

export function readManifest(sourceRoot: string): UpstreamManifest {
  const value: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(sourceRoot, "UPSTREAM.json"), "utf8"),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("repository" in value) ||
    typeof value.repository !== "string" ||
    !("commit" in value) ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    !("subtreeHash" in value) ||
    typeof value.subtreeHash !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.subtreeHash) ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("files" in value) ||
    typeof value.files !== "object" ||
    value.files === null ||
    Array.isArray(value.files)
  ) {
    throw new Error("Invalid UPSTREAM.json metadata");
  }
  const files: Record<string, { sha256: string; executable: boolean }> = {};
  for (const [path, entry] of Object.entries(value.files)) {
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof entry !== "object" ||
      entry === null ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !("executable" in entry) ||
      typeof entry.executable !== "boolean"
    ) {
      throw new Error(`Invalid UPSTREAM.json file entry: ${path}`);
    }
    files[path] = { sha256: entry.sha256, executable: entry.executable };
  }
  return {
    repository: value.repository,
    commit: value.commit,
    subtreeHash: value.subtreeHash,
    version: value.version,
    files,
  };
}
