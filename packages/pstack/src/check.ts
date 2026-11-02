// @effect-diagnostics nodeBuiltinImport:off - Pack inspection is synchronous and independent of the server runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileFingerprint, packFiles, readManifest } from "./files.ts";
import { parsePstackRoleDefaults } from "./roles.ts";

// Adapted from cursor/plugins at 99b609a72323b70204eab407c622f436e858e112; native personas and aliases remain valid.
const TERMS = [
  { key: "`Task`", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", re: /AskQuestion/ },
  { key: "todolist", re: /\btodo ?list\b/i },
  { key: "generalPurpose", re: /generalPurpose/ },
  { key: "`readonly: true`", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: '`environment: "cloud"`', re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", re: /run_in_background/ },
  { key: "`resume`", re: /`resume`/ },
  { key: "`file_attachments`", re: /file_attachments/ },
  { key: "claude-", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", re: /\bgrok-\d/ },
  { key: "gpt-", re: /\bgpt-\d/ },
  { key: "pstack-models.mdc", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", re: /\.cursor\/plugins|\.cursor-plugin/ },
  { key: ".cursor/rules/", re: /\.cursor\/rules|always-applied rule/ },
  { key: "agent-transcripts", re: /agent-transcripts|\.cursor\/projects/ },
  {
    key: "Cursor-only features",
    re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent|built-in PR tool/,
  },
];

const T3_TERMS = [
  { key: "/loop", re: /(?<![\w./])\/loop(?![\w/-]|\.[\w./])/ },
  { key: "update_state", re: /\bupdate_state\b/ },
  { key: "watch-pr", re: /\bwatch-pr\b/ },
  { key: "bootstrap", re: /\bbootstrap\b/ },
  { key: "Custom Mode", re: /\bCustom Mode\b/ },
  { key: "create-skill", re: /\bcreate-skill\b/ },
  { key: "cursor-team-kit", re: /\bcursor-team-kit\b/ },
  { key: "harness adapter", re: /docs\/harness\// },
  { key: "fast model suffix", re: /-fast\b/ },
];

export function checkPack(packageDir: string): ReadonlyArray<string> {
  const problems: string[] = [];
  const upstream = NodePath.join(packageDir, "upstream");
  const attempt = <T>(label: string, run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const paths = attempt("upstream", () => packFiles(upstream)) ?? [];
  const manifest = attempt("UPSTREAM.json", () => readManifest(packageDir));
  if (manifest) {
    const actual = new Set(paths);
    for (const path of Object.keys(manifest.files)) {
      if (!actual.has(path)) problems.push(`Missing upstream file: ${path}`);
    }
    for (const path of paths) {
      const expected = manifest.files[path];
      if (!expected) {
        problems.push(`Unrecorded upstream file: ${path}`);
        continue;
      }
      const fingerprint = attempt(path, () => fileFingerprint(NodePath.join(upstream, path)));
      if (!fingerprint) continue;
      if (fingerprint.sha256 !== expected.sha256) problems.push(`Hash mismatch: ${path}`);
      if (fingerprint.executable !== expected.executable)
        problems.push(`Executable flag mismatch: ${path}`);
    }
  }

  const skillTexts = paths
    .filter((path) => path.startsWith("skills/") && path.endsWith(".md"))
    .flatMap((path) => {
      const text = attempt(path, () => NodeFS.readFileSync(NodePath.join(upstream, path), "utf8"));
      if (text === undefined) return [];
      const skill = path.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];
      if (skill) {
        const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        const name = frontmatter
          ?.match(/^name:\s*(.*)$/m)?.[1]
          ?.trim()
          .replace(/^(["'])(.*)\1$/, "$2");
        if (name !== skill)
          problems.push(
            `Frontmatter name mismatch: ${path} has ${JSON.stringify(name ?? "")}, expected ${skill}`,
          );
      }
      return [{ path, text }];
    });
  const setup = skillTexts.find(({ path }) => path === "skills/setup-pstack/SKILL.md");
  const roles = parsePstackRoleDefaults(setup?.text ?? "");
  if (roles.length !== 17) problems.push(`Expected 17 role defaults, found ${roles.length}`);
  if (new Set(roles.map(({ label }) => label)).size !== roles.length)
    problems.push("Duplicate role default labels");

  for (const path of paths) {
    if (/\.(?:png|jpe?g|gif|ico|woff2?|pdf)$/.test(path)) continue;
    const text = attempt(path, () => NodeFS.readFileSync(NodePath.join(upstream, path), "utf8"));
    if (text === undefined) continue;
    for (const [index, line] of text.split("\n").entries()) {
      for (const { key, re } of [...TERMS, ...T3_TERMS]) {
        if (!re.test(line)) continue;
        if (["claude-", "grok-", "gpt-"].includes(key) && path === "skills/setup-pstack/SKILL.md")
          continue;
        // The bundled GitHub reader retains bot protocol names and a status-only verdict helper.
        if (
          path.startsWith("skills/poteto-mode/scripts/watch-pr/") &&
          (key === "watch-pr" ||
            (key === "Cursor-only features" && !re.test(line.replaceAll("Bugbot", ""))))
        )
          continue;
        if (
          key === "watch-pr" &&
          (line.includes("--status-only") || path === "skills/poteto-mode/scripts/package.json")
        )
          continue;
        problems.push(`Non-native term ${key}: ${path}:${index + 1}`);
      }
    }
  }
  return problems;
}
