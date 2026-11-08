import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexAppServerArgs, codexExecLaunchArgs } from "./codexLaunchArgs.ts";

const privacyArgs = [
  "analytics.enabled=false",
  "feedback.enabled=false",
  'otel.exporter="none"',
  'otel.trace_exporter="none"',
  'otel.metrics_exporter="none"',
  "otel.log_user_prompt=false",
].flatMap((setting) => ["--config", setting]);

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(
        String.raw`--config model=\"gpt-6.1-sol\" --strict-config -c analytics.enabled=true`,
      ),
      [
        "app-server",
        "--config",
        'model="gpt-6.1-sol"',
        "--strict-config",
        "-c",
        "analytics.enabled=true",
        ...privacyArgs,
      ],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5", ...privacyArgs],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
      ...privacyArgs,
    ]);
  });
});
