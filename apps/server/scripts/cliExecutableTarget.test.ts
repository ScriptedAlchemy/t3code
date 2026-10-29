import { assert, it } from "@effect/vitest";

import rootPackageJson from "../../../package.json" with { type: "json" };
import { resolveCliExecutableTarget } from "./cliExecutableTarget.ts";

const nodeVersion = rootPackageJson.engines.node;
const windowsHost = {
  enabled: true,
  target: "win-x64",
  nodeVersion,
  hostNodeVersion: nodeVersion,
  hostPlatform: "win32" as const,
  hostArch: "x64" as const,
};

it("reuses pinned host Node for an explicit native Windows target without archive extraction", () => {
  // Fork releases pass --target win-x64 on Windows. Setting tsdown.targets would download the
  // same Node again and invoke PATH's tar on a C: archive path, which GNU tar treats as remote.
  const config = resolveCliExecutableTarget(windowsHost);
  assert.isUndefined(config.targets);
  // tsdown appends .exe on Windows; keep the filename archive packaging already expects.
  assert.equal(config.fileName, "t3-win-x64");
});

it("requires the pinned version for explicit as well as implicit native builds", () => {
  for (const target of [undefined, "win-x64"]) {
    assert.throws(
      () => resolveCliExecutableTarget({ ...windowsHost, target, hostNodeVersion: "25.7.0" }),
      `Native CLI executables must be built with Node ${nodeVersion}`,
    );
  }
});

it("keeps pinned downloads for a foreign platform or architecture", () => {
  for (const host of [
    { hostPlatform: "linux" as const, hostArch: "x64" as const },
    { hostPlatform: "win32" as const, hostArch: "arm64" as const },
  ]) {
    const config = resolveCliExecutableTarget({
      ...windowsHost,
      ...host,
      hostNodeVersion: "25.7.0",
    });
    assert.deepEqual(config, {
      fileName: "t3",
      targets: [{ platform: "win", arch: "x64", nodeVersion }],
    });
  }
});

it("preserves default native names and the Linux ARM64 injection path", () => {
  assert.deepEqual(resolveCliExecutableTarget({ ...windowsHost, target: undefined }), {
    fileName: "t3",
  });
  assert.deepEqual(
    resolveCliExecutableTarget({
      ...windowsHost,
      target: undefined,
      hostPlatform: "linux",
      hostArch: "arm64",
    }),
    { fileName: "t3" },
  );
  assert.throws(
    () => resolveCliExecutableTarget({ ...windowsHost, target: "linux-arm64" }),
    "T3CODE_PACK_EXE_TARGET must be one of",
  );
});
