#!/usr/bin/env node
/**
 * Entry-surface check: the command surface `docs/v2/CONTRACT.md` §1 promises,
 * diffed literally against what `bin/distilly.mjs` answers at every `--help` level
 * and at runtime.
 *
 *   node scripts/check-entry-surface.mjs [--baseline <file>] [--claims <file>...]
 *                                        [--write-baseline] [--json]
 *
 * Sections, each a literal diff. A `-` line is promised and unreachable, a `+` line
 * is reachable and unpromised. Either direction is a finding.
 *
 *   1. commands      CONTRACT §1 command names vs the registered names in `--help`
 *   2. enumerations  every `<a|b|c>` group in §1 vs the same group in `<cmd> --help`
 *   3. flags         every `--flag` in §1 appears in `<cmd> --help`
 *   4. bilingual     every registered command's `--help` exits 0 and has `## English`
 *   5. channels      `collect <channel> --json` in an empty HOME is refused about
 *                    credentials, never as an unknown or planned channel
 *   6. error codes   codes documented in markdown (and in `--claims` files, such as
 *                    a PR body) vs codes the source can emit and codes observed in 5
 *   7. release check `scripts/check_release.mjs` criteria, with the ones that only
 *                    grep text marked (informational, never a finding)
 *
 * `--baseline` names a file of finding lines that are known and tolerated. A finding
 * not in the baseline fails. A baseline line that no longer occurs also fails, so
 * the baseline can only shrink. `--write-baseline` rewrites that file from this run.
 *
 * No git remote name, branch name or network is used. The CLI is driven the way a
 * user drives it, through `node bin/distilly.mjs`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "bin", "distilly.mjs");

const argv = process.argv.slice(2);
const flagValues = (name) => argv.flatMap((arg, index) => (arg === name && argv[index + 1] ? [argv[index + 1]] : []));
const baselinePath = flagValues("--baseline")[0] ?? null;
const claimFiles = flagValues("--claims");
const writeBaseline = argv.includes("--write-baseline");
const asJson = argv.includes("--json");

const BARE = /^[a-z][a-z0-9-]*$/;
const UNREACHABLE_CODES = new Set(["collect/unknown-channel", "collect/planned-channel", "not-implemented", "unknown-command"]);

const findings = [];
const notes = [];
// `line` is the stable key a baseline matches on; `detail` carries locations and
// may change between runs (a claims file adds one) without changing the finding.
const finding = (section, line, detail = null) => findings.push({ section, line, detail });

function run(args, { env = {}, timeout = 30_000 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const helpCache = new Map();
function help(name) {
  if (!helpCache.has(name)) helpCache.set(name, run([...(name ? name.split(" ") : []), "--help"]));
  return helpCache.get(name);
}

/* ---------------------------------------------------------------- contract */

/** Split on `|` outside angle brackets: `view check | view render` yes, `<a|b>` no. */
function splitSegments(text) {
  const segments = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "<") depth += 1;
    if (character === ">") depth -= 1;
    if (character === "|" && depth === 0) {
      segments.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Members of `<a|b|c>` groups, normalised to bare tokens (`x.eml` to `eml`, `file...` to `file`). */
function groupMembers(group) {
  return group
    .split("|")
    .map((member) => member.trim().replace(/\.\.\.$/, "").replace(/^[a-z]\./, "").replace(/^\./, ""))
    .filter((member) => BARE.test(member));
}

function parseContract(text) {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => /^##\s+1\./.test(line));
  if (heading < 0) throw new Error("CONTRACT.md has no `## 1.` heading");
  const open = lines.findIndex((line, index) => index > heading && /^```/.test(line));
  const close = lines.findIndex((line, index) => index > open && /^```/.test(line));
  if (open < 0 || close < 0) throw new Error("CONTRACT.md §1 has no fenced command block");

  const commands = new Map(); // name -> { groups: [[members]], flags: Set, line }
  const twoToken = new Set();
  const segmentsByCommand = [];
  for (let index = open + 1; index < close; index += 1) {
    const raw = lines[index];
    const lineNumber = index + 1;
    const commandPart = raw.split(/\s{2,}/)[0].replace(/[^\x20-\x7e].*$/, "").trim();
    if (!commandPart) continue;
    for (const segment of splitSegments(commandPart)) {
      const tokens = segment.split(/\s+/);
      const name = tokens[0];
      if (!BARE.test(name)) continue;
      const entry = commands.get(name) ?? { groups: [], flags: new Set(), lines: [] };
      entry.lines.push(lineNumber);
      for (const match of segment.matchAll(/<([^<>]*\|[^<>]*)>/g)) entry.groups.push(groupMembers(match[1]));
      for (const match of segment.matchAll(/(^|\s)(--[a-z][a-z-]*)/g)) entry.flags.add(match[2]);
      commands.set(name, entry);
      segmentsByCommand.push({ name, second: tokens[1] ?? null, segment, lineNumber });
    }
  }
  // `A B` is a two-token command when B is a bare word and no `<...>` group of A lists B
  // (`view check` is one, `collect x --mode browser` is a usage example of `collect`).
  for (const { name, second } of segmentsByCommand) {
    if (!second || !BARE.test(second)) continue;
    const enumerated = (commands.get(name)?.groups ?? []).some((members) => members.includes(second));
    if (!enumerated) twoToken.add(`${name} ${second}`);
  }
  return { commands, twoToken, fence: [open + 2, close] };
}

/* --------------------------------------------------------------------- cli */

/** Registered names from the top-level `--help`, read from the 已实现 block. */
function parseTopHelp(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^已实现[:：]/.test(line));
  const registered = [];
  if (start < 0) return { registered, planned: null, hasBlock: false };
  for (let index = start + 1; index < lines.length && lines[index].trim() !== ""; index += 1) {
    const match = lines[index].trim().match(/^distilly\s+(\S+)(?:\s+(\S+))?/);
    if (!match) continue;
    registered.push(match[2] && BARE.test(match[2]) ? `${match[1]} ${match[2]}` : match[1]);
  }
  const plannedStart = lines.findIndex((line) => /^契约中已冻结/.test(line));
  const planned = plannedStart < 0 ? null : (lines[plannedStart + 1] ?? "").trim();
  return { registered, planned, hasBlock: true };
}

function firstUsageGroup(helpText) {
  const usage = helpText.split("\n")[0] ?? "";
  const match = usage.match(/<([^<>]*\|[^<>]*)>/);
  return match ? groupMembers(match[1]) : null;
}

const wordIn = (text, token) => new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);

/* ------------------------------------------------------------- 1 commands */

const contract = parseContract(readFileSync(join(root, "docs", "v2", "CONTRACT.md"), "utf8"));
const top = help("");
const { registered, planned, hasBlock } = parseTopHelp(top.stdout);
const registeredSet = new Set(registered);

if (top.status !== 0) finding("commands", `-distilly --help exits ${top.status}`);
if (!hasBlock) finding("commands", "-distilly --help has no 已实现 block");
if (planned) for (const name of planned.split(/[,，\s]+/).filter(Boolean)) finding("commands", `-${name} (listed as planned, not implemented)`);

for (const name of [...contract.commands.keys()].sort()) {
  if (!registeredSet.has(name)) finding("commands", `-${name}`);
}
for (const name of [...contract.twoToken].sort()) {
  if (!registeredSet.has(name)) finding("commands", `-${name}`);
}
for (const name of registered.slice().sort()) {
  const [head, tail] = name.split(" ");
  if (!tail) {
    if (!contract.commands.has(head)) finding("commands", `+${name}`);
    continue;
  }
  const viaGroup = (contract.commands.get(head)?.groups ?? []).some((members) => members.includes(tail));
  if (!contract.twoToken.has(name) && !viaGroup) finding("commands", `+${name}`);
}

/* --------------------------------------------------------- 2 enumerations */

const enumerationRows = [];
for (const [name, entry] of [...contract.commands.entries()].sort()) {
  if (entry.groups.length === 0 || !registeredSet.has(name)) continue;
  const text = help(name).stdout;
  const cliGroup = firstUsageGroup(text);
  for (const promised of entry.groups) {
    if (promised.length < 2) continue;
    if (cliGroup) {
      enumerationRows.push(`${name}  contract <${promised.join("|")}>  cli <${cliGroup.join("|")}>`);
      for (const member of promised) if (!cliGroup.includes(member)) finding("enumerations", `-${name}: ${member}`);
      for (const member of cliGroup) if (!promised.includes(member)) finding("enumerations", `+${name}: ${member}`);
    } else {
      enumerationRows.push(`${name}  contract <${promised.join("|")}>  cli usage has no group, members looked up in help text`);
      for (const member of promised) if (!wordIn(text, member)) finding("enumerations", `-${name}: ${member}`);
    }
  }
}

/* ---------------------------------------------------------------- 3 flags */

for (const [name, entry] of [...contract.commands.entries()].sort()) {
  if (!registeredSet.has(name)) continue;
  const targets = [name, ...[...contract.twoToken].filter((two) => two.startsWith(`${name} `))];
  const text = targets.map((target) => help(target).stdout).join("\n");
  for (const flag of [...entry.flags].sort()) if (!text.includes(flag)) finding("flags", `-${name}: ${flag}`);
}

/* ------------------------------------------------------------ 4 bilingual */

for (const name of ["", ...registered]) {
  const { status, stdout } = help(name);
  const label = name || "(top level)";
  if (status !== 0) finding("bilingual", `-${label}: --help exits ${status}`);
  if (!/^## English\b/m.test(stdout)) finding("bilingual", `-${label}: --help lacks ## English`);
}

/* ------------------------------------------------------------- 5 channels */

const channelRows = [];
const observedCodes = new Map(); // code -> channels
const collectGroup = (contract.commands.get("collect")?.groups ?? []).find((members) => members.length >= 2) ?? [];
if (registeredSet.has("collect")) {
  const home = mkdtempSync(join(tmpdir(), "distilly-surface-"));
  try {
    for (const channel of collectGroup) {
      const { status, stdout } = run(["collect", channel, "--json"], { env: { HOME: home, USERPROFILE: home } });
      let code = "(no receipt)";
      const start = stdout.indexOf("{");
      if (start !== -1) {
        try {
          const receipt = JSON.parse(stdout.slice(start));
          // Channel modules report a refusal in `unavailable[].reason` as `<code>: <text>`
          // rather than in `error.code`; the leading token is the literal to compare.
          code = receipt.error?.code ?? receipt.unavailable?.[0]?.reason?.split(":")[0]?.trim() ?? "(receipt without error.code)";
        } catch {
          code = "(unparsable receipt)";
        }
      }
      const reachable = !UNREACHABLE_CODES.has(code);
      channelRows.push(`${channel.padEnd(10)} exit ${String(status).padEnd(4)} ${code.padEnd(32)} ${reachable ? "reachable" : "UNREACHABLE"}`);
      if (!observedCodes.has(code)) observedCodes.set(code, []);
      observedCodes.get(code).push(channel);
      if (!reachable) finding("channels", `-collect ${channel}: ${code}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------- 6 error codes */

function* markdownFiles(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (/\.md$/i.test(entry)) yield path;
  }
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.mjs$/.test(entry)) yield path;
  }
}

const emittable = new Set();
for (const directory of ["src", "bin"].map((name) => join(root, name)).filter(existsSync)) {
  for (const file of sourceFiles(directory)) {
    for (const match of readFileSync(file, "utf8").matchAll(/code:\s*["'`]([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)["'`]/g)) emittable.add(match[1]);
  }
}
const namespaces = new Set([...contract.commands.keys(), ...[...emittable].map((code) => code.split("/")[0])]);

const documented = new Map(); // code -> ["file:line"]
const scanForCodes = (text, label) => {
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/`([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)`/g)) {
      if (!namespaces.has(match[1])) continue;
      const code = `${match[1]}/${match[2]}`;
      if (!documented.has(code)) documented.set(code, []);
      documented.get(code).push(`${label}:${index + 1}`);
    }
  });
};
const docRoots = ["docs", "SKILL.md", "README.md", "INSTALL.md", "INSTALL_EN.md", "ROADMAP.md", "CONTRIBUTING.md"];
for (const name of docRoots) {
  const path = join(root, name);
  if (!existsSync(path)) continue;
  if (statSync(path).isDirectory()) for (const file of markdownFiles(path)) scanForCodes(readFileSync(file, "utf8"), relative(root, file));
  else scanForCodes(readFileSync(path, "utf8"), name);
}
for (const file of claimFiles) scanForCodes(readFileSync(file, "utf8"), `claims:${file}`);

for (const [code, places] of [...documented.entries()].sort()) {
  if (!emittable.has(code)) finding("error-codes", `-${code} documented but no source emits it`, `documented at ${places.join(", ")}`);
}
for (const [code, channels] of [...observedCodes.entries()].sort()) {
  if (!code.includes("/")) continue;
  if (!documented.has(code)) finding("error-codes", `+${code} observed at runtime but documented nowhere`, `observed for collect ${channels.join(", ")}`);
}

/* -------------------------------------------------------- 7 release check */

const releaseRows = [];
const releasePath = join(root, "scripts", "check_release.mjs");
if (existsSync(releasePath)) {
  const source = readFileSync(releasePath, "utf8");
  const blocks = [...source.matchAll(/\/\*\s*(\d+)\s*[—-]+\s*([^*]+?)\s*-{2,}\s*\*\/([\s\S]*?)(?=\/\*\s*\d+\s*[—-]|\nconst failed)/g)];
  for (const [, number, title, body] of blocks) {
    const kinds = [];
    const readsText = /\b(read|readFileSync)\(/.test(body);
    if (readsText && /\.(includes|test|exec|match|indexOf)\(/.test(body)) kinds.push("text-grep");
    if (/\b(execFileSync|spawnSync)\(/.test(body)) kinds.push("exec");
    if (/\bexistsSync\(/.test(body)) kinds.push("fs-exists");
    if (/JSON\.parse\(/.test(body) || /\b(SCHEMA_VERSION|LEDGER_SCHEMA_VERSION)\b/.test(body)) kinds.push("parsed-value");
    const grepTargets = [...body.matchAll(/(read|readFileSync)\(([^)]*)\)/g)].map((match) => match[2].replace(/\s+/g, " ").trim());
    releaseRows.push(
      `${number}. ${title.trim()}  [${kinds.join(", ") || "unclassified"}]${kinds.includes("text-grep") ? `  greps ${grepTargets.join(" ")}` : ""}`,
    );
  }
} else notes.push("scripts/check_release.mjs is not in this tree");

/* --------------------------------------------------------------- baseline */

const lines = findings.map((item) => `${item.section}: ${item.line}`);
let known = [];
let stale = [];
let fresh = lines;
if (baselinePath) {
  const absolute = resolve(root, baselinePath);
  const baseline = existsSync(absolute)
    ? readFileSync(absolute, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    : [];
  const current = new Set(lines);
  known = lines.filter((line) => baseline.includes(line));
  fresh = lines.filter((line) => !baseline.includes(line));
  stale = baseline.filter((line) => !current.has(line));
  if (writeBaseline) {
    writeFileSync(absolute, `# Known entry-surface findings. Remove a line when its PR closes the gap. Never add one without a PR that explains it.\n${lines.join("\n")}${lines.length ? "\n" : ""}`);
    notes.push(`baseline written: ${baselinePath} (${lines.length} lines)`);
    known = lines;
    fresh = [];
    stale = [];
  }
}

const ok = fresh.length === 0 && stale.length === 0;

if (asJson) {
  console.log(JSON.stringify({ ok, findings, known, fresh, stale, enumerationRows, channelRows, releaseRows, notes }, null, 2));
} else {
  const print = (title, rows) => {
    console.log(`\n## ${title}`);
    if (rows.length === 0) console.log("  (none)");
    for (const row of rows) console.log(`  ${row}`);
  };
  console.log(`entry-surface check  contract docs/v2/CONTRACT.md §1 lines ${contract.fence[0]}-${contract.fence[1]}  cli ${relative(root, cli)}`);
  console.log(`contract commands ${contract.commands.size} (+${contract.twoToken.size} two-token)  registered ${registered.length}`);
  for (const section of ["commands", "enumerations", "flags", "bilingual", "channels", "error-codes"]) {
    print(section, findings.filter((item) => item.section === section).map((item) => (item.detail ? `${item.line}\n      ${item.detail}` : item.line)));
    if (section === "enumerations") for (const row of enumerationRows) console.log(`    ${row}`);
    if (section === "channels") for (const row of channelRows) console.log(`    ${row}`);
  }
  print("release check criteria (informational)", releaseRows);
  for (const note of notes) console.log(`note: ${note}`);
  console.log(`\nRESULT ${ok ? "PASS" : "FAIL"}  findings ${lines.length}  known ${known.length}  new ${fresh.length}  stale-baseline ${stale.length}`);
  for (const line of fresh) console.log(`  NEW   ${line}`);
  for (const line of stale) console.log(`  STALE ${line}`);
}
process.exit(ok ? 0 : 1);
