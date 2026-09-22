/**
 * Shared helpers for the requirements audit (tests/audit/*.test.mjs).
 *
 * Every test here is black-box: it spawns `node bin/distilly.mjs …` (or a
 * `scripts/*.mjs` entry) the way a user or the SKILL.md instructions would, in a
 * throw-away workspace, and asserts literal values. Nothing imports `src/`.
 *
 * Plain `.mjs` (not `*.test.mjs`) so `node --test tests/audit/*.test.mjs` does not
 * collect it as a suite.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const cliPath = join(repoRoot, "bin", "distilly.mjs");
export const corpusRoot = join(repoRoot, "tests", "fixtures", "public-corpus");

export const fixtures = {
  interviewDir: join(corpusRoot, "synthetic-interview"),
  interviewSrt: join(corpusRoot, "synthetic-interview", "transcript.srt"),
  interviewTemplate: join(corpusRoot, "synthetic-interview", "expected", "view.template.json"),
  houseDir: join(corpusRoot, "us-house-floor-2009-07-29"),
  houseSrt: join(corpusRoot, "us-house-floor-2009-07-29", "transcript.srt"),
  multiDir: join(corpusRoot, "synthetic-multisource"),
  multiSlack: join(corpusRoot, "synthetic-multisource", "slack-messages.json"),
  multiUsers: join(corpusRoot, "synthetic-multisource", "users.json"),
  multiFeishu: join(corpusRoot, "synthetic-multisource", "feishu-page.json"),
  multiPostmortem: join(corpusRoot, "synthetic-multisource", "postmortem.md"),
};

/** A fresh workspace; `DISTILLY_HOME` and `HOME` point inside it so nothing leaks. */
export function workspace(prefix = "dst-audit-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const distillyHome = join(root, "distilly-home");
  return { root, home, distillyHome };
}

/** Spawn the CLI as a user would: `node bin/distilly.mjs <args>` inside `cwd`. */
export function distilly(args, { cwd, env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Spawn a repository script (`scripts/<name>.mjs`). */
export function script(name, args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", name), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * CONTRACT §3 says `--json` stdout carries exactly one JSON object, so the whole
 * stdout must parse. Anything else is reported as a contract breach.
 */
export function receipt(run) {
  const text = run.stdout.trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`stdout is not a single JSON receipt (${error.message}). stdout=<<${run.stdout.slice(0, 300)}>> stderr=<<${run.stderr.slice(0, 300)}>>`);
  }
}

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
export const sha256File = (path) => sha256(readFileSync(path));

/** Sorted relative paths of every file under `dir`. */
export function fileTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** sha256 of every file directly under `dir`, keyed by file name. */
export function hashDir(dir) {
  const hashes = {};
  for (const name of readdirSync(dir).sort()) hashes[name] = sha256File(join(dir, name));
  return hashes;
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Every `k00NN` / `k00NN:tM` anchor id the ledger declares for a person. */
export function ledgerAnchors(ledgerPath) {
  const known = new Set();
  for (const entry of readJson(ledgerPath)) {
    for (const anchor of entry.anchors ?? []) known.add(typeof anchor === "string" ? anchor : anchor.anchor ?? anchor.id);
  }
  return known;
}

/** Anchor-shaped strings anywhere inside a JSON value. */
export function anchorsInJson(value, found = new Set()) {
  if (typeof value === "string") {
    if (/^k\d{4}(?::t\d+)?$/.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) anchorsInJson(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) anchorsInJson(item, found);
  }
  return found;
}

/**
 * A seven-section `view.json` an author would write for the synthetic interview,
 * citing anchors that exist in its ledger (k0001…k0038, one per cue).
 */
export function interviewView(slug = "lin-gong") {
  return {
    meta: { slug, title: "林工 · 排障与带人风格画像", lang: "zh-CN", generated_at: "2026-09-22T00:00:00Z", theme: "auto" },
    sections: [
      { id: "portrait", kind: "claims", title: "一句话画像", items: [{ text: "八年后端，交易链路出身，遇事先对账再动代码", anchors: ["k0002", "k0004"], confidence: "high", emphasis: true }] },
      { id: "communication", kind: "claims", title: "沟通风格", items: [{ text: "说话直接，自认容易得罪人", anchors: ["k0032"], confidence: "high" }] },
      { id: "values", kind: "claims", title: "决策与价值观", items: [{ text: "选型优先看团队能否维护，偏好成熟技术", anchors: ["k0022", "k0024"], confidence: "medium" }] },
      { id: "workstyle", kind: "claims", title: "工作方式", items: [{ text: "排障顺序是数据、日志、代码", anchors: ["k0006"], confidence: "high" }] },
      { id: "relationship", kind: "claims", title: "关系与称呼", items: [{ text: "带四人小组，用边界与验收标准管理", anchors: ["k0010", "k0012"], confidence: "medium" }] },
      { id: "boundaries", kind: "warnings", title: "边界与雷区", items: [{ text: "离职原因属于回避话题", anchors: ["k0018"], confidence: "medium", severity: "medium" }] },
      { id: "timeline", kind: "timeline", title: "时间线演变", items: [{ text: "访谈开场自我介绍", anchors: ["k0002"], at: "00:00:05", confidence: "medium" }] },
    ],
    evidence: [
      { anchor: "k0002", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "自我介绍", quote: "后端，八年。主要是交易链路，最近三年在做出入金和对账。" },
      { anchor: "k0004", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "先对账" },
      { anchor: "k0006", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "排障顺序" },
      { anchor: "k0010", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "带人" },
      { anchor: "k0012", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "边界" },
      { anchor: "k0018", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "回避" },
      { anchor: "k0022", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "选型" },
      { anchor: "k0024", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "无聊技术" },
      { anchor: "k0032", source: "subtitle", kind: "message", path: "knowledge/text/subtitle.md", note: "自评" },
    ],
  };
}

/** The `work.md` / `persona.md` / `meta.json` a Distill step hands to `skill create`. */
export const distillInputs = {
  work: [
    "# Work",
    "",
    "## 负责范围",
    "- 交易链路、出入金与对账 [k0002]",
    "",
    "## 工作流程",
    "- 排障顺序：先看数据，再看日志，最后看代码 [k0006]",
    "",
    "## 输出偏好",
    "- 文档先写结论，再写为什么，最后写回滚 [k0026]",
    "",
    "## 经验知识",
    "- 告警要少，一天响二十次等于没告警 [k0030]",
    "",
  ].join("\n"),
  persona: [
    "# 林工 — Persona",
    "",
    "## Layer 0：核心性格（最高优先级）",
    "- 说话直，不绕弯 [k0032]",
    "- 钱对不上先翻账，不先改代码 [k0004]",
    "",
    "## Layer 1：身份",
    "- 后端八年，交易链路 [k0002]",
    "",
    "## Layer 2：表达风格",
    "- 短句，先给结论 [k0026]",
    "",
    "## Layer 3：决策与判断",
    "- 选型先看团队会不会维护 [k0022]",
    "",
    "## Layer 4：人际行为",
    "- 带人给边界和验收标准 [k0010]",
    "",
    "## Layer 5：边界与雷区",
    "- 离职原因不愿细说 [k0018]",
    "",
  ].join("\n"),
  meta: `${JSON.stringify({ name: "林工", display_name: "林工", character: "colleague" }, null, 2)}\n`,
};
