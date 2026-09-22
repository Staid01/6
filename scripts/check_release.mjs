#!/usr/bin/env node
/**
 * Release readiness for this package: the things a version bump must not forget.
 *
 * `acceptance.mjs` proves the pipeline works and `audit-objective.mjs` proves the
 * scope is closed; neither notices that the version printed by `--version` drifted
 * from `package.json`, that a migrated ledger lost its schema marker, or that a
 * `.py` file came back. Those are release-time questions, so they live here.
 *
 *   node scripts/check_release.mjs [--json] [--tag vX.Y.Z]
 *
 * Exit code 1 when any check fails. `--tag` additionally asserts that the release
 * tag names the same version the package declares.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SCHEMA_VERSION } from "../src/skill/schema.mjs";
import { LEDGER_SCHEMA_VERSION } from "../src/knowledge/ledger.mjs";

const root = resolve(import.meta.dirname, "..");
const json = process.argv.includes("--json");
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex === -1 ? null : process.argv[tagIndex + 1];
const bin = join(root, "bin", "distilly.mjs");

const rows = [];
const record = (name, ok, evidence) => rows.push({ name, ok: Boolean(ok), evidence });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function parseJson(text) {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const start =
    arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) throw new SyntaxError("no JSON in command output");
  return JSON.parse(text.slice(start));
}

/* 1 — one version, everywhere it is printed ---------------------------------- */
{
  const binVersion = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim();
  const work = mkdtempSync(join(tmpdir(), "rel-skill-"));
  try {
    execFileSync(
      process.execPath,
      [bin, "skill", "create", "--character", "colleague", "--name", "ReleaseCheck", "--slug", "release-check", "--base-dir", work, "--json"],
      { encoding: "utf8", cwd: root },
    );
    const meta = JSON.parse(readFileSync(join(work, "skills", "colleague", "release-check", "meta.json"), "utf8"));
    const productVersion = meta.version;
    const consistent = binVersion === pkg.version && productVersion !== undefined && String(productVersion).length > 0;
    record(
      "版本一致（--version 与 skill create 产物）",
      consistent,
      `package.json ${pkg.version}, --version ${binVersion}, skill create meta.version ${productVersion}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (tag !== null) {
    record("发布 tag 指向同一版本", tag === `v${pkg.version}` || tag === pkg.version, `--tag ${tag} vs ${pkg.version}`);
  }
}

/* 2 — schemas are the frozen ones, and a migration exists -------------------- */
{
  const testRun = spawnSync(process.execPath, ["--test", join(root, "tests", "schema-migration.test.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  const work = mkdtempSync(join(tmpdir(), "rel-migrate-"));
  try {
    const skillDir = join(work, "skills", "colleague", "old-person");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: 张三\n---\n\n# 张三\n", "utf8");
    writeFileSync(join(skillDir, "persona.md"), "# 张三\n", "utf8");
    writeFileSync(join(skillDir, "work.md"), "# 工作\n", "utf8");
    writeFileSync(
      join(skillDir, "meta.json"),
      JSON.stringify({ name: "张三", slug: "old-person", character: "colleague", schema_version: "3", lifecycle: { version: "v1" } }, null, 2),
      "utf8",
    );
    writeFileSync(join(skillDir, "manifest.json"), JSON.stringify({ slug: "old-person", schema_version: "3", artifacts: {} }, null, 2), "utf8");
    execFileSync(process.execPath, [bin, "skill", "migrate", "--base-dir", work, "--json"], { encoding: "utf8", cwd: root });
    const second = parseJson(execFileSync(process.execPath, [bin, "skill", "migrate", "--base-dir", work, "--json"], { encoding: "utf8", cwd: root }));
    const third = parseJson(execFileSync(process.execPath, [bin, "skill", "migrate", "--base-dir", work, "--json"], { encoding: "utf8", cwd: root }));
    const same = JSON.stringify(second) === JSON.stringify(third);
    record(
      `schema v${SCHEMA_VERSION} 与账本 v${LEDGER_SCHEMA_VERSION}，两次 migrate 回执相同`,
      SCHEMA_VERSION === "4" && testRun.status === 0 && same,
      `SCHEMA_VERSION=${SCHEMA_VERSION}, LEDGER_SCHEMA_VERSION=${LEDGER_SCHEMA_VERSION}, schema-migration.test status=${testRun.status}, receipts-equal=${same}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* 3 — the installers still carry the evidence spine -------------------------- */
{
  const destRoot = mkdtempSync(join(tmpdir(), "rel-install-"));
  const dest = join(destRoot, "distilly");
  const personRoot = mkdtempSync(join(tmpdir(), "rel-spine-"));
  try {
    execFileSync(process.execPath, [bin, "install", "--path", dest, "--json"], { encoding: "utf8", cwd: root });
    const skillDir = join(personRoot, "skills", "colleague", "old-person");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: x\n---\n", "utf8");
    writeFileSync(join(skillDir, "meta.json"), JSON.stringify({ schema_version: "3", slug: "old-person" }), "utf8");
    execFileSync(process.execPath, [join(dest, "bin", "distilly.mjs"), "skill", "migrate", "--base-dir", personRoot, "--json"], {
      encoding: "utf8",
      cwd: root,
    });
    const four = ["knowledge/raw", "knowledge/text", "evidence", "views"];
    const missing = four.filter((name) => !existsSync(join(skillDir, name)));
    const listing = readdirSync(skillDir).join(", ");
    record(
      "安装器携带 evidence spine（knowledge/raw、knowledge/text、evidence、views）",
      missing.length === 0,
      missing.length === 0 ? `install --path then ls: ${four.join(", ")} under migrated skill; skill dir: ${listing}` : `missing after install --path: ${missing.join(", ")}`,
    );
  } finally {
    rmSync(destRoot, { recursive: true, force: true });
    rmSync(personRoot, { recursive: true, force: true });
  }
}

/* 4 — the package is zero-dependency and Python-free ------------------------- */
{
  const dependencies = Object.keys(pkg.dependencies ?? {});
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  const python = tracked.filter((path) => /\.py$/.test(path) || /(^|\/)requirements\.txt$/.test(path));
  record(
    "零运行时依赖且没有 Python 残留",
    dependencies.length === 0 && python.length === 0,
    `dependencies: ${dependencies.length === 0 ? "none" : dependencies.join(", ")}; tracked .py / requirements.txt: ${python.length}`,
  );
}

/* 5 — generated artefacts are in sync with their sources -------------------- */
{
  const template = execFileSync(process.execPath, [join(root, "scripts", "generate-template.mjs"), "--check"], { encoding: "utf8" }).trim();
  const pinyin = existsSync(join(root, "assets", "pinyin.json"));
  record(
    "生成物与源同步（模板 / 拼音表）",
    /up to date/.test(template) && pinyin,
    `${template.split("\n").pop()}; assets/pinyin.json: ${pinyin}`,
  );
}

/* 6 — the gates a release claims are runnable -------------------------------- */
{
  const listed = parseJson(execFileSync(process.execPath, [join(root, "scripts", "run-gates.mjs"), "--list", "--json"], { encoding: "utf8", cwd: root }));
  const ids = listed.map((gate) => gate.id);
  const required = [
    "unit-tests",
    "acceptance-synthetic-interview",
    "acceptance-us-house",
    "acceptance-multisource",
    "prompt-lint",
    "objective-audit",
  ];
  const missing = required.filter((id) => !ids.includes(id));
  record(
    "发布所依赖的门禁都在，且 Verify 会跑",
    missing.length === 0,
    missing.length === 0 ? `run-gates --list --json ids include ${required.join(", ")}` : `missing gate ids: ${missing.join(", ")}`,
  );
}

/* 7 — documentation a release points at ------------------------------------- */
{
  const docs = ["docs/v2/CONTRACT.md", "docs/v2/ACCEPTANCE.md", "docs/v2/STATUS.md", "docs/v2/MIGRATION.md", "docs/v2/IDENTITY.md", "README.md"];
  const missing = docs.filter((path) => !existsSync(join(root, path)));
  record("发布指向的文档都在", missing.length === 0, missing.length === 0 ? `${docs.length} 份文档就位` : `缺: ${missing.join(", ")}`);
}

const failed = rows.filter((row) => !row.ok);
if (json) {
  console.log(JSON.stringify({ ok: failed.length === 0, version: pkg.version, schema: SCHEMA_VERSION, rows }, null, 2));
} else {
  console.log("发布检查 / release check\n");
  for (const row of rows) console.log(`${row.ok ? "✅" : "❌"} ${row.name}\n     ${row.evidence}`);
  console.log(`\n${rows.length - failed.length}/${rows.length} 项通过${failed.length === 0 ? "" : `；未通过：${failed.map((row) => row.name).join("；")}`}`);
}
process.exit(failed.length === 0 ? 0 : 1);
