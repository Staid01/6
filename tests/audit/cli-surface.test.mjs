/**
 * Requirements audit · command surface (CONTRACT §1, §3, §6; STATUS §3).
 *
 * R01 every CONTRACT §1 sub-command is reachable through `bin/distilly.mjs`
 * R02 `--json` stdout is exactly one receipt object
 * R03 receipt shape {command, person, ok, inputs, outputs, anchors, warnings, unavailable}
 * R04 `--help` is bilingual (中文 → `---` → `## English`)
 * R08 `collect` accepts the eight channels the contract names
 * R09 `--base-dir` and `--skills-dir` together are refused, not guessed
 * R10 unknown commands fail loudly with a remedy
 * R12 zero runtime dependencies, Node >= 20
 * R23 `parse-doc` covers docx | xlsx | pdf
 * R58 the tree carries no Python
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { distilly, fixtures, readJson, receipt, repoRoot, workspace } from "./helpers.mjs";

/** CONTRACT.md §1 command block, one entry per line, verbatim command tokens. */
const CONTRACT_COMMANDS = [
  "harvest",
  "parse-chat",
  "parse-email",
  "parse-subtitle",
  "parse-doc",
  "parse-archive",
  "retrospect",
  "collect",
  "transcribe",
  "note",
  "consent",
  "view check",
  "view render",
  "doctor",
  "skill create",
  "skill update",
  "skill list",
  "skill version",
  "install",
  "uninstall",
];

/** CONTRACT.md §1 line 25: `collect <feishu|slack|dingtalk|x|discord|reddit|notion|gmail>`. */
const CONTRACT_CHANNELS = ["feishu", "slack", "dingtalk", "x", "discord", "reddit", "notion", "gmail"];

test("R01/R04 every CONTRACT §1 command answers --help with a Chinese and an English section", () => {
  const ws = workspace();
  const failures = [];
  for (const command of CONTRACT_COMMANDS) {
    const run = distilly([...command.split(" "), "--help"], { cwd: ws.root, env: { HOME: ws.home } });
    const hasChinese = run.stdout.includes("用法");
    const hasEnglish = run.stdout.includes("## English");
    const hasDivider = run.stdout.includes("\n---\n");
    if (run.status !== 0 || !hasChinese || !hasEnglish || !hasDivider) {
      failures.push(`${command}: exit=${run.status} 用法=${hasChinese} English=${hasEnglish} divider=${hasDivider}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("R01 the global --help lists all eight hosts and does not leave a contract command unimplemented", () => {
  const ws = workspace();
  const run = distilly(["--help"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /宿主 \/ hosts：claude-code, codex, opencode, openclaw, hermes, deepseek-harness, grok-build, pi/);
  // CONTRACT commands "frozen, delivered by other branches" must be an empty list on the integration branch.
  const frozen = run.stdout.match(/契约中已冻结、由其他分支交付：\n([^\n]*)\n/);
  assert.ok(frozen, "help must print the frozen-commands line");
  assert.equal(frozen[1].trim(), "");
});

test("R08 `collect --help` names every channel CONTRACT §1 promises", () => {
  const ws = workspace();
  const run = distilly(["collect", "--help"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 0);
  const missing = CONTRACT_CHANNELS.filter((channel) => !run.stdout.includes(channel));
  assert.deepEqual(missing, [], `collect --help does not mention: ${missing.join(", ")}`);
});

for (const channel of ["discord", "reddit", "notion", "gmail"]) {
  test(`R08 \`collect ${channel} --json\` is a known channel (CONTRACT §1 line 25), so its failure is about credentials, not about the channel name`, () => {
    const ws = workspace();
    const run = distilly(["collect", channel, "--person", "p", "--json"], {
      cwd: ws.root,
      env: { HOME: ws.home, DISTILLY_HOME: ws.distillyHome },
    });
    const body = receipt(run);
    // Literal contrast. Expected: no unknown-channel error; the receipt's
    // `unavailable[0]` names the channel and the credential file it is missing.
    // Observed on dot-skill-test: {"code":"collect/unknown-channel","message":"unsupported channel: <channel>","remedy":"known channels: feishu, slack, dingtalk, x"}, exit 2.
    assert.notEqual(body.error?.code, "collect/unknown-channel", `receipt.error=${JSON.stringify(body.error)}`);
    assert.equal(body.unavailable?.[0]?.channel, channel);
    assert.match(String(body.unavailable?.[0]?.reason ?? ""), new RegExp(`${channel}_config\\.json|credential`));
  });
}

test("R08 every collection module under src/collect/ is reachable from bin/distilly.mjs (module present ≠ command wired)", () => {
  // Static import closure from the only user entry point. A module that no path from
  // `bin/distilly.mjs` imports cannot be exercised by any `distilly` command, however
  // many unit tests import it directly.
  const seen = new Set();
  const queue = [join(repoRoot, "bin", "distilly.mjs")];
  const importPattern = /(?:import\s*(?:[^"']*?from\s*)?|import\()\s*["'](\.{1,2}\/[^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) queue.push(join(file, "..", match[1]));
  }
  const collectDir = join(repoRoot, "src", "collect");
  const modules = readdirSync(collectDir).filter((name) => name.endsWith(".mjs") && name !== "kit.mjs").sort();
  const unreachable = modules.filter((name) => !seen.has(join(collectDir, name)));
  // Observed on dot-skill-test: discord.mjs, feishu-browser.mjs, feishu-mcp.mjs, gmail.mjs, notion.mjs, reddit.mjs.
  assert.deepEqual(unreachable, [], `src/collect modules no distilly command can reach: ${unreachable.join(", ")}`);
});

test("R02/R03 `harvest --json` writes one receipt object to stdout with the eight contract fields", () => {
  const ws = workspace();
  const run = distilly(["harvest", fixtures.interviewSrt, "--person", "lin-gong", "--json"], {
    cwd: ws.root,
    env: { HOME: ws.home },
  });
  assert.equal(run.status, 0, run.stderr);
  const body = receipt(run); // throws unless the whole stdout is one JSON object
  const keys = Object.keys(body);
  for (const field of ["command", "person", "ok", "inputs", "outputs", "anchors", "warnings", "unavailable"]) {
    assert.ok(keys.includes(field), `receipt lacks ${field}`);
  }
  assert.deepEqual(keys.slice(0, 6), ["command", "person", "ok", "inputs", "outputs", "anchors"]);
  assert.equal(body.command, "harvest");
  assert.equal(body.person, "lin-gong");
  assert.equal(body.ok, true);
  for (const item of [...body.inputs, ...body.outputs]) {
    assert.deepEqual(Object.keys(item), ["path", "sha256", "bytes"]);
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof item.bytes, "number");
  }
  assert.deepEqual(body.inputs.map((item) => [item.sha256, item.bytes]), [
    ["51682f8945af9a2482f6ac3f8217db5800a978a9b41c1f4f0a470aa2ee94dfb3", 4162],
  ]);
});

test("R03 `--json` on a failing command still yields the receipt shape plus an error with a remedy", () => {
  const ws = workspace();
  const run = distilly(["retrospect", "--person", "nobody", "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 2);
  const body = receipt(run);
  assert.deepEqual(Object.keys(body).slice(0, 8), ["command", "person", "ok", "inputs", "outputs", "anchors", "warnings", "unavailable"]);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "retrospect/missing-input");
  assert.equal(body.error.remedy, "run `distilly harvest <dir|file> --person <slug>` first, then pass the same --person (or --dir <person-dir>)");
});

test("R09 --base-dir together with --skills-dir is an error, never a guess", () => {
  const ws = workspace();
  const run = distilly(["skill", "list", "--base-dir", ws.root, "--skills-dir", join(ws.root, "skills", "colleague"), "--json"], {
    cwd: ws.root,
    env: { HOME: ws.home },
  });
  assert.equal(run.status, 1);
  const body = receipt(run);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "ambiguous-target");
  assert.equal(body.error.message, "--base-dir and --skills-dir cannot be combined");
});

test("R10 an unknown command exits 1 with code unknown-command and a remedy", () => {
  const ws = workspace();
  const run = distilly(["frobnicate", "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 1);
  const body = receipt(run);
  assert.equal(body.command, "frobnicate");
  assert.equal(body.ok, false);
  assert.deepEqual(body.error, {
    code: "unknown-command",
    message: "unknown command: frobnicate",
    remedy: "run `distilly --help` for the command list.",
  });
});

test("R23 `parse-doc` advertises pdf alongside docx and xlsx (CONTRACT §1 line 22)", () => {
  const ws = workspace();
  const run = distilly(["parse-doc", "--help"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /docx/);
  assert.match(run.stdout, /xlsx/);
  assert.match(run.stdout, /pdf/i, "CONTRACT §1 promises `parse-doc <x.docx|xlsx|pdf>`");
});

test("R12/R58 zero runtime dependencies, engines.node >= 20, and no Python in the tree", () => {
  const manifest = readJson(join(repoRoot, "package.json"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.engines.node, ">=20");
  assert.equal(existsSync(join(repoRoot, "requirements.txt")), false);
  const python = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".py")) python.push(full);
    }
  };
  walk(repoRoot);
  assert.deepEqual(python, []);
});
