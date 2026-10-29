// TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
// No linux-arm64: --build-sea output cannot load on 16/64 KiB page kernels, so it builds natively.
const SEA_TARGETS = {
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "win-arm64": { platform: "win", arch: "arm64" },
  "win-x64": { platform: "win", arch: "x64" },
} as const;

/** Select the Node executable embedded by tsdown, retaining the release's exact version pin. */
export function resolveCliExecutableTarget(input: {
  readonly enabled: boolean;
  readonly target: string | undefined;
  readonly nodeVersion: string;
  readonly hostNodeVersion: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly hostArch: NodeJS.Architecture;
}) {
  const target = input.target?.trim();
  if (target && !Object.hasOwn(SEA_TARGETS, target)) {
    throw new Error(
      `T3CODE_PACK_EXE_TARGET must be one of ${Object.keys(SEA_TARGETS).join(", ")}, got "${target}".`,
    );
  }
  const selected = target ? SEA_TARGETS[target as keyof typeof SEA_TARGETS] : undefined;
  const hostPlatform = input.hostPlatform === "win32" ? "win" : input.hostPlatform;
  const native =
    selected === undefined ||
    (selected.platform === hostPlatform && selected.arch === input.hostArch);
  if (input.enabled && native && input.hostNodeVersion !== input.nodeVersion) {
    throw new Error(
      `Native CLI executables must be built with Node ${input.nodeVersion}; running ${input.hostNodeVersion}.`,
    );
  }
  // tsdown downloads every explicit target, including the host. Native builds can embed the
  // pinned running Node directly, avoiding redundant downloads and Windows PATH tar selection.
  // Preserve the explicit target's output name because archive assembly already recognizes it.
  if (native) return { fileName: target ? `t3-${target}` : "t3" };
  return {
    fileName: "t3",
    targets: [{ ...selected!, nodeVersion: input.nodeVersion }],
  };
}
