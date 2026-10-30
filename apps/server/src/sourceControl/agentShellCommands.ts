// Where a shell starts a command, past `NAME=value` assignments and wrappers like `timeout 60`.
// A command anywhere else, as in `echo "gh pr create"`, is text, not a command that runs.
export const COMMAND_START =
  "(?:^|[;&|({`\\n]|\\b(?:do|then|else)\\s)\\s*(?:(?:\\w+=\\S*|env|time|nohup|timeout\\s+\\S+)\\s+)*";
export const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/u;

// Codex runs each command as `/bin/zsh -lc <script>`, quoting the script in pieces such as
// `"a "'`b`'" c"`.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?=["'])([\s\S]*)$/u;
const SHELL_WORD_PIECE = /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])|(\S)/gu;
// Heredoc bodies, quoted strings and comments are text a command carries, not commands it runs.
const HEREDOC_BODY =
  /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n(?:(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/gu;
const QUOTED_OR_COMMENT = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"|(?<=^|[\s;&|(])#[^\n]*/gmu;

/** The script a shell input runs, unwrapped from Codex's `sh -lc`. */
export function shellScript(input: string): string {
  const [, wrapped] = SHELL_WRAPPER.exec(input) ?? [];
  return wrapped === undefined
    ? input
    : Array.from(
        wrapped.matchAll(SHELL_WORD_PIECE),
        ([, double, single, escaped, bare]) =>
          double?.replace(/\\(["\\$`])/gu, "$1") ?? single ?? escaped ?? bare,
      ).join("");
}

/** A script split at command separators that sit outside quotes. */
export function shellSegments(script: string): ReadonlyArray<string> {
  const segments: Array<string> = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? "";
    if (quote !== null) {
      current += char;
      if (char === "\\" && quote === '"') current += script[++index] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === "\\") {
      current += char + (script[++index] ?? "");
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || char === ";" || char === "|" || char === "\n") {
      segments.push(current);
      current = "";
      if (pair === "&&" || pair === "||") index++;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** The commands a script runs, without the text it carries. */
export const shellCode = (script: string) =>
  script.replace(HEREDOC_BODY, "<<").replace(QUOTED_OR_COMMENT, "''");
