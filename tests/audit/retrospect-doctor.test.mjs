/**
 * Requirements audit · Derive step, corpus shape gate and doctor
 * (CONTRACT §1, §5; STATUS §2 §4 §5; SKILL.md Step 1.5 / Step 2; ACCEPTANCE §5).
 *
 * R24 `doctor --require-shape` is the Step 1.5 gate: run after Collect, before Derive
 * R25 `retrospect` is deterministic: two runs, identical bytes, receipt sha256 matches disk
 * R26 every derived claim's anchors resolve in the ledger
 * R28 participants are people, not document labels
 * R29 missing input fails with a remedy
 * R48 doctor reports coverage, unavailable channels, back-reference rate, computer-use share
 * R49 doctor treats a dangling citation in any deliverable (Skill files or view.json) as FAIL
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { anchorsInJson, distilly, distillInputs, fixtures, hashDir, interviewView, ledgerAnchors, readJson, receipt, sha256File, workspace } from "./helpers.mjs";

const DERIVED_FILES = ["boundaries.json", "conflicts.json", "relations.json", "shifts.json", "stats.json", "timeline.json", "voice.json"];

function harvest(ws, target, slug) {
  const run = distilly(["harvest", target, "--person", slug, "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 0, run.stderr);
  return receipt(run);
}

function retrospect(ws, slug) {
  const run = distilly(["retrospect", "--person", slug, "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 0, run.stderr);
  return receipt(run);
}

function doctor(ws, extra = []) {
  const run = distilly(["doctor", "--base-dir", ws.root, ...extra, "--json"], { cwd: ws.root, env: { HOME: ws.home, DISTILLY_HOME: ws.distillyHome } });
  return { run, body: receipt(run) };
}

test("R25 retrospect writes the seven dimensions and two runs are byte-identical, receipt included", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  const derivedDir = join(ws.root, "skills", "colleague", "lin-gong", "evidence", "derived");

  const first = retrospect(ws, "lin-gong");
  assert.deepEqual(readdirSync(derivedDir).sort(), DERIVED_FILES);
  const hashes1 = hashDir(derivedDir);
  assert.deepEqual(
    first.outputs.map((item) => [item.path, item.sha256]).sort(),
    DERIVED_FILES.map((name) => [`evidence/derived/${name}`, hashes1[name]]).sort(),
    "receipt outputs must carry the sha256 of the files on disk",
  );
  assert.deepEqual(first.anchors, { total: 76, cited: first.anchors.cited });
  assert.ok(first.anchors.cited > 0);

  const second = retrospect(ws, "lin-gong");
  assert.deepEqual(hashDir(derivedDir), hashes1);
  assert.deepEqual(second.outputs, first.outputs);
});

test("R26 every anchor a derived claim cites is declared by the ledger, and every claim has evidence", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  retrospect(ws, "lin-gong");
  const personDir = join(ws.root, "skills", "colleague", "lin-gong");
  const known = ledgerAnchors(join(personDir, "knowledge", "index.json"));
  const dangling = [];
  let claims = 0;
  for (const name of DERIVED_FILES) {
    const document = readJson(join(personDir, "evidence", "derived", name));
    assert.equal(document.kind, name.replace(/\.json$/, ""));
    for (const claim of document.claims) {
      claims += 1;
      assert.ok(Array.isArray(claim.evidence) && claim.evidence.length > 0, `${name}:${claim.id} has no evidence`);
      for (const anchor of anchorsInJson(claim)) if (!known.has(anchor)) dangling.push(`${name}:${claim.id}:${anchor}`);
    }
  }
  assert.ok(claims >= 10, `only ${claims} claims derived`);
  assert.deepEqual(dangling, []);
});

test("R28 participants derived from the interview are exactly its two speakers", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  retrospect(ws, "lin-gong");
  const stats = readJson(join(ws.root, "skills", "colleague", "lin-gong", "evidence", "derived", "stats.json"));
  const claim = (id) => stats.claims.find((item) => item.id === id);
  assert.equal(claim("stats.message_count").value, 38);
  assert.deepEqual(claim("stats.participants").value, ["林工", "面试官"]);
  assert.equal(claim("stats.participant_count").value, 2);
});

test("R28 a document's labels (根因：/ 时间线：) are not counted as participants in a multi-source person", () => {
  const ws = workspace();
  const env = { HOME: ws.home };
  for (const args of [
    ["parse-chat", fixtures.multiSlack, "--users", fixtures.multiUsers, "--person", "ms", "--json"],
    ["parse-chat", fixtures.multiFeishu, "--person", "ms", "--json"],
    ["harvest", fixtures.multiPostmortem, "--person", "ms", "--json"],
  ]) {
    const run = distilly(args, { cwd: ws.root, env });
    assert.equal(run.status, 0, run.stderr);
  }
  retrospect(ws, "ms");
  const stats = readJson(join(ws.root, "skills", "colleague", "ms", "evidence", "derived", "stats.json"));
  const participants = stats.claims.find((item) => item.id === "stats.participants").value;
  const people = new Set(["林工", "小明", "老周", "ou_lin", "ou_chen", "ou_zhou"]);
  const notPeople = participants.filter((name) => !people.has(name));
  assert.deepEqual(notPeople, [], `document labels reported as participants: ${notPeople.join(", ")}`);
  assert.equal(stats.claims.find((item) => item.id === "stats.participant_count").value, participants.length);
});

test("R29 retrospect without a ledger exits 2 with retrospect/missing-input and the harvest remedy", () => {
  const ws = workspace();
  const run = distilly(["retrospect", "--person", "ghost", "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 2);
  const body = receipt(run);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "retrospect/missing-input");
  assert.match(body.error.message, /skills\/\*\/ghost has no knowledge\/index\.json$/);
});

test("R24 Step 1.5: `doctor --require-shape` run after Collect and before Derive fails the C-SPAN floor corpus", () => {
  const ws = workspace();
  harvest(ws, fixtures.houseDir, "us-house");
  // SKILL.md Step 1.5 and STATUS §2 place this gate before `retrospect`; STATUS §5
  // states the verdict for this corpus is FAIL (units=2744 speakers=18, 3% attributable).
  const before = doctor(ws, ["--require-shape"]);
  const shape = before.body.shape.find((item) => item.slug === "colleague/us-house");
  assert.equal(shape.units, 2744);
  assert.equal(shape.verdict, "FAIL", `before retrospect: speakers=${shape.speakers} attributed=${shape.attributed_units} notes=${JSON.stringify(shape.notes)}`);
  assert.equal(before.run.status, 1);

  retrospect(ws, "us-house");
  const after = doctor(ws, ["--require-shape"]);
  const later = after.body.shape.find((item) => item.slug === "colleague/us-house");
  assert.equal(later.verdict, "FAIL");
  assert.equal(later.speakers, 18);
  assert.match(later.reasons[0], /^这是多人材料，但只有 3% 的单元能归到某个说话人（阈值 40%）：/);
  assert.equal(after.run.status, 1);
  assert.equal(after.body.verdict, "FAIL");
});

test("R24 after retrospect, `doctor --require-shape` fails the C-SPAN floor corpus with exit 1 and the documented reason; without the flag it only reports", () => {
  // CI's acceptance job runs synthetic-interview and synthetic-multisource only
  // (.github/workflows/ci.yml lines 76-82), so the FAIL path STATUS §5 describes is
  // never exercised by "CI green". This pins it on the corpus the docs name.
  const ws = workspace();
  harvest(ws, fixtures.houseDir, "us-house");
  retrospect(ws, "us-house");

  const reported = doctor(ws);
  assert.equal(reported.run.status, 0, "reporting a bad shape without --require-shape is not itself a failure");
  const soft = reported.body.shape.find((item) => item.slug === "colleague/us-house");
  assert.equal(soft.verdict, "FAIL");
  assert.equal(reported.body.ok, true);
  assert.equal(reported.body.verdict, "PASS");

  const gated = doctor(ws, ["--require-shape"]);
  assert.equal(gated.run.status, 1);
  assert.equal(gated.body.ok, false);
  assert.equal(gated.body.verdict, "FAIL");
  const shape = gated.body.shape.find((item) => item.slug === "colleague/us-house");
  assert.equal(shape.units, 2744);
  assert.equal(shape.sources, 2);
  assert.equal(shape.speakers, 14);
  assert.equal(shape.top_speaker, "THE SPEAKER PRO TEMPORE");
  assert.deepEqual(shape.reasons, [
    "这是多人材料，但只有 3% 的单元能归到某个说话人（阈值 40%）：先补这个人自己的一手产出（本人访谈/演讲字幕、本人文章），不要从会议流水里切人",
  ]);
  assert.match(gated.run.stderr, /Verdict \/ 判定：FAIL —— 语料形状撑不起一个人/);
});

test("R24 the interview corpus passes the shape gate with two speakers and 林工 on top", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  retrospect(ws, "lin-gong");
  const { run, body } = doctor(ws, ["--require-shape"]);
  assert.equal(run.status, 0, run.stderr);
  const shape = body.shape.find((item) => item.slug === "colleague/lin-gong");
  assert.equal(shape.verdict, "PASS");
  assert.equal(shape.speakers, 2);
  assert.equal(shape.top_speaker, "林工");
  assert.deepEqual(shape.reasons, []);
});

function createSkill(ws) {
  const inputs = join(ws.root, "inputs");
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, "work.md"), distillInputs.work);
  writeFileSync(join(inputs, "persona.md"), distillInputs.persona);
  writeFileSync(join(inputs, "meta.json"), distillInputs.meta);
  const run = distilly(
    ["skill", "create", "--character", "colleague", "--slug", "lin-gong", "--base-dir", ws.root, "--meta", join(inputs, "meta.json"), "--work", join(inputs, "work.md"), "--persona", join(inputs, "persona.md"), "--no-install-claude-skill", "--json"],
    { cwd: ws.root, env: { HOME: ws.home } },
  );
  assert.equal(run.status, 0, run.stderr);
  return receipt(run);
}

test("R49 doctor fails (exit 1) when persona.md cites an anchor the ledger does not declare", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  retrospect(ws, "lin-gong");
  createSkill(ws);
  const clean = doctor(ws);
  assert.equal(clean.run.status, 0, clean.run.stderr);
  assert.deepEqual(clean.body.anchors, { total: 76, cited: clean.body.anchors.cited, dangling: 0 });
  assert.equal(clean.body.verdict, "PASS");

  appendFileSync(join(ws.root, "skills", "colleague", "lin-gong", "persona.md"), "- 凭空多出来的一条 [k9999]\n");
  const broken = doctor(ws);
  assert.equal(broken.run.status, 1);
  assert.equal(broken.body.ok, false);
  assert.equal(broken.body.verdict, "FAIL");
  assert.equal(broken.body.anchors.dangling, 1);
  assert.match(broken.body.warnings[0], /colleague\/lin-gong: k9999/);
});

test("R49 doctor fails when views/<slug>.view.json cites an anchor the ledger does not declare", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  retrospect(ws, "lin-gong");
  createSkill(ws);
  const viewsDir = join(ws.root, "skills", "colleague", "lin-gong", "views");
  mkdirSync(viewsDir, { recursive: true });
  const view = interviewView();
  view.sections[0].items[0].anchors = ["k9999"];
  view.evidence.push({ anchor: "k9999", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "不存在的锚点" });
  writeFileSync(join(viewsDir, "lin-gong.view.json"), `${JSON.stringify(view, null, 2)}\n`);

  const { run, body } = doctor(ws);
  // STATUS §4: "doctor 现在把生成物里的引用一并计入，悬空引用 → ok:false、exit 1".
  assert.equal(body.anchors.dangling, 1, `doctor reported ${JSON.stringify(body.anchors)} for a view.json citing k9999`);
  assert.equal(body.ok, false);
  assert.equal(run.status, 1);
});

test("R48 doctor reports the channels this machine cannot collect from and the computer-use share", () => {
  const ws = workspace();
  harvest(ws, fixtures.interviewDir, "lin-gong");
  retrospect(ws, "lin-gong");
  createSkill(ws);
  const { run, body } = doctor(ws);
  assert.equal(run.status, 0, run.stderr);
  // CONTRACT §1 line 31: doctor → 证据覆盖率 / 不可用渠道 / 锚点回指率 / computer-use 占比.
  // CONTRACT §3 example: {"channel": "dingtalk", "reason": "no credential at ~/.distilly/dingtalk_config.json"}.
  assert.ok(body.anchors.total > 0 && body.anchors.cited > 0, "back-reference rate is reported");
  const channels = body.unavailable.map((item) => item.channel);
  assert.ok(channels.includes("dingtalk"), `unavailable=${JSON.stringify(body.unavailable)}; DISTILLY_HOME holds no credential file`);
  assert.match(JSON.stringify(body), /computer[-_ ]?use/i, "the receipt carries a computer-use share");
});
