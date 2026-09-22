/**
 * Requirements audit · effect-layer mechanics and host installation
 * (ACCEPTANCE §1–§4; BLIND-TEST-RUNBOOK §1–§4; handoff §8; HOSTS.md §1–§2; STATUS §3).
 *
 * R56 split / prepare / control / score run as the runbook and handoff document them
 * R53 install writes to the host matrix path (DSH_HOME honoured), refuses non-`distilly` targets,
 *     and the installed copy is itself runnable
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { distilly, fixtures, readJson, receipt, script, sha256File, workspace } from "./helpers.mjs";

test("R56 split-corpus cuts the interview by timecode at 70% and records both halves' sha256", () => {
  const ws = workspace();
  const run = script("split-corpus.mjs", ["--in", fixtures.interviewSrt, "--out", join(ws.root, "split"), "--ratio", "0.7"], { cwd: ws.root });
  assert.equal(run.status, 0, run.stderr);
  const split = readJson(join(ws.root, "split", "split.json"));
  assert.equal(split.split_by, "timecode");
  assert.deepEqual([split.a.cues, split.b.cues], [28, 10]);
  assert.deepEqual([split.a.start, split.a.end, split.b.start, split.b.end], ["00:00:01.000", "00:03:12.000", "00:03:12.300", "00:04:21.000"]);
  assert.equal(split.cut.timecode, "00:03:12.300");
  assert.equal(split.a.sha256, sha256File(join(ws.root, "split", "A.srt")));
  assert.equal(split.b.sha256, sha256File(join(ws.root, "split", "B.srt")));
  assert.equal(readFileSync(join(ws.root, "split", "A.srt"), "utf8").includes("你给自己打几分"), false, "cue 31 belongs to B");
});

test("R56 `blind-test prepare` works with the relative --out the handoff (§8) and the blind-test README use", () => {
  const ws = workspace();
  assert.equal(script("split-corpus.mjs", ["--in", fixtures.interviewSrt, "--out", "split", "--ratio", "0.7"], { cwd: ws.root }).status, 0);
  const run = script("blind-test.mjs", ["prepare", "--a", "split/A.srt", "--person", "blind-sample-01", "--out", "run", "--baseline"], { cwd: ws.root });
  // Observed on dot-skill-test: exit 1, "distilly retrospect --person blind-sample-01 --json failed (2): … has no knowledge/index.json"
  // because `--base-dir run/work` is resolved against cwd `run/work`.
  assert.equal(run.status, 0, run.stderr.split("\n").slice(0, 3).join(" | "));
  assert.equal(existsSync(join(ws.root, "run", "profile.html")), true);
});

test("R56 with an absolute --out the mechanical baseline renders a private page with no A-half wording and the gaps declared", () => {
  const ws = workspace();
  assert.equal(script("split-corpus.mjs", ["--in", fixtures.interviewSrt, "--out", join(ws.root, "split"), "--ratio", "0.7"], { cwd: ws.root }).status, 0);
  const out = join(ws.root, "run");
  const prepare = script("blind-test.mjs", ["prepare", "--a", join(ws.root, "split", "A.srt"), "--person", "blind-sample-01", "--out", out, "--baseline"], { cwd: ws.root });
  assert.equal(prepare.status, 0, prepare.stderr);
  for (const name of ["deriver-input.md", "judge-prompt.md", "profile.html", "receipt.json", "scores.template.json", "view.skeleton.json"]) {
    assert.equal(existsSync(join(out, name)), true, name);
  }
  const stored = readJson(join(out, "receipt.json"));
  assert.equal(stored.view_source, "mechanical-baseline");
  assert.deepEqual(stored.gaps.map((gap) => gap.section), ["timeline"]);
  assert.equal(stored.sections_filled.length, 7);
  const html = readFileSync(join(out, "profile.html"), "utf8");
  assert.deepEqual(html.match(/https?:\/\/[^\s"'<>)]+/g) ?? [], []);
  for (const sentence of ["先看数据，再看日志，最后才看代码", "怕的不是大故障，是说不清", "我不太会讲大道理"]) {
    assert.equal(html.includes(sentence), false, `A-half wording leaked into the judge's page: ${sentence}`);
  }
  assert.equal(readFileSync(join(out, "deriver-input.md"), "utf8").includes("先看数据，再看日志"), false, "the distiller's input must not contain the corpus");

  const control = script("blind-test.mjs", ["control", "--a", join(ws.root, "split", "A.srt"), "--out", join(ws.root, "control")], { cwd: ws.root });
  assert.equal(control.status, 0, control.stderr);
  assert.equal(readFileSync(join(ws.root, "control", "control-prompt.md"), "utf8").includes("先看数据，再看日志"), true, "the control arm receives the raw A half");

  // RUNBOOK §4: an unfilled sheet counts as undecidable and must FAIL.
  const score = script("blind-test.mjs", ["score", "--scores", join(out, "scores.template.json"), "--out", join(ws.root, "report.md")], { cwd: ws.root });
  assert.equal(score.status, 0, score.stderr);
  const report = readFileSync(join(ws.root, "report.md"), "utf8");
  assert.ok(report.includes("判定：evidence → FAIL；control → FAIL"), report.slice(0, 400));
  assert.ok(report.includes("| 无法判定 | 10 | 10 |"));
});

test("R53 install honours the host matrix: $DSH_HOME/skills/distilly, dry-run first, non-distilly paths refused, copy runnable", () => {
  const ws = workspace();
  const dsh = join(ws.root, "dsh");
  const env = { HOME: ws.home, DSH_HOME: dsh };
  const dry = distilly(["install", "deepseek-harness", "--dry-run", "--json"], { cwd: ws.root, env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(receipt(dry).ok, true);
  assert.equal(existsSync(join(dsh, "skills", "distilly")), false, "dry-run must not write");

  const refused = distilly(["install", "--path", join(ws.root, "notdistilly"), "--dry-run", "--json"], { cwd: ws.root, env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the install path must end with a directory named distilly/);

  const real = distilly(["install", "deepseek-harness", "--json"], { cwd: ws.root, env });
  assert.equal(real.status, 0, real.stderr);
  const target = join(dsh, "skills", "distilly");
  for (const name of ["SKILL.md", "bin/distilly.mjs", "src/cli/receipt.mjs", "assets/distilly-template.html", "prompts/collectors.md"]) {
    assert.equal(existsSync(join(target, name)), true, name);
  }
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8").includes('version: "1.0.0"'), true);

  const installed = distilly(["doctor", "--json"], { cwd: ws.root, env: { ...env, DISTILLY_HOME: ws.distillyHome } });
  assert.equal(installed.status, 0, installed.stderr);
  const hosts = receipt(installed).hosts;
  assert.deepEqual(hosts.map((host) => host.host), ["claude-code", "codex", "opencode", "openclaw", "hermes", "deepseek-harness", "grok-build", "pi"]);
  assert.deepEqual(hosts.filter((host) => host.installed).map((host) => host.host), ["deepseek-harness"]);

  const copy = spawnSync(process.execPath, [join(target, "bin", "distilly.mjs"), "--version"], { cwd: ws.root, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(copy.status, 0, copy.stderr);
  assert.equal(copy.stdout.trim(), "1.0.0");
});
