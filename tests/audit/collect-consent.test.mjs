/**
 * Requirements audit · credentialed channels and the consent gate
 * (CONTRACT §1, §3; plan §4.2; SKILL.md 命令契约 / 迁移对照表).
 *
 * R05 missing credentials fail loudly with a remedy, never silently
 * R06 receipts name the credential file and never a secret value
 * R07 browser mode without --consent exits 2 and says it is waiting for consent
 * R08 the feishu browser / MCP routes SKILL.md documents are reachable from the CLI
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { distilly, fixtures, receipt, repoRoot, sha256, workspace } from "./helpers.mjs";

function contractChannels() {
  const text = readFileSync(join(repoRoot, "docs", "v2", "CONTRACT.md"), "utf8");
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => /^##\s+1\./.test(line));
  const open = lines.findIndex((line, index) => index > heading && line.startsWith("```"));
  const close = lines.findIndex((line, index) => index > open && line.startsWith("```"));
  const block = lines.slice(open + 1, close).join("\n");
  const match = block.match(/^collect <([^>\n]+)>/m);
  if (!match) throw new Error("CONTRACT §1 has no collect <channel> group");
  return match[1].split("|").map((channel) => channel.trim());
}

const env = (ws) => ({ HOME: ws.home, DISTILLY_HOME: ws.distillyHome });

test("R07 `collect x --mode browser` without a token exits 2 and waits for consent", () => {
  const ws = workspace();
  const run = distilly(["collect", "x", "--mode", "browser", "--person", "p", "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(run.status, 2);
  const body = receipt(run);
  assert.equal(body.ok, false);
  assert.equal(body.mode, "browser");
  assert.equal(body.status, "waiting-for-user-consent");
  assert.equal(body.unavailable.length, 1);
  assert.equal(body.unavailable[0].channel, "x");
  assert.equal(body.unavailable[0].scope, "collect:x:browser");
  assert.equal(body.unavailable[0].reason, "waiting for user consent: no-token");
  assert.deepEqual(body.unavailable[0].remediation, [
    "run: distilly consent grant --scope collect:x:browser",
    "then pass the printed token: distilly collect x --mode browser --consent <token>",
  ]);
  assert.equal(existsSync(join(ws.root, "skills")), false, "no knowledge/ may be written without consent");
});

test("R07/R06 a granted token is stored 0600, unlocks browser mode, and never appears in the collect receipt", () => {
  const ws = workspace();
  const grant = distilly(["consent", "grant", "--scope", "collect:x:browser", "--ttl", "30", "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(grant.status, 0, grant.stderr);
  const granted = receipt(grant);
  assert.equal(granted.action, "grant");
  assert.equal(granted.grants.length, 1);
  const { token, scope, granted_at, expires_at } = granted.grants[0];
  assert.match(token, /^dsc_[0-9a-f]{32}$/);
  assert.equal(scope, "collect:x:browser");
  assert.equal(new Date(expires_at) - new Date(granted_at), 30 * 60 * 1000);

  const consentFile = join(ws.distillyHome, "consent.json");
  assert.equal(existsSync(consentFile), true);
  assert.equal(statSync(consentFile).mode & 0o777, 0o600);

  const run = distilly(["collect", "x", "--mode", "browser", "--consent", token, "--username", "someone", "--person", "p", "--json"], {
    cwd: ws.root,
    env: env(ws),
  });
  assert.equal(run.status, 0, run.stderr);
  const body = receipt(run);
  assert.equal(body.ok, true);
  assert.equal(body.status, "awaiting-host-capture");
  // plan §4.2: the receipt records who approved what and until when.
  assert.deepEqual(body.consent, { scope: "collect:x:browser", granted_at, expires_at, token_sha256_12: sha256(token).slice(0, 12) });
  assert.equal(run.stdout.includes(token), false, "the token value must not appear in the receipt");
  assert.equal(run.stderr.includes(token), false, "the token value must not appear in the log");
});

test("R05/R06 `collect slack` with no credential exits 1, names slack_config.json and gives a remedy", () => {
  const ws = workspace();
  const run = distilly(["collect", "slack", "--channel", "C0123456789", "--person", "p", "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(run.status, 1);
  const body = receipt(run);
  assert.equal(body.ok, false);
  assert.equal(body.credential_file, "slack_config.json");
  assert.equal(body.unavailable.length, 1);
  assert.equal(body.unavailable[0].channel, "slack");
  assert.equal(body.unavailable[0].reason, "no-credential: no credential at ~/.distilly/slack_config.json");
  assert.equal(body.unavailable[0].remediation[0], 'create ~/.distilly/slack_config.json (chmod 600) with {"bot_token": "xoxb-…"}');
  assert.equal(body.unavailable[0].remediation.length, 5);
  assert.equal(existsSync(join(ws.root, "skills")), false, "nothing may be fabricated on disk");
});

test("R08 `collect feishu --mode browser` (SKILL.md 迁移对照表) reaches the browser route and asks for consent", () => {
  const ws = workspace();
  const run = distilly(["collect", "feishu", "--mode", "browser", "--person", "p", "--json"], { cwd: ws.root, env: env(ws) });
  const body = receipt(run);
  assert.equal(run.status, 2);
  assert.equal(body.mode, "browser");
  assert.equal(body.status, "waiting-for-user-consent");
  assert.equal(body.unavailable[0].remediation[0], "run: distilly consent grant --scope collect:feishu:browser");
});

test("R08 `collect feishu --mode mcp` (SKILL.md 迁移对照表: feishu_mcp_client.py → collect feishu) reaches the MCP route", () => {
  const ws = workspace();
  const run = distilly(["collect", "feishu", "--mode", "mcp", "--person", "p", "--json"], { cwd: ws.root, env: env(ws) });
  const body = receipt(run);
  assert.equal(body.mode, "mcp");
  assert.equal(JSON.stringify(body).includes("--chat-id"), false);
  assert.match(JSON.stringify(body), /feishu_config\.json/);
});

test("R08 a channel outside CONTRACT §1 returns collect/unknown-channel and the remedy lists the contract channels", () => {
  const ws = workspace();
  const channels = contractChannels();
  const expectedRemedy = `known channels: ${channels.join(", ")}`;
  for (const channel of ["discord", "reddit", "notion", "gmail"]) {
    const run = distilly(["collect", channel, "--person", "p", "--json"], { cwd: ws.root, env: env(ws) });
    assert.equal(run.status, 2);
    const body = receipt(run);
    assert.equal(body.error.code, "collect/unknown-channel");
    assert.equal(body.error.remedy, expectedRemedy);
  }
});

test("bin/distilly.mjs collect feishu --mode browser reaches the consent gate and --mode mcp reaches the MCP credential file", () => {
  const ws = workspace();
  const browser = distilly(["collect", "feishu", "--mode", "browser", "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(browser.status, 2);
  const browserBody = receipt(browser);
  assert.equal(browserBody.mode, "browser");
  assert.equal(browserBody.status, "waiting-for-user-consent");
  assert.equal(browserBody.unavailable[0].remediation[0], "run: distilly consent grant --scope collect:feishu:browser");

  const mcp = distilly(["collect", "feishu", "--mode", "mcp", "--json"], { cwd: ws.root, env: env(ws) });
  const mcpBody = receipt(mcp);
  assert.equal(mcpBody.mode, "mcp");
  assert.equal(JSON.stringify(mcpBody).includes("--chat-id"), false);
  assert.match(JSON.stringify(mcpBody), /feishu_config\.json/);
});

test("collect feishu --mode bogus and collect slack --mode browser exit 2 with collect/usage", () => {
  const ws = workspace();
  const bogus = distilly(["collect", "feishu", "--mode", "bogus", "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(bogus.status, 2);
  const bogusBody = receipt(bogus);
  assert.equal(bogusBody.mode, "bogus");
  assert.equal(bogusBody.error.code, "collect/usage");
  assert.equal(bogusBody.error.remedy, "legal --mode values: api, browser, mcp");

  const slack = distilly(["collect", "slack", "--mode", "browser", "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(slack.status, 2);
  const slackBody = receipt(slack);
  assert.equal(slackBody.mode, "browser");
  assert.equal(slackBody.error.code, "collect/usage");
  assert.equal(slackBody.error.remedy, "legal --mode values: none");
});

test("R05 `transcribe` with no backend reports unavailable with the config file name and exits 1", () => {
  const ws = workspace();
  const run = distilly(["transcribe", fixtures.interviewSrt, "--json"], { cwd: ws.root, env: env(ws) });
  assert.equal(run.status, 1);
  const body = receipt(run);
  assert.equal(body.ok, false);
  assert.equal(body.credential_file, "transcribe_config.json");
  assert.equal(body.unavailable[0].channel, "transcribe");
  assert.equal(body.unavailable[0].reason, "no-backend: no API key in transcribe_config.json and no host capture given");
  assert.equal(body.unavailable[0].remediation.length, 4);
});
