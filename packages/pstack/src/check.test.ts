// @effect-diagnostics nodeBuiltinImport:off - Pack inspection is synchronous and independent of the server runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { checkPack } from "./check.ts";
import { fileFingerprint, packFiles, type UpstreamManifest } from "./files.ts";
import {
  parsePstackRoleDefaults,
  pstackContentHash,
  pstackPackEntries,
  PSTACK_SKILL_PREFIX,
  PSTACK_LAYOUT_VERSION,
} from "./index.ts";

const packageDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pstack-check-"));
  const write = (path: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), text);
  };
  const seal = () => {
    const manifest: UpstreamManifest = {
      repository: "https://github.com/cursor/plugins",
      commit: "a".repeat(40),
      subtreeHash: "b".repeat(40),
      version: "1.0.0",
      files: Object.fromEntries(
        packFiles(NodePath.join(root, "upstream")).map((path) => [
          path,
          fileFingerprint(NodePath.join(root, "upstream", path)),
        ]),
      ),
    };
    write("UPSTREAM.json", `${JSON.stringify(manifest)}\n`);
  };
  write(
    "upstream/skills/setup-pstack/SKILL.md",
    `---\nname: setup-pstack\n---\n### 5. Write the rule\n\n\`\`\`\n---\ndescription: roles\nalwaysApply: true\n---\n# budget: large\n${Array.from({ length: 17 }, (_, index) => `role ${index}: inherit-parent`).join("\n")}\n\`\`\`\n### 6. Confirm\n`,
  );
  write(
    "upstream/docs/harness/claude-code.md",
    "## Tools\n\n| Cursor | Claude Code |\n| --- | --- |\n| `Task` | Agent |\n",
  );
  write("upstream/helper.sh", "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(NodePath.join(root, "upstream/helper.sh"), 0o755);
  write(
    "t3-code.md",
    "## Tools\n\n| Cursor | T3 Code |\n| --- | --- |\n| `Task` | delegate_task |\n| inherit-parent | Omit target. |\n\n[Helper](../../helper.sh)\n",
  );
  seal();
  return {
    root,
    write,
    seal,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("checkPack", () => {
  it("checks the shipped snapshot and adapter", () => {
    expect(checkPack(packageDir)).toEqual([]);
  });

  it("accepts a complete fixture", () => {
    using pack = fixture();
    expect(checkPack(pack.root)).toEqual([]);
  });

  it("reports all missing, extra, modified, and non-executable files", () => {
    using pack = fixture();
    pack.write("upstream/helper.sh", "changed\n");
    NodeFS.chmodSync(NodePath.join(pack.root, "upstream/helper.sh"), 0o644);
    pack.write("upstream/extra.md", "extra\n");
    NodeFS.rmSync(NodePath.join(pack.root, "upstream/docs/harness/claude-code.md"));
    expect(checkPack(pack.root)).toEqual(
      expect.arrayContaining([
        "Missing upstream file: docs/harness/claude-code.md",
        "Unrecorded upstream file: extra.md",
        "Hash mismatch: helper.sh",
        "Executable flag mismatch: helper.sh",
      ]),
    );
  });

  it.each(["missing", "invalid JSON", "invalid metadata", "invalid file entry"])(
    "reports an %s manifest",
    (kind) => {
      using pack = fixture();
      if (kind === "missing") NodeFS.rmSync(NodePath.join(pack.root, "UPSTREAM.json"));
      else if (kind === "invalid JSON") pack.write("UPSTREAM.json", "{");
      else if (kind === "invalid metadata") pack.write("UPSTREAM.json", "{}");
      else {
        const text = NodeFS.readFileSync(NodePath.join(pack.root, "UPSTREAM.json"), "utf8");
        pack.write("UPSTREAM.json", text.replace('"helper.sh"', '"../helper.sh"'));
      }
      expect(checkPack(pack.root).some((problem) => problem.startsWith("UPSTREAM.json:"))).toBe(
        true,
      );
    },
  );

  it("reports missing source and adapter without throwing", () => {
    using pack = fixture();
    NodeFS.rmSync(NodePath.join(pack.root, "upstream"), { recursive: true });
    NodeFS.rmSync(NodePath.join(pack.root, "t3-code.md"));
    const problems = checkPack(pack.root);
    expect(problems.some((problem) => problem.startsWith("upstream:"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("T3 adapter:"))).toBe(true);
    expect(problems).toContain("Expected 17 role defaults, found 0");
  });

  it("requires each skill's frontmatter name to match its folder", () => {
    using pack = fixture();
    pack.write("upstream/skills/wrong/SKILL.md", "---\nname: other\n---\n# Wrong\n");
    pack.seal();
    expect(checkPack(pack.root)).toEqual([
      'Frontmatter name mismatch: skills/wrong/SKILL.md has "other", expected wrong',
    ]);
  });

  it("requires verbatim table keys and headings, not mentions in prose", () => {
    using pack = fixture();
    pack.write(
      "t3-code.md",
      "## Tools changed\n\n`Task`\n\n| Cursor | T3 Code |\n| --- | --- |\n| inherit-parent | Omit target. |\n",
    );
    expect(checkPack(pack.root)).toEqual([
      "Missing adapter table key: `Task`",
      "Missing adapter heading: ## Tools",
    ]);
  });

  it.each([
    "AskQuestion",
    "/loop",
    "update_state",
    "watch-pr",
    "bootstrap",
    "Custom Mode",
    "create-skill",
    "cursor-team-kit",
  ])("requires a row for used term %s", (term) => {
    using pack = fixture();
    pack.write("upstream/skills/setup-pstack/guide.md", `Use ${term}.\n`);
    pack.seal();
    expect(checkPack(pack.root)).toEqual([
      expect.stringContaining(
        `Missing adapter term row: ${term === "AskQuestion" ? "`AskQuestion`" : term}`,
      ),
    ]);
  });

  it("requires 17 distinct role defaults", () => {
    using pack = fixture();
    const path = "upstream/skills/setup-pstack/SKILL.md";
    const original = NodeFS.readFileSync(NodePath.join(pack.root, path), "utf8");
    pack.write(path, original.replace("role 16: inherit-parent\n", ""));
    pack.seal();
    expect(checkPack(pack.root)).toEqual(["Expected 17 role defaults, found 16"]);
    pack.write(path, original.replace("role 16:", "role 15:"));
    pack.seal();
    expect(checkPack(pack.root)).toEqual(["Duplicate role default labels"]);
  });

  it.each([
    ["[missing](missing.md)", "Unresolved adapter link: missing.md"],
    ["[escape](../../../outside.md)", "Adapter link escapes pack: ../../../outside.md"],
    ["[escape](/outside.md)", "Adapter link escapes pack: /outside.md"],
    ["[missing][ref]\n[ref]: missing.md", "Unresolved adapter link: missing.md"],
    ["[bad](bad%ZZ.md)", "Invalid adapter link bad%ZZ.md: URI malformed"],
  ])("rejects an invalid pack link %s", (link, problem) => {
    using pack = fixture();
    pack.write(
      "t3-code.md",
      `${NodeFS.readFileSync(NodePath.join(pack.root, "t3-code.md"), "utf8")}\n${link}\n`,
    );
    expect(checkPack(pack.root)).toEqual([problem]);
  });

  it("accepts pack directories, fragments, external links, and reference links", () => {
    using pack = fixture();
    pack.write(
      "t3-code.md",
      `${NodeFS.readFileSync(NodePath.join(pack.root, "t3-code.md"), "utf8")}\n[dir](../../skills/) [anchor](#tools) [web](https://example.com)\n[helper]: ../../helper.sh#example\n`,
    );
    expect(checkPack(pack.root)).toEqual([]);
  });
});

describe("pack interface", () => {
  it("uses manifest executable flags despite archive modes and keeps T3 files non-executable", () => {
    using pack = fixture();
    NodeFS.chmodSync(NodePath.join(pack.root, "upstream/helper.sh"), 0o644);
    NodeFS.chmodSync(NodePath.join(pack.root, "t3-code.md"), 0o755);
    NodeFS.chmodSync(NodePath.join(pack.root, "UPSTREAM.json"), 0o755);
    const entries = pstackPackEntries(pack.root);
    expect(entries).toContainEqual({
      packPath: "helper.sh",
      sourcePath: NodePath.join(pack.root, "upstream/helper.sh"),
      executable: true,
    });
    expect(entries).toContainEqual({
      packPath: "docs/harness/t3-code.md",
      sourcePath: NodePath.join(pack.root, "t3-code.md"),
      executable: false,
    });
    expect(entries).toContainEqual({
      packPath: "UPSTREAM.json",
      sourcePath: NodePath.join(pack.root, "UPSTREAM.json"),
      executable: false,
    });
    expect(entries).toHaveLength(5);
    expect(PSTACK_SKILL_PREFIX).toBe("pstack:");
  });

  it("keys content by the layout version, upstream subtree and adapter bytes", () => {
    using pack = fixture();
    const hash = pstackContentHash(pack.root);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(pstackContentHash(pack.root)).toBe(hash);
    expect(pstackContentHash(pack.root, PSTACK_LAYOUT_VERSION + 1)).not.toBe(hash);
    const manifest = NodeFS.readFileSync(NodePath.join(pack.root, "UPSTREAM.json"), "utf8");
    pack.write("UPSTREAM.json", manifest.replace("a".repeat(40), "c".repeat(40)));
    expect(pstackContentHash(pack.root)).toBe(hash);
    pack.write("UPSTREAM.json", manifest.replace("b".repeat(40), "d".repeat(40)));
    expect(pstackContentHash(pack.root)).not.toBe(hash);
    pack.write("UPSTREAM.json", manifest);
    pack.write("t3-code.md", "changed adapter");
    expect(pstackContentHash(pack.root)).not.toBe(hash);
  });

  it("derives all roles from upstream step 5, preserving comma-bearing labels", () => {
    const markdown = NodeFS.readFileSync(
      NodePath.join(packageDir, "upstream/skills/setup-pstack/SKILL.md"),
      "utf8",
    );
    const roles = parsePstackRoleDefaults(markdown);
    expect(roles).toHaveLength(17);
    expect(roles[0]).toEqual({
      label: "feature, refactoring",
      defaultValue: "grok-4.7-xhigh-fast",
    });
    expect(roles.find(({ label }) => label === "architect runners")).toEqual({
      label: "architect runners",
      defaultValue: "claude-opus-5-5-xhigh, grok-4.7-xhigh-fast",
    });
    expect(parsePstackRoleDefaults(markdown.replaceAll("\n", "\r\n"))).toEqual(roles);
    expect(parsePstackRoleDefaults("### 4. Other\n```\nignore: value\n```\n")).toEqual([]);
  });
});
