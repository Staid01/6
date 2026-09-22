/**
 * Requirements audit · Distill deliverables and evolution
 * (CONTRACT §2; STATUS §1 §4; PRD §5 §6 §8 §10; SKILL.md 进化模式; MIGRATION.md).
 *
 * R30 `skill create` writes the seven artefacts
 * R31 SKILL.md carries PART A / PART B / Operating Rules, Layer 0–5 with rules, 0 dangling anchors
 * R33 update archives the previous version, bumps the version, records the correction; rollback restores bytes
 * R58 the generated manifest must not point at Python installers that no longer exist
 * R67 at most ten archived versions are kept
 * R69 SKILL.md frontmatter (name / description / user-invocable)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { distilly, distillInputs, fileTree, fixtures, ledgerAnchors, readJson, receipt, repoRoot, sha256File, workspace } from "./helpers.mjs";

const ARTIFACTS = ["SKILL.md", "work.md", "persona.md", "work_skill.md", "persona_skill.md", "manifest.json", "meta.json"];

function site() {
  const ws = workspace();
  const env = { HOME: ws.home };
  const harvest = distilly(["harvest", fixtures.interviewDir, "--person", "lin-gong", "--json"], { cwd: ws.root, env });
  assert.equal(harvest.status, 0, harvest.stderr);
  const inputs = join(ws.root, "inputs");
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, "work.md"), distillInputs.work);
  writeFileSync(join(inputs, "persona.md"), distillInputs.persona);
  writeFileSync(join(inputs, "meta.json"), distillInputs.meta);
  const personDir = join(ws.root, "skills", "colleague", "lin-gong");
  const run = (args) => distilly(args, { cwd: ws.root, env });
  const create = () =>
    run(["skill", "create", "--character", "colleague", "--slug", "lin-gong", "--base-dir", ws.root, "--meta", join(inputs, "meta.json"), "--work", join(inputs, "work.md"), "--persona", join(inputs, "persona.md"), "--no-install-claude-skill", "--json"]);
  return { ws, personDir, inputs, run, create };
}

test("R30 skill create exits 0 and lists exactly the seven artefacts, which then exist on disk", () => {
  const s = site();
  const created = s.create();
  assert.equal(created.status, 0, created.stderr);
  const body = receipt(created);
  assert.equal(body.ok, true);
  assert.equal(body.person, "lin-gong");
  assert.deepEqual(body.outputs.map((item) => item.path), ARTIFACTS.map((name) => `skills/colleague/lin-gong/${name}`));
  for (const item of body.outputs) assert.equal(item.sha256, sha256File(join(s.ws.root, item.path)));
  const top = fileTree(s.personDir).filter((path) => !path.includes("/"));
  assert.deepEqual(top.sort(), [...ARTIFACTS].sort());
});

test("R31/R63/R69 SKILL.md has the PRD structure, six Layer headings with Layer 0 rules, and only ledger anchors", () => {
  const s = site();
  assert.equal(s.create().status, 0);
  const skill = readFileSync(join(s.personDir, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: colleague-lin-gong\ndescription: 林工, Colleague\nuser-invocable: true\n---\n/);
  for (const heading of ["## PART A: Work", "## PART B: Persona", "## Operating Rules"]) assert.ok(skill.includes(heading), heading);
  const layers = [...skill.matchAll(/^## Layer (\d)/gm)].map((m) => Number(m[1]));
  assert.deepEqual(layers, [0, 1, 2, 3, 4, 5]);
  const layer0 = skill.split("## Layer 0")[1].split("## Layer 1")[0];
  assert.equal(layer0.split("\n").filter((row) => row.trim().startsWith("- ")).length, 2);
  assert.ok(skill.includes("**Layer 0 rules in PART B always take priority and must never be violated.**"));

  const known = ledgerAnchors(join(s.personDir, "knowledge", "index.json"));
  const cited = [...new Set([...skill.matchAll(/\[(k\d{4}(?::t\d+)?)\]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(cited, ["k0002", "k0004", "k0006", "k0010", "k0018", "k0022", "k0026", "k0030", "k0032"]);
  assert.deepEqual(cited.filter((anchor) => !known.has(anchor)), []);

  const meta = readJson(join(s.personDir, "meta.json"));
  assert.equal(meta.slug, "lin-gong");
  assert.equal(meta.version, "v1");
  assert.equal(meta.corrections_count, 0);
  assert.equal(meta.schema_version, "4");
});

test("R33 update archives v1, bumps to v2, appends the correction; rollback restores the archived bytes", () => {
  const s = site();
  assert.equal(s.create().status, 0);
  const skillV1 = sha256File(join(s.personDir, "SKILL.md"));
  const personaV1 = readFileSync(join(s.personDir, "persona.md"));
  const correction = join(s.inputs, "corr.json");
  writeFileSync(correction, JSON.stringify({ persona_corrections: [{ scene: "被质疑时", wrong: "道歉", correct: "反问对方的判断依据" }] }));

  const update = s.run(["skill", "update", "--character", "colleague", "--slug", "lin-gong", "--base-dir", s.ws.root, "--correction-json", correction, "--json"]);
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(receipt(update).outputs.map((item) => item.path), ARTIFACTS.map((name) => `skills/colleague/lin-gong/${name}`));
  assert.deepEqual(readdirSync(join(s.personDir, "versions")), ["v1"]);
  assert.equal(sha256File(join(s.personDir, "versions", "v1", "SKILL.md")), skillV1);
  const meta = readJson(join(s.personDir, "meta.json"));
  assert.equal(meta.version, "v2");
  assert.equal(meta.corrections_count, 1);
  const persona = readFileSync(join(s.personDir, "persona.md"), "utf8");
  assert.ok(persona.includes("## Correction Log"));
  assert.ok(persona.includes("- [被质疑时] should not 道歉; should 反问对方的判断依据"));
  assert.ok(readFileSync(join(s.personDir, "SKILL.md"), "utf8").includes("- [被质疑时] should not 道歉; should 反问对方的判断依据"));

  const list = s.run(["skill", "version", "list", "--slug", "lin-gong", "--character", "colleague", "--base-dir", s.ws.root, "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(receipt(list).outputs.map((item) => item.path), ["skills/colleague/lin-gong/versions/v1/SKILL.md"]);

  const rollback = s.run(["skill", "version", "rollback", "--slug", "lin-gong", "--character", "colleague", "--base-dir", s.ws.root, "--version", "v1", "--json"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.ok(readFileSync(join(s.personDir, "persona.md")).equals(personaV1), "rollback must restore the archived persona bytes");
  assert.equal(sha256File(join(s.personDir, "SKILL.md")), skillV1);
});

test("R67 the version archive keeps at most ten versions after cleanup", () => {
  const s = site();
  assert.equal(s.create().status, 0);
  const patch = join(s.inputs, "patch.md");
  for (let index = 1; index <= 11; index += 1) {
    writeFileSync(patch, `## 经验知识\n- 第 ${index} 次增量 [k0030]\n`);
    const update = s.run(["skill", "update", "--character", "colleague", "--slug", "lin-gong", "--base-dir", s.ws.root, "--work-patch", patch, "--json"]);
    assert.equal(update.status, 0, update.stderr);
  }
  assert.equal(readJson(join(s.personDir, "meta.json")).version, "v12");
  const cleanup = s.run(["skill", "version", "cleanup", "--slug", "lin-gong", "--character", "colleague", "--base-dir", s.ws.root, "--json"]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const kept = readdirSync(join(s.personDir, "versions")).sort();
  assert.equal(kept.length, 10, `versions kept: ${kept.join(", ")}`);
  assert.equal(kept.includes("v1"), false, "the oldest archive is the one dropped");
});

test("R58 manifest.json must not point the host at Python installers that are not in the tree", () => {
  const s = site();
  assert.equal(s.create().status, 0);
  const manifest = readJson(join(s.personDir, "manifest.json"));
  assert.equal(JSON.stringify(manifest).includes(".py"), false);
  const installers = manifest.install?.installers;
  assert.ok(Array.isArray(installers) && installers.length > 0);
  for (const item of installers) {
    const command = item?.command;
    const pathExists = typeof item === "string" && existsSync(join(repoRoot, item));
    const isNodeInstall = command === `node bin/distilly.mjs install ${item.host}`;
    assert.equal(pathExists || isNodeInstall, true, JSON.stringify(item));
  }
});
