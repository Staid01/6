#!/usr/bin/env node
/**
 * Gate runner. Every CI gate is one JSON file under `tests/gates/`, and this script
 * is the only thing CI calls. Changing what "green" means is a diff to one of those
 * files, visible in the PR that makes it.
 *
 *   node scripts/run-gates.mjs [--group <name>] [--id <id>] [--requires <tag>]
 *                              [--without <tag>] [--list] [--json] [--write-baseline]
 *
 * A gate file:
 *
 *   {
 *     "id": "unit-tests",                      // unique, equals the file name
 *     "group": "unit",                         // free grouping label
 *     "requires": ["playwright"],              // optional capability tags
 *     "command": "npm test",                   // run with `sh -c`
 *     "env": { "KEY": "value" },               // optional
 *     "pass": {                                // every listed predicate must hold
 *       "exit": 0,
 *       "stdout_contains": ["# fail 0"],
 *       "stdout_regex": ["^# tests \\d+$"],    // multiline
 *       "ratchet": {                           // optional expected-failure baseline
 *         "parser": "tap" | "acceptance",
 *         "baseline": "tests/gates/baseline/<id>.txt",
 *         "final": { "stdout_contains": ["18/18"] }   // enforced once the baseline is empty
 *       }
 *     }
 *   }
 *
 * Ratchet rule: a failure not in the baseline fails the gate. A baseline line that
 * did not fail this time also fails the gate (the fix must delete the line), so a
 * baseline only shrinks. `--write-baseline` rewrites the baseline from this run.
 *
 * Nothing here reads git remotes or branch names.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gatesDir = join(root, "tests", "gates");

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
};
const group = option("--group");
const onlyId = option("--id");
const requires = option("--requires");
const without = option("--without");
const list = argv.includes("--list");
const asJson = argv.includes("--json");
const writeBaseline = argv.includes("--write-baseline");

function loadGates() {
  if (!existsSync(gatesDir)) return [];
  return readdirSync(gatesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const gate = JSON.parse(readFileSync(join(gatesDir, name), "utf8"));
      if (gate.id !== name.replace(/\.json$/, "")) throw new Error(`${name}: id "${gate.id}" must equal the file name`);
      if (typeof gate.command !== "string" || !gate.pass) throw new Error(`${name}: needs command and pass`);
      return gate;
    });
}

function select(gates) {
  return gates.filter((gate) => {
    const tags = gate.requires ?? [];
    if (group && gate.group !== group) return false;
    if (onlyId && gate.id !== onlyId) return false;
    if (requires && !tags.includes(requires)) return false;
    if (without && tags.includes(without)) return false;
    return true;
  });
}

const parsers = {
  // node --test TAP: failing subtests are `not ok N - <name>`, at any indentation.
  // The per-file summary line is also `not ok`, so names ending in `.mjs` are skipped.
  tap(output) {
    return [...output.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((match) => match[1]).filter((name) => !name.endsWith(".mjs"));
  },
  // scripts/acceptance.mjs: `  ❌ <phase> — <detail>`.
  acceptance(output) {
    return [...output.matchAll(/^\s*❌ (.+?)(?: — .*)?$/gm)].map((match) => match[1].trim());
  },
};

function readBaseline(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function check(predicates, result, evidence, failures) {
  if (predicates.exit !== undefined && result.status !== predicates.exit) failures.push(`exit ${result.status}, expected ${predicates.exit}`);
  for (const needle of predicates.stdout_contains ?? []) {
    if (result.stdout.includes(needle)) evidence.push(`contains "${needle}"`);
    else failures.push(`stdout lacks "${needle}"`);
  }
  for (const pattern of predicates.stdout_regex ?? []) {
    const match = result.stdout.match(new RegExp(pattern, "m"));
    if (match) evidence.push(`matches ${match[0]}`);
    else failures.push(`stdout does not match /${pattern}/`);
  }
}

function runGate(gate) {
  const started = Date.now();
  const result = spawnSync("sh", ["-c", gate.command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(gate.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  result.stdout ??= "";
  result.stderr ??= "";
  const evidence = [];
  const failures = [];
  check(gate.pass, result, evidence, failures);

  const ratchet = gate.pass.ratchet;
  if (ratchet) {
    const parser = parsers[ratchet.parser];
    if (!parser) failures.push(`unknown ratchet parser ${ratchet.parser}`);
    else {
      const failed = [...new Set(parser(`${result.stdout}\n${result.stderr}`))];
      const baseline = readBaseline(ratchet.baseline);
      if (writeBaseline) {
        writeFileSync(
          resolve(root, ratchet.baseline),
          `# Expected failures for gate ${gate.id}. Delete a line when its PR turns the case green. Never add one without a PR that explains it.\n${failed.join("\n")}${failed.length ? "\n" : ""}`,
        );
        evidence.push(`baseline written with ${failed.length} lines`);
      } else {
        const fresh = failed.filter((name) => !baseline.includes(name));
        const stale = baseline.filter((name) => !failed.includes(name));
        evidence.push(`ratchet failing ${failed.length}, baseline ${baseline.length}`);
        for (const name of fresh) failures.push(`new failure: ${name}`);
        for (const name of stale) failures.push(`stale baseline line, delete it: ${name}`);
        if (baseline.length === 0 && ratchet.final) check(ratchet.final, result, evidence, failures);
        else if (ratchet.final) evidence.push(`final predicate deferred until the baseline is empty`);
      }
    }
  }

  return {
    id: gate.id,
    group: gate.group ?? null,
    ok: failures.length === 0,
    status: result.status,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    evidence,
    failures,
    tail: result.stdout.trim().split("\n").slice(-3),
    stderrTail: result.stderr.trim().split("\n").slice(-3),
  };
}

const gates = select(loadGates());

if (list) {
  if (asJson) console.log(JSON.stringify(gates, null, 2));
  else for (const gate of gates) console.log(`${gate.id.padEnd(32)} ${String(gate.group ?? "").padEnd(12)} ${(gate.requires ?? []).join(",").padEnd(12)} ${gate.command}`);
  process.exit(0);
}

if (gates.length === 0) {
  console.log(`run-gates: no gate selected (group=${group ?? "*"} id=${onlyId ?? "*"} requires=${requires ?? "*"} without=${without ?? "*"})`);
  console.log("::warning::run-gates selected zero gates; a gate that does not exist is not a gate");
  process.exit(0);
}

const results = gates.map((gate) => {
  const outcome = runGate(gate);
  if (!asJson) {
    console.log(`${outcome.ok ? "PASS" : "FAIL"} ${outcome.id}  (${outcome.seconds}s, exit ${outcome.status})`);
    for (const line of outcome.evidence) console.log(`     ${line}`);
    for (const line of outcome.failures) console.log(`     !! ${line}`);
    if (!outcome.ok) {
      for (const line of outcome.tail) console.log(`     | ${line}`);
      for (const line of outcome.stderrTail) if (line) console.log(`     ! ${line}`);
    }
  }
  return outcome;
});

const failed = results.filter((outcome) => !outcome.ok);
if (asJson) console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
else console.log(`\n${results.length - failed.length}/${results.length} gates passed${failed.length ? `; failed: ${failed.map((outcome) => outcome.id).join(", ")}` : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
