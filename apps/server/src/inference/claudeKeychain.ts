import { InferenceProxyError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProcessRunner from "../processRunner.ts";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY = "/usr/bin/security";
const ITEM_NOT_FOUND = 44;
// `security -i` reads each command into a 4 KiB line buffer.
const INTERACTIVE_LINE_LIMIT = 4000;

// Claude Code reads and writes this item with /usr/bin/security. Writing it from any
// other binary leaves only that binary in the item's partition list, so every later
// Claude Code read raises a Keychain dialog that nothing answers while the screen is locked.
export const readClaudeKeychain = Effect.fn("ClaudeKeychain.read")(function* (
  username: string,
  service = CLAUDE_KEYCHAIN_SERVICE,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: SECURITY,
    args: ["find-generic-password", "-a", username, "-s", service, "-w"],
  });
  if (result.code === ITEM_NOT_FOUND) return undefined;
  if (result.code !== 0)
    return yield* new InferenceProxyError({
      message: "Could not read Claude credentials in macOS Keychain.",
    });
  return result.stdout.replace(/\n$/, "");
});

export const writeClaudeKeychain = Effect.fn("ClaudeKeychain.write")(function* (
  username: string,
  password: string,
  service = CLAUDE_KEYCHAIN_SERVICE,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const hex = Buffer.from(password, "utf8").toString("hex");
  const line = `add-generic-password -U -a "${username}" -s "${service}" -X ${hex}`;
  // stdin keeps the credential out of the process list when it fits.
  const result = yield* runner.run(
    line.length <= INTERACTIVE_LINE_LIMIT
      ? { command: SECURITY, args: ["-i"], stdin: `${line}\n` }
      : {
          command: SECURITY,
          args: ["add-generic-password", "-U", "-a", username, "-s", service, "-X", hex],
        },
  );
  if (result.code !== 0)
    return yield* new InferenceProxyError({
      message: "Could not update Claude credentials in macOS Keychain.",
    });
});
