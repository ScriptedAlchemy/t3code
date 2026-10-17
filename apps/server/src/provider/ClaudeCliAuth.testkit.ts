export const claudeCliFixtureSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = process.env.T3_TEST_MODE;
if (args.includes('--version')) { process.stdout.write('2.1.302 (Claude Code)'); process.exit(0); }
const profile = process.env.CLAUDE_CONFIG_DIR;
const accountFile = path.join(profile, 'account.json');
fs.writeFileSync(path.join(profile, 'launch.json'), JSON.stringify({
  args,
  env: {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: profile,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK ?? null,
    AWS_PROFILE: process.env.AWS_PROFILE,
  },
}));
if (args.includes('status')) {
  if (mode === 'bad-status') { process.stdout.write('secret-token malformed-json'); process.exit(1); }
  const account = fs.existsSync(accountFile) ? JSON.parse(fs.readFileSync(accountFile)) : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
  process.stdout.write(JSON.stringify(account));
  process.exit(account.loggedIn ? 0 : 1);
}
if (args.includes('logout')) {
  if (mode !== 'logout-stuck') fs.rmSync(accountFile, { force: true });
  process.exit(0);
}
if (mode === 'overflow') { process.stdout.write('x'.repeat(70000)); process.stdin.resume(); }
else if (mode === 'no-url') { process.stdout.write('waiting'); process.stdin.resume(); }
else {
  if (mode === "wait-after-code") require("node:net").createServer().listen(0, "127.0.0.1");
  process.stdout.write('Opening browser\nhttps://claude.com/cai/oauth/author', () => {
    process.stdout.write('ize?state=fixture-state&client_id=fixture-client\nPaste code here if prompted > ');
  });
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n')) return;
    fs.writeFileSync(path.join(profile, 'submitted.txt'), input);
    if (mode === 'wait-after-code') return;
    if (mode === 'failure') { process.stderr.write('secret-token '+input); process.exit(7); }
    if (mode !== 'no-account') fs.writeFileSync(accountFile, JSON.stringify({ loggedIn: true, authMethod: mode === 'api-key' ? 'api_key' : 'claude.ai', apiProvider: 'firstParty', email: process.env.T3_TEST_EMAIL }));
    process.exit(0);
  });
  process.stdin.on('end', () => { if (mode === 'wait-after-code') process.stdin.resume(); });
}
`;
