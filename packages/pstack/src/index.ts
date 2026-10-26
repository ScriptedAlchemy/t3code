// @effect-diagnostics nodeBuiltinImport:off - Pack inspection is synchronous and independent of the server runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { readManifest } from "./files.ts";

export { parsePstackRoleDefaults, type PstackRoleDefault } from "./roles.ts";

export const PSTACK_SKILL_PREFIX = "pstack:";
export const PSTACK_LAYOUT_VERSION = 2;

const isRuntimePackFile = (packPath: string) => NodePath.posix.basename(packPath) !== ".gitignore";

/** Files relative to a source root containing upstream/, t3-code.md, and UPSTREAM.json. */
export function pstackPackEntries(sourceRoot: string): ReadonlyArray<{
  readonly packPath: string;
  readonly sourcePath: string;
  readonly executable: boolean;
}> {
  const root = NodePath.resolve(sourceRoot);
  return [
    ...Object.entries(readManifest(root).files)
      .filter(([packPath]) => isRuntimePackFile(packPath))
      .map(([packPath, { executable }]) => ({
        packPath,
        sourcePath: NodePath.join(root, "upstream", packPath),
        executable,
      })),
    {
      packPath: "docs/harness/t3-code.md",
      sourcePath: NodePath.join(root, "t3-code.md"),
      executable: false,
    },
    {
      packPath: "UPSTREAM.json",
      sourcePath: NodePath.join(root, "UPSTREAM.json"),
      executable: false,
    },
  ];
}

export function pstackContentHash(
  sourceRoot: string,
  layoutVersion = PSTACK_LAYOUT_VERSION,
): string {
  return NodeCrypto.createHash("sha256")
    .update(`${layoutVersion}:`)
    .update(readManifest(sourceRoot).subtreeHash)
    .update(NodeFS.readFileSync(NodePath.join(sourceRoot, "t3-code.md")))
    .digest("hex")
    .slice(0, 16);
}
