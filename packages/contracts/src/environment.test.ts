import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes the additive project knowledge delivery capability without requiring it on older servers", () => {
    const oldServer = {
      ...descriptor,
      capabilities: { ...descriptor.capabilities, projectKnowledge: true },
    };
    expect(decodeDescriptor(oldServer).capabilities).not.toHaveProperty(
      "projectKnowledgeDeliveries",
    );
    for (const supported of [false, true]) {
      expect(
        decodeDescriptor({
          ...oldServer,
          capabilities: { ...oldServer.capabilities, projectKnowledgeDeliveries: supported },
        }).capabilities,
      ).toMatchObject({ projectKnowledge: true, projectKnowledgeDeliveries: supported });
    }
  });

  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});
