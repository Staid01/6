/**
 * Requirements audit · Render step (RENDER.md §1 §3 §4 §6 §7 §8; ACCEPTANCE §5;
 * SKILL.md Step 5; plan §11.3 / §11.4).
 *
 * R36 view check exits 0/1, errors block rendering, diagnostics are self-repairing
 * R37 eight fixed segments, kinds, anchor syntax and confidence are validated
 * R38 view check confirms every anchor resolves in knowledge/index.json (SKILL.md Step 5.1)
 * R39 render is deterministic and the receipt sha256 matches the html on disk
 * R40 single-file offline html: no http(s), exact CSP, one <html>, one charset, size budget
 * R41 private by default: no quote bytes; --shareable inlines and records the sources
 * R42 the 12-character quote-leak rule is an error in private mode
 * R43 a failed check writes no artefact
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { distilly, fixtures, interviewView, receipt, repoRoot, sha256, sha256File, workspace } from "./helpers.mjs";

const QUOTE = "后端，八年。主要是交易链路，最近三年在做出入金和对账。";
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

function prepared(view = interviewView()) {
  const ws = workspace();
  const env = { HOME: ws.home };
  const harvest = distilly(["harvest", fixtures.interviewDir, "--person", "lin-gong", "--json"], { cwd: ws.root, env });
  assert.equal(harvest.status, 0, harvest.stderr);
  const personDir = join(ws.root, "skills", "colleague", "lin-gong");
  mkdirSync(join(personDir, "views"), { recursive: true });
  writeFileSync(join(personDir, "views", "lin-gong.view.json"), `${JSON.stringify(view, null, 2)}\n`);
  return {
    ws,
    personDir,
    htmlPath: join(personDir, "views", "lin-gong.html"),
    receiptPath: join(personDir, "evidence", "renders", "receipt.json"),
    check: (extra = []) => distilly(["view", "check", "--person", "lin-gong", ...extra, "--json"], { cwd: ws.root, env }),
    render: (extra = []) => distilly(["view", "render", "--person", "lin-gong", ...extra, "--json"], { cwd: ws.root, env }),
  };
}

test("R36/R37 a seven-section view with real anchors passes `view check` with an exact summary", () => {
  const site = prepared();
  const run = site.check();
  assert.equal(run.status, 0, run.stderr);
  const body = receipt(run);
  assert.equal(body.ok, true);
  assert.deepEqual(body.diagnostics, []);
  assert.deepEqual(body.summary, { shareable: false, segments: 8, sections: 7, items: 7, evidence: 9, anchors: 9, cited: 9, uncited: 0, quoteLeaks: 0 });
  assert.deepEqual(body.anchors, { total: 9, cited: 9 });
});

test("R39 two renders produce identical bytes and the receipt names the html's real sha256 and size", () => {
  const site = prepared();
  const first = site.render();
  assert.equal(first.status, 0, first.stderr);
  const html1 = sha256File(site.htmlPath);
  const receipt1 = readFileSync(site.receiptPath);
  const second = site.render();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(sha256File(site.htmlPath), html1);
  assert.ok(readFileSync(site.receiptPath).equals(receipt1), "receipt.json must be byte-identical across runs");

  const stored = JSON.parse(receipt1.toString("utf8"));
  assert.deepEqual(stored.outputs, [{ bytes: statSync(site.htmlPath).size, path: "views/lin-gong.html", sha256: html1 }]);
  assert.equal(stored.generated_at, "2026-09-22T00:00:00Z");
  assert.deepEqual(stored.inlined_sources, []);
  assert.deepEqual(receipt(first).outputs.map((item) => item.sha256), [html1]);
});

test("R40 the page is a single offline file: no http(s), the exact CSP, one <html>, one charset, within budget", () => {
  const site = prepared();
  assert.equal(site.render().status, 0);
  const html = readFileSync(site.htmlPath, "utf8");
  assert.deepEqual(html.match(/https?:\/\/[^\s"'<>)]+/g) ?? [], []);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g) ?? [];
  assert.equal(csp.length, 1);
  assert.equal(csp[0], `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  assert.equal((html.match(/<html[\s>]/g) ?? []).length, 1);
  assert.equal((html.match(/<meta charset/g) ?? []).length, 1);
  assert.ok(Buffer.byteLength(html) <= 120 * 1024, `page is ${Buffer.byteLength(html)} bytes, budget 120 KB`);
  assert.ok(statSync(join(repoRoot, "assets", "distilly-template.html")).size <= 60 * 1024, "template budget 60 KB");
});

test("R41 private mode strips quotes from the page; --shareable inlines them and records the source", () => {
  const site = prepared();
  assert.equal(site.render().status, 0);
  const privateHtml = readFileSync(site.htmlPath, "utf8");
  assert.equal(privateHtml.includes(QUOTE), false, "private mode must not carry source wording");
  assert.deepEqual(JSON.parse(readFileSync(site.receiptPath, "utf8")).inlined_sources, []);

  const shareable = site.render(["--shareable"]);
  assert.equal(shareable.status, 0, shareable.stderr);
  const sharedHtml = readFileSync(site.htmlPath, "utf8");
  assert.equal(sharedHtml.includes(QUOTE), true);
  assert.deepEqual(JSON.parse(readFileSync(site.receiptPath, "utf8")).inlined_sources, [
    { anchor: "k0002", kind: "message", path: "knowledge/text/subtitle.md", quote_bytes: Buffer.byteLength(QUOTE), quote_sha256: sha256(Buffer.from(QUOTE, "utf8")), source: "subtitle" },
  ]);
  assert.notEqual(sha256(sharedHtml), sha256(privateHtml));
});

test("R42/R43 a claim that repeats >= 12 characters of a quote is VIEW_QUOTE_LEAK, and render leaves the page untouched", () => {
  const site = prepared();
  assert.equal(site.render().status, 0);
  const before = sha256File(site.htmlPath);
  const view = interviewView();
  view.sections[0].items[0].text = QUOTE;
  writeFileSync(join(site.personDir, "views", "lin-gong.view.json"), `${JSON.stringify(view, null, 2)}\n`);

  const check = site.check();
  assert.equal(check.status, 1);
  const body = receipt(check);
  assert.equal(body.ok, false);
  assert.deepEqual(body.diagnostics.map((item) => [item.code, item.severity]), [["VIEW_QUOTE_LEAK", "error"]]);
  assert.deepEqual(Object.keys(body.diagnostics[0]).sort(), ["code", "evidence", "message", "severity", "subject", "supportedFixes"]);

  const render = site.render();
  assert.equal(render.status, 1);
  assert.equal(sha256File(site.htmlPath), before, "a failed check must not rewrite views/<slug>.html");
});

test("R37 structural errors are named: missing segment, bad kind, bad anchor syntax, bad confidence", () => {
  const cases = [
    ["VIEW_SECTION_MISSING", (view) => { view.sections = view.sections.filter((section) => section.id !== "timeline"); }],
    ["VIEW_KIND_INVALID", (view) => { view.sections[1].kind = "bullets"; }],
    ["VIEW_ANCHOR_FORMAT", (view) => { view.sections[1].items[0].anchors = ["k12"]; }],
    ["VIEW_CONFIDENCE_INVALID", (view) => { view.sections[1].items[0].confidence = "sure"; }],
  ];
  for (const [code, mutate] of cases) {
    const view = interviewView();
    mutate(view);
    const site = prepared(view);
    const run = site.check();
    assert.equal(run.status, 1, `${code}: exit ${run.status}`);
    const body = receipt(run);
    const codes = body.diagnostics.filter((item) => item.severity === "error").map((item) => item.code);
    assert.ok(codes.includes(code), `${code} expected, got ${codes.join(",")}`);
    assert.equal(existsSync(site.htmlPath), false);
  }
});

test("R38 SKILL.md Step 5.1: `view check` rejects an anchor that does not exist in knowledge/index.json", () => {
  const view = interviewView();
  view.sections[0].items[0].anchors = ["k9999"];
  view.evidence.push({ anchor: "k9999", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "不存在的锚点" });
  const site = prepared(view);
  const check = site.check();
  const body = receipt(check);
  // SKILL.md Step 5.1: "先 distilly view check，确认锚点都能回指到 knowledge/index.json".
  // plan §11.3: "每个锚点必须能在 knowledge/index.json 里回指" with diagnostic view/orphan-anchor.
  // Observed on dot-skill-test: ok:true, exit 0, only VIEW_EVIDENCE_UNCITED (warning).
  assert.equal(check.status, 1, `diagnostics=${JSON.stringify(body.diagnostics.map((item) => item.code))}`);
  assert.equal(body.ok, false);
  assert.equal(site.render().status, 1, "render must refuse a page whose anchor cannot be traced");
});
