/**
 * Requirements audit · Collect step and the evidence spine
 * (CONTRACT §2, §5; ACCEPTANCE §5; SKILL.md Step 1; IDENTITY.md; STATUS §1).
 *
 * R13 disk contract: raw/ text/ index.json with the ledger fields
 * R14 raw bytes are verbatim; receipt sha256 == ledger sha256 == input sha256
 * R15 every [k00NN] resolves to a real byte range whose content matches
 * R16 anchor ids are unique within one person's ledger
 * R17 repeating a harvest is idempotent (ledger, text files, derived output)
 * R18 one ledger entry per grounded source, >= 1 anchor per text file
 * R19 unrecognised inputs are reported, never guessed
 * R20 `note --from` registers model-read material and refuses empty input
 * R21 identity.json: duplicate handle -> exit 2 and nothing written; no handles -> warning
 * R22 byte conservation: raw bytes >= bytes covered by units, units ordered and disjoint
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { distilly, fileTree, fixtures, hashDir, ledgerAnchors, readJson, receipt, sha256, sha256File, workspace } from "./helpers.mjs";

const person = (ws, slug) => join(ws.root, "skills", "colleague", slug);

function harvestInterview(ws, slug = "lin-gong", target = fixtures.interviewDir) {
  const run = distilly(["harvest", target, "--person", slug, "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  assert.equal(run.status, 0, run.stderr);
  return receipt(run);
}

test("R13/R18 harvest writes raw + text + ledger, one entry with the contract fields", () => {
  const ws = workspace();
  harvestInterview(ws);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  assert.deepEqual(fileTree(knowledge), ["index.json", "raw/subtitle/transcript.srt", "text/subtitle.md"]);

  const ledger = readJson(join(knowledge, "index.json"));
  assert.equal(ledger.length, 1);
  const entry = ledger[0];
  for (const field of ["id", "kind", "origin", "fetched_at", "bytes", "sha256", "credentialed", "method", "warnings"]) {
    assert.ok(field in entry, `ledger entry lacks ${field}`);
  }
  assert.equal(entry.id, "k0001");
  assert.equal(entry.kind, "subtitle");
  assert.equal(entry.origin, "raw/subtitle/transcript.srt");
  assert.equal(entry.method, "local-file");
  assert.equal(entry.credentialed, false);
  assert.equal(entry.bytes, 4162);
  assert.equal(entry.sha256, "51682f8945af9a2482f6ac3f8217db5800a978a9b41c1f4f0a470aa2ee94dfb3");
  assert.deepEqual(entry.warnings, []);
  assert.deepEqual(entry.locations, { raw: "raw/subtitle/transcript.srt", text: "text/subtitle.md" });
  assert.deepEqual(entry.counts, { anchors: 76, units: 38 });
  assert.match(entry.fetched_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const text = readFileSync(join(knowledge, "text", "subtitle.md"), "utf8");
  const anchors = [...text.matchAll(/^\[(k\d{4})\]/gm)].map((m) => m[1]);
  assert.equal(anchors.length, 38);
  assert.equal(anchors[0], "k0001");
  assert.equal(anchors[37], "k0038");
  assert.match(text, /^\[k0004\] 00:00:17\.000 林工：怕的不是大故障，是说不清。钱对不上，先别改代码，先把账翻出来，一条一条对。$/m);
});

test("R14 raw bytes equal the input bytes, and the receipt, ledger and raw file agree on sha256", () => {
  const ws = workspace();
  const body = harvestInterview(ws);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  const inputSha = sha256File(fixtures.interviewSrt);
  assert.equal(sha256File(join(knowledge, "raw", "subtitle", "transcript.srt")), inputSha);
  assert.equal(readJson(join(knowledge, "index.json"))[0].sha256, inputSha);
  assert.ok(body.inputs.some((item) => item.sha256 === inputSha && item.bytes === 4162), JSON.stringify(body.inputs));
  const ledgerOut = body.outputs.find((item) => item.path.endsWith("knowledge/index.json"));
  assert.ok(ledgerOut, "the ledger must be listed in outputs");
  assert.equal(ledgerOut.sha256, sha256File(join(knowledge, "index.json")));
});

test("R15 every anchor resolves to a byte range in raw/ whose content contains the anchored text, and the text file agrees", () => {
  const ws = workspace();
  harvestInterview(ws);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  const entry = readJson(join(knowledge, "index.json"))[0];
  const raw = readFileSync(join(knowledge, "raw", "subtitle", "transcript.srt"));
  const text = readFileSync(join(knowledge, "text", "subtitle.md"), "utf8");

  assert.equal(entry.units.length, 38);
  const k0004 = entry.units.find((unit) => unit.anchor === "k0004");
  assert.deepEqual(
    { byteStart: k0004.byteStart, byteEnd: k0004.byteEnd, text: k0004.text },
    { byteStart: 294, byteEnd: 447, text: "林工：怕的不是大故障，是说不清。钱对不上，先别改代码，先把账翻出来，一条一条对。" },
  );

  const broken = [];
  for (const unit of entry.units) {
    const slice = raw.subarray(unit.byteStart, unit.byteEnd).toString("utf8");
    if (!slice.includes(unit.text)) broken.push(`${unit.anchor}: raw[${unit.byteStart},${unit.byteEnd}) does not contain the unit text`);
    const line = text.split("\n").find((row) => row.startsWith(`[${unit.anchor}] `));
    if (!line || !line.endsWith(unit.text)) broken.push(`${unit.anchor}: knowledge/text has no matching line`);
  }
  for (const detail of entry.anchor_detail.filter((item) => item.kind === "cue")) {
    const file = detail.file.startsWith("raw/") ? detail.file : join("raw", "subtitle", detail.file);
    const bytes = readFileSync(join(knowledge, file));
    const slice = bytes.subarray(detail.byteStart, detail.byteEnd).toString("utf8");
    if (!slice.includes(detail.text)) broken.push(`${detail.anchor}: ${file}[${detail.byteStart},${detail.byteEnd}) does not contain the cue text`);
  }
  assert.deepEqual(broken, []);
});

test("R22 units are ordered, disjoint, and never cover more bytes than the raw file holds", () => {
  const ws = workspace();
  harvestInterview(ws);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  const entry = readJson(join(knowledge, "index.json"))[0];
  let covered = 0;
  let previousEnd = -1;
  for (const unit of entry.units) {
    assert.ok(unit.byteStart >= previousEnd, `${unit.anchor} overlaps the previous unit`);
    assert.ok(unit.byteEnd > unit.byteStart, `${unit.anchor} is empty`);
    covered += unit.byteEnd - unit.byteStart;
    previousEnd = unit.byteEnd;
  }
  assert.equal(entry.accounting.model, "raw-bytes");
  assert.ok(covered <= entry.bytes, `covered ${covered} > raw ${entry.bytes}`);
  assert.equal(previousEnd, 4162, "the last cue ends at the last raw byte");
});

test("R16 three sources for one person never share an anchor id", () => {
  const ws = workspace();
  const env = { HOME: ws.home };
  const slack = distilly(["parse-chat", fixtures.multiSlack, "--users", fixtures.multiUsers, "--person", "ms", "--json"], { cwd: ws.root, env });
  assert.equal(slack.status, 0, slack.stderr);
  const feishu = distilly(["parse-chat", fixtures.multiFeishu, "--person", "ms", "--json"], { cwd: ws.root, env });
  assert.equal(feishu.status, 0, feishu.stderr);
  const doc = distilly(["harvest", fixtures.multiPostmortem, "--person", "ms", "--json"], { cwd: ws.root, env });
  assert.equal(doc.status, 0, doc.stderr);

  const knowledge = join(person(ws, "ms"), "knowledge");
  const ledger = readJson(join(knowledge, "index.json"));
  assert.deepEqual(ledger.map((entry) => entry.id), ["k0001", "k0036", "k0054"]);

  const owners = new Map();
  for (const entry of ledger) {
    for (const anchor of entry.anchors) {
      if (!owners.has(anchor)) owners.set(anchor, []);
      owners.get(anchor).push(entry.locations.text);
    }
  }
  const shared = [...owners.entries()].filter(([, files]) => files.length > 1).map(([anchor, files]) => `${anchor} -> ${files.join(" & ")}`);
  assert.deepEqual(shared, [], `anchor ids claimed by more than one source:\n${shared.join("\n")}`);

  // The same invariant seen from knowledge/text: one [k00NN] line lives in exactly one file.
  const lineOwners = new Map();
  for (const name of ["chat.md", "feishu.md", "synthetic-multisource.md"]) {
    const text = readFileSync(join(knowledge, "text", name), "utf8");
    for (const m of text.matchAll(/^\[(k\d{4})\]/gm)) lineOwners.set(m[1], [...(lineOwners.get(m[1]) ?? []), name]);
  }
  const duplicatedLines = [...lineOwners.entries()].filter(([, files]) => files.length > 1).map(([anchor]) => anchor);
  assert.deepEqual(duplicatedLines, []);
});

test("R16 SKILL.md's simplest flow — one subtitle plus one `note` — keeps the note's anchor distinct from the subtitle's", () => {
  const ws = workspace();
  harvestInterview(ws);
  const run = distilly(["note", "--from", "-", "--person", "lin-gong", "--json"], {
    cwd: ws.root,
    env: { HOME: ws.home },
    input: "用户口述：他开会从不迟到。\n",
  });
  assert.equal(run.status, 0, run.stderr);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  const ledger = readJson(join(knowledge, "index.json"));
  assert.equal(ledger.length, 2);
  const subtitleAnchors = new Set(ledger[0].anchors);
  const noteParagraphs = ledger[1].anchors.filter((anchor) => !anchor.includes(":"));
  assert.equal(noteParagraphs.length, 1);
  assert.equal(subtitleAnchors.has(noteParagraphs[0]), false, `note anchor ${noteParagraphs[0]} already names a subtitle cue`);
  const noteText = readFileSync(join(knowledge, "text", "note.md"), "utf8");
  assert.match(noteText, /^\[k0039\] 用户口述：他开会从不迟到。$/m, "the next free paragraph id after k0038 is k0039");
});

test("R17 harvesting the same directory twice leaves ledger, text files and derived output unchanged", () => {
  const ws = workspace();
  const env = { HOME: ws.home };
  harvestInterview(ws);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  const ledgerBefore = sha256File(join(knowledge, "index.json"));
  const textBefore = hashDir(join(knowledge, "text"));

  const retro1 = distilly(["retrospect", "--person", "lin-gong", "--json"], { cwd: ws.root, env });
  assert.equal(retro1.status, 0, retro1.stderr);
  const derivedBefore = hashDir(join(person(ws, "lin-gong"), "evidence", "derived"));

  const second = harvestInterview(ws);
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].appended, false);
  assert.equal(second.entries[0].reason, "identical bytes already recorded as k0001 (sha256 51682f8945af9a2482f6ac3f8217db5800a978a9b41c1f4f0a470aa2ee94dfb3)");
  assert.equal(sha256File(join(knowledge, "index.json")), ledgerBefore);
  assert.deepEqual(Object.keys(hashDir(join(knowledge, "text"))), ["subtitle.md"], "a repeat harvest must not add text files");
  assert.deepEqual(hashDir(join(knowledge, "text")), textBefore);

  const retro2 = distilly(["retrospect", "--person", "lin-gong", "--json"], { cwd: ws.root, env });
  assert.equal(retro2.status, 0, retro2.stderr);
  assert.deepEqual(receipt(retro2).warnings, []);
  assert.deepEqual(hashDir(join(person(ws, "lin-gong"), "evidence", "derived")), derivedBefore, "the same corpus must derive the same bytes whether harvested once or twice");
});

test("R19 a file that is not a recognised export is reported by name with 'No guess was made'", () => {
  const ws = workspace();
  const body = harvestInterview(ws);
  assert.equal(body.ok, true);
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0], /view\.template\.json is not a recognised chat export\. Looked for: /);
  assert.match(body.warnings[0], /No guess was made\.$/);
  assert.equal(body.entries.length, 1, "the template file must not become a ledger entry");
});

test("R20 `note --from -` records model-read material; empty input is refused", () => {
  const ws = workspace();
  harvestInterview(ws);
  const run = distilly(["note", "--from", "-", "--person", "lin-gong", "--json"], {
    cwd: ws.root,
    env: { HOME: ws.home },
    input: "用户口述：他开会从不迟到。\n",
  });
  assert.equal(run.status, 0, run.stderr);
  const body = receipt(run);
  assert.equal(body.ok, true);
  assert.deepEqual(body.warnings, [
    "this text was written by a model that read the source material; it is model-mediated, not a first-hand capture",
  ]);
  const knowledge = join(person(ws, "lin-gong"), "knowledge");
  const entry = readJson(join(knowledge, "index.json"))[1];
  assert.equal(entry.kind, "note");
  assert.equal(entry.method, "model-read");
  assert.equal(entry.credentialed, false);
  assert.equal(readFileSync(join(knowledge, "raw", "note", "stdin.md"), "utf8"), "用户口述：他开会从不迟到。\n");

  const empty = distilly(["note", "--from", "-", "--person", "lin-gong", "--json"], { cwd: ws.root, env: { HOME: ws.home }, input: "" });
  assert.equal(empty.status, 1);
  const refused = receipt(empty);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "note/empty");
  assert.equal(refused.error.message, "--from - holds no text; an empty note is not recorded");
});

test("R21 identity.json: a handle claimed twice exits 2 with the exact message and writes nothing", () => {
  const ws = workspace();
  const env = { HOME: ws.home };
  const duplicate = join(ws.root, "id-dup.json");
  writeFileSync(duplicate, JSON.stringify({ people: [{ name: "A", handles: ["x"] }, { name: "B", handles: ["x"] }] }));
  const bad = distilly(["harvest", fixtures.multiFeishu, "--person", "idr", "--identity", duplicate, "--json"], { cwd: ws.root, env });
  assert.equal(bad.status, 2);
  const refused = receipt(bad);
  assert.equal(refused.error.code, "harvest/identity");
  assert.equal(refused.error.message, 'identity.json: handle "x" is claimed by both "A" and "B"');
  // IDENTITY.md 纪律: "非法 JSON 同样响亮失败，且不写任何文件".
  // Observed on dot-skill-test: skills/colleague/idr/identity.json is copied before the map is validated.
  assert.equal(existsSync(person(ws, "idr")), false, `written: ${existsSync(person(ws, "idr")) ? fileTree(person(ws, "idr")).join(", ") : "nothing"}`);
});

test("R21 identity.json: a valid map canonicalises the speaker at record time and is noted in the ledger", () => {
  const ws = workspace();
  const env = { HOME: ws.home };
  const ok = join(ws.root, "id-ok.json");
  writeFileSync(ok, JSON.stringify({ people: [{ name: "林工", handles: ["ou_lin", "U02"] }] }));
  const good = distilly(["harvest", fixtures.multiFeishu, "--person", "idq", "--identity", ok, "--json"], { cwd: ws.root, env });
  assert.equal(good.status, 0, good.stderr);
  const knowledge = join(person(ws, "idq"), "knowledge");
  const entry = readJson(join(knowledge, "index.json"))[0];
  assert.deepEqual(entry.identity, { file: "identity.json", handles: ["ou_lin"], turns: 12 });
  const text = readFileSync(join(knowledge, "text", "synthetic-multisource.md"), "utf8");
  assert.match(text, /^\[k0001\] 2024-02-12T09:00:00\.000Z 林工：评审前我把风险清单发群里，谁有补充直接说。$/m);
  assert.equal(text.includes("ou_lin："), false);
});

test("R21 identity.json with a person that lists no handles is a warning, not a crash", () => {
  const ws = workspace();
  const map = join(ws.root, "id-nohandles.json");
  writeFileSync(map, JSON.stringify({ people: [{ name: "林工" }] }));
  const run = distilly(["harvest", fixtures.multiSlack, "--person", "idp", "--identity", map, "--json"], { cwd: ws.root, env: { HOME: ws.home } });
  const body = receipt(run);
  // Observed on dot-skill-test: exit 1, error.code "unexpected", message "Cannot access 'warnings' before initialization".
  assert.equal(run.status, 0, `error=${JSON.stringify(body.error)}`);
  assert.deepEqual(body.warnings, ['"林工" lists no handles; only its own name is canonicalised']);
});
