export const codexCliFixtureSource = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const mode = process.env.T3_TEST_MODE;
const authPath = path.join(home, "auth.json");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const reply = result => send({ id, result });
  if (method === "initialize") return reply({ userAgent: "codex/0.156.1", codexHome: home, platformFamily: "unix", platformOs: "macos" });
  if (method === "account/login/start") {
    fs.writeFileSync(path.join(home, "launch.json"), JSON.stringify({ params, args: process.argv.slice(2), env: {
      CODEX_HOME: home,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
      ACCESS_TOKEN: process.env.ACCESS_TOKEN ?? null,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,
      T3CODE_CODEX_LAUNCH_ARGS: process.env.T3CODE_CODEX_LAUNCH_ARGS ?? null,
    }}));
    if (mode === "before-response") return;
    const complete = () => {
      if (mode !== "no-account" && mode !== "failure") fs.writeFileSync(authPath, JSON.stringify({ type: "chatgpt", email: process.env.T3_TEST_EMAIL, planType: "plus" }));
      send({ method: "account/login/completed", params: {
        loginId: mode === "missing-id" ? null : "login-1",
        success: mode !== "failure", error: mode === "failure" ? "SECRET_NATIVE_FAILURE" : null,
      }});
    };
    if (mode !== "waiting" && mode !== "after-response" && mode !== "exit-after-start") complete();
    reply(params.type === "chatgpt" ? { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/test" } : { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "TEST-CODE" });
    if (mode === "after-response") setImmediate(complete);
    if (mode === "exit-after-start") setImmediate(() => process.exit(1));
    return;
  }
  if (method === "account/read") return reply({ account: fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : null, requiresOpenaiAuth: true });
  if (method === "account/login/cancel") {
    send({ method: "account/login/completed", params: { loginId: "login-1", success: true } });
    return reply({ status: "canceled" });
  }
  if (method === "account/logout") {
    if (mode !== "logout-stuck") fs.rmSync(authPath, { force: true });
    return reply({});
  }
});
`;
