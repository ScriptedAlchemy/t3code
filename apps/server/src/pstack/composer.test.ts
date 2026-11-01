import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  ProjectId,
  ServerSettingsError,
  type SkillContextRecord,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ServerSettings from "../serverSettings.ts";
import { planClaudeSkillDispatch } from "../provider/Drivers/ClaudeSkillDispatch.ts";
import * as PstackPack from "./PstackPack.ts";
import { makeFixture } from "./PstackPack.testkit.ts";

const expandPstackComposer = Effect.fn("PstackComposerTest.expand")(function* (
  input: Parameters<PstackPack.PstackPack["Service"]["expandComposer"]>[0],
  message: Parameters<PstackPack.PstackPack["Service"]["expandComposer"]>[1],
) {
  const pack = yield* PstackPack.PstackPack;
  return yield* pack.expandComposer(input, message);
});

it.layer(NodeServices.layer)("pstack composer", (it) => {
  it.effect(
    "consumes bundled records before native projection while leaving native skills intact",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const pstack: SkillContextRecord = {
          version: 1,
          kind: "skill",
          contextId: ComposerContextId.make("pstack"),
          label: "architect",
          name: "pstack:architect",
        };
        const native: SkillContextRecord = {
          ...pstack,
          contextId: ComposerContextId.make("native"),
          label: "review",
          name: "native:review",
        };
        const result = yield* expandPstackComposer(
          {
            projectId: ProjectId.make("composer-test"),
            text: `${formatComposerContextReference(pstack)} plan ${formatComposerContextReference(native)}`,
            records: [pstack, native],
          },
          { createdBy: "user" },
        ).pipe(Effect.provide(fixture.layer));
        assert.deepEqual(result.records, [native]);
        const text = projectComposerContextForProvider(result);
        assert.include(text, "<t3_pstack>");
        assert.notInclude(text, "$pstack:architect");
        assert.include(text, "native:review");
        assert.equal(
          planClaudeSkillDispatch(
            text,
            new Map([["pstack:architect", { path: "/native/pstack" }]]),
          ),
          undefined,
        );
      }),
  );
  it.effect.each(["$pstack:architect", "/pstack:architect", "pstack:architect"])(
    "consumes leading %s and preserves disabled identity",
    (token) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const input = {
          projectId: ProjectId.make("composer-test"),
          text: `${token} build this`,
          records: [],
        };
        yield* Effect.gen(function* () {
          const expanded = yield* expandPstackComposer(input, { createdBy: "user" });
          assert.isTrue(expanded.text.startsWith("pstack:architect build this\n\n<t3_pstack>"));
          const plain = {
            projectId: ProjectId.make("composer-test"),
            text: "plain text",
            records: [],
          };
          assert.strictEqual(yield* expandPstackComposer(plain, { createdBy: "user" }), plain);
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            pstackEnabled: false,
          });
          assert.strictEqual(yield* expandPstackComposer(input, { createdBy: "user" }), input);
        }).pipe(Effect.provide(Layer.merge(fixture.layer, fixture.settingsLayer)));
      }),
  );
  it.effect.each(["Please $pstack:architect", "pstack:architect", "  /pstack:architect"])(
    "rewrites inline composer mentions, expands several skills once, and leaves unknown names alone",
    (leading) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const input = {
          projectId: ProjectId.make("composer-test"),
          text: `${leading} design this, then $pstack:setup-pstack configure it. $pstack:architect again $pstack:missing`,
          records: [],
        };
        const result = yield* expandPstackComposer(input, { createdBy: "user" }).pipe(
          Effect.provide(fixture.layer),
        );
        assert.isTrue(
          result.text.startsWith(
            `${leading.replace(/[$/]/, "")} design this, then pstack:setup-pstack configure it. pstack:architect again $pstack:missing`,
          ),
        );
        assert.include(result.text, "pstack skill: architect, setup-pstack");
        assert.equal(
          planClaudeSkillDispatch(
            result.text,
            new Map([
              ["pstack:architect", { path: "/native/architect" }],
              ["pstack:setup-pstack", { path: "/native/setup" }],
            ]),
          ),
          undefined,
        );
      }),
  );
  it.effect.each(["models", "pack"] as const)(
    "%s failure preserves the original composer input with an unavailable note",
    (failure) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const record: SkillContextRecord = {
          version: 1,
          kind: "skill",
          contextId: ComposerContextId.make("failure"),
          name: "pstack:architect",
          label: "architect",
        };
        const input = {
          projectId: ProjectId.make("composer-test"),
          text: `/pstack:architect use ${formatComposerContextReference(record)}`,
          records: [record],
        };
        if (failure === "models")
          yield* fs.makeDirectory(`${fixture.stateDir}/pstack/models.md`, { recursive: true });
        else yield* fs.remove(fixture.sourceRoot, { recursive: true });
        const result = yield* expandPstackComposer(input, { createdBy: "user" }).pipe(
          Effect.provide(fixture.layer),
        );
        assert.isTrue(result.text.startsWith(`${input.text}\n\npstack is unavailable: `));
        assert.notInclude(result.text, "<t3_pstack>");
        assert.deepEqual(result.records, input.records);
        assert.lengthOf(result.text.slice(input.text.length).trim().split("\n"), 1);
      }),
  );
  it.effect("settings failures preserve the original input with an unavailable note", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(
        [],
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.fail(
            new ServerSettingsError({
              operation: "read-file",
              settingsPath: "/fixture/settings.json",
            }),
          ),
        }),
      );
      const input = {
        projectId: ProjectId.make("composer-test"),
        text: "$pstack:architect build",
        records: [],
      };
      const result = yield* expandPstackComposer(input, { createdBy: "user" }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.isTrue(result.text.startsWith(`${input.text}\n\npstack is unavailable: `));
      assert.notInclude(result.text, "<t3_pstack>");
    }),
  );
  it.effect("task notifications and orchestrator messages containing pstack are identity", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const input = {
        projectId: ProjectId.make("composer-test"),
        text: "Task result: $pstack:architect was used",
        records: [],
      };
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* expandPstackComposer(input, { createdBy: "agent" }), input);
        assert.strictEqual(yield* expandPstackComposer(input, { createdBy: "system" }), input);
        assert.strictEqual(
          yield* expandPstackComposer(input, {
            createdBy: "user",
            notification: {
              source: { kind: "command" },
              outcome: "completed",
              summary: "Task finished",
            },
          }),
          input,
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});
