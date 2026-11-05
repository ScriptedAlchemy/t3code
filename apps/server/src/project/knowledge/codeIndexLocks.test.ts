// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem and SQLite fixtures exercise the cross-process lock protocol.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { expect, it } from "vite-plus/test";

import {
  hasLegacyIndexFiles,
  pinPublishedGeneration,
  removeIndexRoot,
  removeLegacyIndexFromCheckout,
  tryLockBuild,
} from "./codeIndexLocks.ts";
import {
  linkCheckoutSources,
  publishGeneration,
  readPublishedGeneration,
  writeIndexedCheckout,
} from "./codeIndexLayout.ts";

it("removes checkout links while preserving a pinned generation and its source files", () => {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-cleanup-"));
  const checkout = NodePath.join(temporary, "checkout");
  const root = NodePath.join(temporary, "index");
  let pin: ReturnType<typeof pinPublishedGeneration> | undefined;
  try {
    NodeFS.mkdirSync(NodePath.join(checkout, "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(checkout, "src/main.ts"), "export const main = 1;");
    NodeFS.writeFileSync(NodePath.join(checkout, "top.ts"), "export const top = 1;");
    writeIndexedCheckout(root, checkout);
    linkCheckoutSources(root, checkout, ["src/main.ts", "top.ts"]);
    publishGeneration(root, 1);
    const generation = NodePath.join(root, ".codegraph-t3-g1");
    NodeFS.mkdirSync(generation);
    NodeFS.writeFileSync(NodePath.join(generation, "codegraph.db"), "index payload");
    pin = pinPublishedGeneration(root);

    removeIndexRoot(root);

    expect(readPublishedGeneration(root)).toBeNull();
    expect(NodeFS.existsSync(generation)).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "src"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "top.ts"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(checkout, "src/main.ts"), "utf8")).toBe(
      "export const main = 1;",
    );
    expect(NodeFS.readFileSync(NodePath.join(checkout, "top.ts"), "utf8")).toBe(
      "export const top = 1;",
    );

    pin.release();
    pin = undefined;
    removeIndexRoot(root);
    expect(NodeFS.existsSync(generation)).toBe(false);
    expect(NodeFS.readdirSync(NodePath.join(root, ".codegraph-t3")).toSorted()).toEqual([
      "build.lock",
      "building.lock",
    ]);
  } finally {
    pin?.release();
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
});

it.each([
  ["external index", removeIndexRoot],
  ["legacy index", removeLegacyIndexFromCheckout],
] as const)("keeps a waiting builder exclusive after %s removal", (_name, remove) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-lock-"));
  let waitingBuilder: NodeSqlite.DatabaseSync | undefined;
  let contender: (() => void) | null = null;
  try {
    publishGeneration(root, 1);
    const generation = NodePath.join(root, ".codegraph-t3-g1");
    NodeFS.mkdirSync(generation);
    NodeFS.writeFileSync(NodePath.join(generation, "codegraph.db"), "index payload");
    waitingBuilder = new NodeSqlite.DatabaseSync(NodePath.join(root, ".codegraph-t3/build.lock"));

    remove(root);
    expect(readPublishedGeneration(root)).toBeNull();
    expect(NodeFS.existsSync(generation)).toBe(false);
    expect(hasLegacyIndexFiles(root)).toBe(false);

    waitingBuilder.exec("PRAGMA journal_mode = OFF; BEGIN EXCLUSIVE;");
    contender = tryLockBuild(root);
    expect(contender).toBeNull();
    waitingBuilder.close();
    waitingBuilder = undefined;
    contender = tryLockBuild(root);
    expect(contender).not.toBeNull();
  } finally {
    contender?.();
    waitingBuilder?.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(!symlinksSupported).each([
  [".codegraph-t3", "build.lock", "published"],
  [".codegraph-t3-g1", "readers.lock", "codegraph.db"],
])("leaves linked locks inside a legacy %s untouched", (directory, lock, marker) => {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-index-link-"));
  const checkout = NodePath.join(temporary, "checkout");
  const target = NodePath.join(temporary, "outside.sqlite");
  const legacy = NodePath.join(checkout, directory);
  try {
    NodeFS.mkdirSync(legacy, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, marker), "untouched");
    NodeFS.symlinkSync(target, NodePath.join(legacy, lock), "file");

    removeLegacyIndexFromCheckout(checkout);

    expect(NodeFS.existsSync(target)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(legacy, marker), "utf8")).toBe("untouched");
    expect(NodeFS.lstatSync(NodePath.join(legacy, lock)).isSymbolicLink()).toBe(true);
    expect(hasLegacyIndexFiles(checkout)).toBe(false);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
});
