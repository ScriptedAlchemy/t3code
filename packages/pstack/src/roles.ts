export interface PstackRoleDefault {
  readonly label: string;
  readonly defaultValue: string;
}

export function parsePstackRoleDefaults(
  setupSkillMarkdown: string,
): ReadonlyArray<PstackRoleDefault> {
  const step = setupSkillMarkdown
    .replaceAll("\r\n", "\n")
    .match(/^### 5\.[^\n]*\n([\s\S]*?)(?=^### |$(?![\s\S]))/m)?.[1];
  const block = step?.match(/^```[^\n]*\n([\s\S]*?)^```/m)?.[1];
  if (block === undefined) return [];
  return block
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^([^#][^:]*):\s*(\S.*)$/);
      if (!match) return [];
      const label = match[1]!.trim();
      const defaultValue = match[2]!.trim();
      return [{ label, defaultValue }];
    });
}
