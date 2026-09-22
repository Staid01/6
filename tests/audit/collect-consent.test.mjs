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
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { distilly, fixtures, receipt, sha256, workspace } from "./helpers.mjs";

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
  // Expected: the same consent gate as `collect x --mode browser` (exit 2, mode browser).
  // Observed on dot-skill-test: mode "api", exit 1, "collect feishu needs --chat-id" — the flag is ignored.
  assert.equal(body.mode, "browser", `receipt.mode=${body.mode}; errors=${JSON.stringify(body.errors)}`);
  assert.equal(run.status, 2);
  assert.equal(body.status, "waiting-for-user-consent");
});

test("R08 `collect feishu --mode mcp` (SKILL.md 迁移对照表: feishu_mcp_client.py → collect feishu) reaches the MCP route", () => {
  const ws = workspace();
  const run = distilly(["collect", "feishu", "--mode", "mcp", "--person", "p", "--json"], { cwd: ws.root, env: env(ws) });
  const body = receipt(run);
  assert.equal(body.mode, "mcp", `receipt.mode=${body.mode}; errors=${JSON.stringify(body.errors)}`);
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
