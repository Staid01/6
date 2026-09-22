# dot-skill v2 · 当前状态

> 这份文件是**这一支的权威状态说明**：现在能做什么、怎么验、哪些还没做到。
> 最后更新：2026-09-22（集成分支 `dot-skill-test`）。栈停在 `dot-skill-test`，`dot-skill` 保留。
> 契约 `docs/v2/CONTRACT.md` · 验收 `docs/v2/ACCEPTANCE.md` · 渲染 `docs/v2/RENDER.md` ·
> 提示词 `docs/v2/PROMPTS.md` · 宿主矩阵 `docs/v2/HOSTS.md` · 迁移 `docs/v2/MIGRATION.md` ·
> 门禁 `docs/v2/GATES.md`。
> 各功能的交付说明与前后对比在 `docs/evidence/pr-NN-*.md`。那些文件描述的是按会话转录重建的 `ds/NN-*` 分支快照，不是本栈。

## 1. 这是什么

把原材料（聊天导出、邮件、字幕、文档、归档、需要 key 的渠道）蒸馏成一个**可调用的人物
Skill**，外加一份**每条结论都能回指到原文**的画像页。

| 交付物 | 路径 | 说明 |
| --- | --- | --- |
| 人物 Skill | `skills/<family>/<slug>/SKILL.md`（+ `work.md` `persona.md` `work_skill.md` `persona_skill.md` `manifest.json` `meta.json`） | 可装进宿主直接运行；Part A 工作能力 + Part B 人物性格（Layer 0–5） |
| 画像页 | `views/<slug>.html` + `evidence/renders/receipt.json` | 单文件、离线、双主题；每条结论带 `[k00NN]` 锚点 |

三个 family：`colleague` / `relationship` / `celebrity`。
八个宿主：`claude-code` `codex` `opencode` `openclaw` `hermes` `deepseek-harness` `grok-build` `pi`。

**护城河不是"像不像"，是"凭什么这么说"**：每条结论可回指到原文的字节区间，派生可复跑
（同一输入两次字节相同），产物被机械门禁压住。

## 2. 主线：五步

`Collect → Derive → Read → Distill → Render`（细则见 `SKILL.md`）

| 步骤 | 产物 | 机械保证 |
| --- | --- | --- |
| 1 Collect | `knowledge/raw/**`、`knowledge/text/*.md`、`knowledge/index.json` | 回执 + 幂等 + 账本 sha256 |
| 1.5 语料体检 | 无新文件，`doctor` 回执里的 `shape[]` | **前置门槛**：`distilly doctor --require-shape`；`verdict=FAIL` 时必须停下并给出理由 |
| 2 Derive | `evidence/derived/*.json`（7 个维度） | 两次运行字节相同 + 派生锚点全部可回指 |
| 3 Read | 无新文件，产出"读了什么"的复述 | **靠提示词约束，无机械门禁**（已知缺口 7.2） |
| 4 Distill | `work.md`、`persona.md` → `distilly skill create` | **产物已进验收**：产物齐 / Layer 0–5 齐 / 悬空锚点=0 |
| 5 Render | `views/<slug>.view.json`、`views/<slug>.html`、`evidence/renders/receipt.json` | view check + 两次渲染字节相同 + 单文件无外链 + CSP + visual-check 8 项 |

## 3. 怎么跑

```bash
# 零依赖：Node >= 20，无运行时 npm 依赖
node bin/distilly.mjs <子命令>            # 唯一入口（该文件也带可执行位）

# 宿主里（以 DeepSeek Harness 为例）
node bin/distilly.mjs install deepseek-harness      # → $DSH_HOME/skills/distilly
# DSH 会 watch 技能目录，装完即被发现（实测同一会话内生效）；
# Skill 正文写明 CLI 的确切调用形式：node "{distilly_skill_root}/bin/distilly.mjs" <子命令>
```

**路径约定（一条规则）**：`--base-dir <工作区>` = 工作区根（下面有 `skills/`），
**每一条命令**一致；`--skills-dir <dir>`（`skill *`）与 `--dir <人物目录>`（`retrospect`）
用于直接指名更细的一层；`view` 另接受同义别名 `--root`。同时给 `--base-dir` 与
`--skills-dir` 会报错，不会猜。

本树 `doctor` 不接受 `--person`。空 HOME 探测必须同时把 `HOME` 和 `DISTILLY_HOME` 指到同一个空的 `mktemp -d`。

## 4. 怎么验（当前实测数字）

下列数字来自 2026-09-22 在 `atomic/pr-10-contract-align` 上的重跑。Node 22.14.0 与 Node 20.20.2。不要抄计划里的 396。

```bash
npm test                                   # Verify 里 unit-tests 门禁的同一条命令
node scripts/acceptance.mjs --corpus tests/fixtures/public-corpus/synthetic-interview --person lin-gong
node scripts/acceptance.mjs --corpus tests/fixtures/public-corpus/us-house-floor-2009-07-29 --person us-house
node scripts/acceptance.mjs --corpus tests/fixtures/public-corpus/synthetic-multisource --person lin-gong
node scripts/audit-objective.mjs --skip-acceptance
node scripts/check_release.mjs && node scripts/prompt-lint.mjs && node scripts/generate-template.mjs --check
node scripts/run-gates.mjs --without playwright
DISTILLY_PLAYWRIGHT_ROOT=/tmp/pw-root node scripts/run-gates.mjs --requires playwright
```

| 门禁 | 结果 | 来源命令 |
| --- | --- | --- |
| `npm test` | **397 / 397**，`# fail 0`（Node 20.20.2 与 22.14.0 各一遍） | `npm test` |
| `scripts/acceptance.mjs` | **18 / 18**，三份公开语料各一遍 | `DISTILLY_PLAYWRIGHT_ROOT=/tmp/pw-root node scripts/run-gates.mjs --requires playwright` |
| us-house 形状 | `FAIL · units=2744 speakers=18 attributed=175` | 同上，acceptance-us-house |
| `scripts/audit-objective.mjs --skip-acceptance` | **14 / 14** 条满足 | `node scripts/audit-objective.mjs --skip-acceptance` |
| `scripts/check_release.mjs` | **7 / 7** 项通过 | `node scripts/check_release.mjs` |
| `scripts/prompt-lint.mjs` | `prompt-lint: 0 finding(s) in 0 file(s) across 26 file(s) scanned (contract commands: 16)` | `node scripts/prompt-lint.mjs` |
| `scripts/generate-template.mjs --check` | 无漂移 | `node scripts/generate-template.mjs --check` |
| `run-gates --without playwright` | **8 / 8** gates passed（Node 20 与 22） | `node scripts/run-gates.mjs --without playwright` |
| `run-gates --requires playwright` | **3 / 3** gates passed | `DISTILLY_PLAYWRIGHT_ROOT=/tmp/pw-root node scripts/run-gates.mjs --requires playwright` |
| `check-entry-surface --baseline` | `RESULT PASS  findings 9  known 9  new 0  stale-baseline 0` | `node scripts/check-entry-surface.mjs --baseline tests/gates/baseline/entry-surface.txt` |
| GitHub Actions | `verify.yml` 两个 job。`.github/workflows/ci.yml` 已删 | `git ls-files .github/workflows` |

验收 18 项里最后 6 项是**交付物与语料门禁**（判据在 `scripts/skill-artifacts.mjs`，纯字符串入参、
可单测、带反例）：产物齐 / PART A·B·运行规则在 / Layer 0–5 齐且 Layer 0 有规则 /
锚点悬空=0 / doctor 报回指率。

## 5. 语料形状（决定成败的一条）

产品要的是**一个人的一手产出**：本人著作、演讲与访谈字幕、本人社媒。
会议记录与多人群聊是**混合流水**，必须先有说话人归属才能切出一个人——解析层现在能做到
（WebVTT voice / `Name:` 前缀 / 全角冒号 `说话人 1：` / 句中换人），但归属率取决于源本身。

**结论：选对语料比优化解析器重要一个数量级。** 产品现在会在 Step 1.5 拦住错误形状
（`distilly doctor --require-shape`）。本树 C-SPAN 语料的实测判决字面值是
`FAIL · units=2744 speakers=18 attributed=175`。不要用 85 或 86。本树没有把 PR-1 merge 进来。

合成访谈字幕是 **38** 条 cue。见 `tests/fixtures/public-corpus/README.md`。

## 6. 分支与 PR 清单

栈停在 `dot-skill-test`，`dot-skill` 保留。程序不改 `dot-skill`。不更新、不 retarget、不合并 #185。

本文件描述的对象是 `dot-skill-test` 上的原子 PR 栈，外加本 PR 以 PR-9 为父提交的工作树。本树**没有**把 PR-1 至 PR-8 merge 进来。A8：不干净且不打回的父 PR 不挡住本条。

| 对象 | 数量 | 状态 |
| --- | --- | --- |
| 原子 PR 栈 PR-0 至 PR-9 | 10 条已发布 | 见下表。总 verdict 多数不干净，A5 不打回 |
| 本 PR-10 | 1 | 父提交 `atomic/pr-9-node-installers` @ `bb6d43110933ff106573ab9a5eb07f95f4d38ce4`（#187） |
| 旧 `ds/NN-*` 快照与 #166 至 #184 | 仍开着 | D4 未执行。证据文档顶部已标明不是本栈 |
| #185 | 1 | 不碰 |
| 默认分支 `dot-skill` | 保留 | 程序任何环节都不改它 |

已发布的原子 PR（2026-09-22 程序状态表）：

| PR | GitHub | head SHA | 父 |
| --- | --- | --- | --- |
| PR-0 | #186 | `9c8f1ceb464988f4273b2c5fc4bfc4bbe33af3ec` | `dot-skill-test` @ e16cc8a |
| PR-1 | #188 | `319e8c36633313450ba0b6c2695c55e39b835085` | PR-0 |
| PR-9 | #187 | `bb6d43110933ff106573ab9a5eb07f95f4d38ce4` | PR-0。**本 PR 的父提交** |
| PR-4 | #189 | `cd99139b9d2e2770616c58f899b76bdf75be474c` | 未合进本树 |
| PR-6 | #190 | `bc809f0eba1424625887d700aa395f2f3f595d25` | 未合进本树 |
| PR-5 | #191 | `009415e163357ce57143ac18ddfd1738c6ee4d5f` | 未合进本树 |
| PR-2 | #192 | `8784cac5bd15b47ecc1d9511eee637d77d8baf20` | 未合进本树 |
| PR-3 | #193 | `d05717bbefc2278e1cc55ca74745b359cea9cfdd` | 未合进本树 |
| PR-8 | #194 | `2b8b22fde9bd41fe9e6ab5d854efd2e91b2da4d8` | 未合进本树 |
| PR-7 | #195 | `57ffcbff84e26d74696cf94613e6154e9903b4ca` | 未合进本树 |

`docs/evidence/pr-NN-*.md` 描述的是按会话转录重建的 `ds/NN-*` 分支快照，不是本栈。

## 7. 已知缺口（没做到的部分，按严重度）

1. **本树不是叠好的栈顶（A8）**。计划里「60 条全绿、两个基线只剩注释、entry-surface 0 finding」以叠好的栈为前提。本 PR 只删本 PR 真正变绿的基线行。`audit-tests` 基线仍有 20 行。`entry-surface` 基线仍有 9 行（四条 enumerations、四条 channels、一条 unknown-channel 文档缺口）。CONTRACT 第 25 行渠道名单未改。
2. **仍红的审计行不在本 PR**。留下的包括 R08、R16、R17、R21、R24、R28、R38、R48、R49、R56。它们属于 PR-1 至 PR-8。不要删这些行来凑「只剩注释」。
3. **Step 3（Read）没有机械门禁**，全靠提示词自觉；Step 1 / 1.5 / 2 / 4 / 5 有判据。
4. **效果数字需要不是蒸馏者的裁判**。PR-8 的三模型 Lane 7 与 Lane 8 本拍未作为本树的前置。装置在 `scripts/blind-test.mjs`。
5. **`docs/PRD.md` 与 `docs/SKILL_TYPE_ABSTRACTION_DESIGN*.md` 描述的是 v1（Python）形状**
   （`colleagues/{slug}`、`tools/*.py`），未随 v2 重写；两份文件顶部已加说明指向 v2。
6. **D4 未执行**。#166 至 #184 一条都不关。证据头不写「已关闭」。
7. **PDF 抽取、HTML axe 与坏链、python3 转发**已从契约挪到 `ROADMAP.md`。`parse-doc` 对 `.pdf` 响亮拒绝，code 为 `office/unsupported-format`。
8. **四个契约渠道 discord / reddit / notion / gmail 在本树不可达**。那是 PR-4 的 Files。本 PR 不删模块，不改 CONTRACT 第 25 行。
