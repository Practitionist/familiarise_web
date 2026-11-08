---
name: model-orchestration
description: Choose which Claude tier runs which part of a large multi-agent effort — the advisor/teacher/student split, current model prices and context windows, what each effort level does, per-role effort, session-budget economics, running a fleet on one 8 GB machine (plan mode, heavy-command mutex, memory reaper, worktrees, git stash), and the resume-from-worktree pattern for surviving usage limits. Load when planning any fleet of subagents, when a session keeps hitting usage walls, or when deciding between Fable/Opus/Sonnet/Haiku for a task.
---

# Model orchestration: advisor, teacher, student

One model tier does not fit a whole engineering campaign. Split the work by the kind of thinking it needs, not by who happened to start the session. The advisor writes specs and verifies claims, the teacher builds and triages, and the student does mechanical breadth. This page also holds the rules for running several agents at once on one small machine.

## 1. The current family (researched 2026-11-08)

Figures come from Anthropic's official pages (links in Sources). Prices are USD per million tokens (MTok) on the Claude API. Re-check the pricing page before quoting a number in a budget decision, because prices and defaults change between model generations.

| Model             | API ID              | Input / output   | Cache read (hit) | Context | Max output | Default effort (API) |
| ----------------- | ------------------- | ---------------- | ---------------- | ------- | ---------- | -------------------- |
| Claude Fable 5.1  | `claude-fable-5-1`  | $10 / $50        | $0.25            | 1M      | 128K       | high                 |
| Claude Opus 5.5   | `claude-opus-5-5`   | $4 / $20         | $0.20            | 1M      | 128K       | medium               |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10         | $0.10            | 1M      | 128K       | high                 |
| Claude Haiku 5.5  | `claude-haiku-5-5`  | $0.10 / $0.50 \* | $0.01 \*         | 1M      | 128K       | medium               |

\* Haiku 5.5 is priced by prompt length. A request whose prompt is over 100,000 tokens (cache reads and writes count) pays $0.50 input, $2.50 output and $0.05 cache read. The other three models include the full 1M window at standard pricing.

Facts that matter for budgeting:

- Fable 5.1 costs 2.5× Opus 5.5 per input token and 2.5× per output token ($10/$50 against $4/$20), and 5× Sonnet 5.5. Every advisor token spent re-reading files an executor could read is waste.
- Cache reads are 0.025× the input price on Fable 5.1 and 0.05× on Opus 5.5 and Sonnet 5.5 (0.1× elsewhere). A long, stable agent prompt prefix is the cheapest input there is.
- Batch API requests are 50% off. Cache writes (5-minute) cost 1.25× input.
- Every current model has a reliable knowledge cutoff of June 2026 and adaptive thinking. Fable 5.1 and Opus 5.5 keep adaptive thinking always on, so effort is the control for how much they reason and what a request costs.
- Claude Mythos 5.1 is priced like Fable 5.1 but is limited-availability (verified organisations only), so do not plan a fleet around it.
- Claude Code resolves the aliases `fable`, `opus`, `sonnet` and `haiku` to Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 on the Anthropic API. Each model needs a minimum Claude Code version: Fable 5.1 needs v2.1.257, Opus 5.5 v2.1.280, Sonnet 5.5 v2.1.284 and Haiku 5.5 v2.1.293 (run `claude update`). On older versions, and on other providers (Bedrock, Google Cloud, Claude Platform on AWS), the aliases can resolve to older models, so pin a full ID such as `claude-opus-5-5` when the exact model matters, and check the resolved model in `/model`.

## 2. Effort levels

Effort (`low | medium | high | xhigh | max`) is a second, independent lever, often bigger than the model choice. It is a behavioural signal, not a token budget. The scale is calibrated per model, so the same name means a different amount of thinking on different models. Run a small sweep on your own checks before copying a level from one model to another.

| Level    | What it does (Anthropic's wording, condensed)                                                                              | Use it for                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `low`    | Most efficient. Large token savings with some capability loss. May skip a check or stop early in a long agent prompt.      | Simple, high-volume work and subagents where you review each result.         |
| `medium` | Balanced, with moderate token savings. The API default on Opus 5.5 and Haiku 5.5, and Claude Code's default on Sonnet 5.5. | Day-to-day engineering with a clear scope, such as implementing a feature.   |
| `high`   | Spends as many tokens as the task needs for excellent results. The default on Fable 5.1.                                   | Work where verification matters or edge cases are likely, such as bug fixes. |
| `xhigh`  | Extended capability for long-horizon work at higher token spend.                                                           | Long agentic or coding runs (over 30 minutes) with large token budgets.      |
| `max`    | No constraint on token spending. Shows diminishing returns and is prone to overthinking.                                   | Hard problems you want solved unattended, such as a security audit.          |

All four current models accept all five levels. A model that does not support a level falls back to the highest supported level at or below it. The Sonnet 5.5 default differs by surface: the models overview and effort pages say `high` on the Claude API, while the Claude Code model-config page says `medium`. Set `effort:` explicitly in every agent definition so the default never decides.

In a subagent definition, `effort:` overrides the session level while that agent runs, but `CLAUDE_CODE_EFFORT_LEVEL` in the environment overrides both. The orchestrator can also pass `effort` per invocation (Claude Code v2.1.292 or later), and that value persists when the agent is resumed. A subagent on a different model than the session does not inherit the session effort, so always set the field.

## 3. The three roles

**Advisor (Fable 5.1).** Owns judgment, not keystrokes: audit synthesis across dozens of sources, architecture and doctrine decisions, money-path code review, and adversarial verification of other agents' claims. The advisor writes specs so complete that a cheaper model can execute them without judgment calls. That spec-writing is its highest-leverage work. Anthropic positions Fable 5.1 for demanding reasoning and long-horizon agentic work, and says to reach for it when Opus 5.5 at higher effort still falls short on your evals.

**Teacher (Opus 5.5).** Executes complex, well-specified work and teaches the codebase back: builds a whole PR from a numbered spec, triages review comments by verifying each claim against current code, and writes tests that pin semantics. Anthropic's default recommendation for most workloads and for long-running agentic coding.

**Student (Sonnet 5.5, Haiku 5.5 for the smallest jobs).** Mechanical breadth and UI work: regenerate a reference doc, sweep unused imports, apply a decided rename, build labelled UI. Haiku 5.5 is for classification, extraction and routing, where its price and latency win.

Escalate on evidence, not vibes. When a student or teacher report contradicts the spec, the advisor re-verifies the claim in code before acting (see section 6, rule g).

### 3.1 Role table

| Role                                  | Model           | Effort | Why                                                                         |
| ------------------------------------- | --------------- | ------ | --------------------------------------------------------------------------- |
| Advisor session (audit or design day) | fable           | max    | Long-horizon synthesis. The one place `max` earns its tokens.               |
| Advisor session (orchestration day)   | fable           | high   | Dispatch and spot-checks do not need `max`.                                 |
| Teacher: build a PR, money code       | opus            | high   | Multi-file coherence and test writing; pair with a `codex review` round.    |
| Teacher: triage review comments       | opus            | high   | Claim-versus-code verification needs care. Non-money triage can use medium. |
| Student: UI, labels, accessibility    | sonnet          | high   | Visible quality matters more than token savings.                            |
| Student: docs, E2E scenarios          | sonnet          | medium | Breadth over depth.                                                         |
| Student: preview QA                   | sonnet          | xhigh  | Many cases and long runs; see `.claude/agents/qa-preview.md`.               |
| Student: rename or lint sweep         | sonnet or haiku | low    | Mechanical.                                                                 |

Choose the lowest effort that passes your checks. It is the biggest cost lever you control.

## 4. Mechanics in this repo

Subagent definitions live in `.claude/agents/*.md`, and the index is `.claude/agents/README.md`. The frontmatter carries the contract:

```yaml
---
name: pr-builder
description: Build one PR from a numbered spec produced by the orchestrator.
model: opus # sonnet | opus | haiku | fable | full id such as claude-opus-5-5 | inherit
effort: high # low | medium | high | xhigh | max
---
```

Model resolution order for a subagent: the per-invocation `model` parameter (aliases only), then the definition's `model`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation's model. A fork always inherits the parent model, so an advisor cannot fork itself into a cheaper executor. Launch a fresh agent with the spec inline instead. Workflow scripts take per-call `{model, effort}` on `agent()`.

## 5. Session-budget economics

Every subagent draws on the same session usage pool, weighted by its model's cost. A Fable orchestrator that launches six Fable executors in parallel multiplies its own burn rate about sevenfold and hits the wall mid-write. Agents die after the expensive read phase and before the cheap write phase. Depending on the plan and seat tier, Fable can also bill to usage credits instead of the included limits (the `/model` picker then marks it "Requires usage credits", and `-p` or Agent SDK runs bill without asking), so a Fable fleet can cost real money outside the shared pool. Rules:

1. **Executors run on cheaper tiers than the orchestrator.** That is the point of the split.
2. **Serialize when the pool is uncertain.** Two agents that finish beat six that die at 80%.
3. **Every long-running agent prompt carries a limit clause**: "if you approach a session limit, commit what is consistent, push, open the PR marking unfinished items, and report." An agent that dies silently strands its work in a dirty worktree.
4. **Resume, never restart.** A dead agent's worktree keeps its uncommitted edits. The relaunch prompt says: `cd` into the worktree path, run `git status` and `git diff`, keep coherent edits, finish incoherent ones, and it carries the dead agent's last progress note.
5. **The orchestrator persists a resume queue** (a plan file or an issue) after every fleet event: worktree path, branch, last note, remaining items. Any later session, on any model, can pick up from it.

Settings to decide per campaign:

- Advisor, teacher and student models (defaults: fable, opus, sonnet).
- Session effort default (suggest `high`; `max` only for audit or design days).
- Parallel executor cap (suggest 2–3 until you have measured the pool).
- The limit clause pasted into every agent prompt.
- Which findings force advisor re-verification (suggest anything touching payments, locks, auth or data deletion).

## 6. Running a fleet on one machine

This machine has 8 GB of RAM, one `node_modules`, one browser profile and one `git stash`. These rules come from the 2026-11-08 multi-agent session.

a. **Plan mode.** Background subagents launched while the main session is in plan mode inherit plan mode and only plan. Exit plan mode before launching builders and QA agents, or resume them with a message afterwards.

b. **One heavy command at a time.** When two or more agents build at once, run heavy commands (`tsc`, `jest`, `eslint`, `codex`) one at a time behind a shared mutex:

```bash
bash -c 'until mkdir /tmp/fw-heavy.lock 2>/dev/null; do sleep 15; done; trap "rmdir /tmp/fw-heavy.lock" EXIT; <cmd>'
```

Always release the lock, even when the command fails: put the whole thing in one `bash -c` and use `trap 'rmdir /tmp/fw-heavy.lock' EXIT` as `.claude/skills/workflow/SKILL.md` does. After a killed run or a reboot, check for a stale `/tmp/fw-heavy.lock` (and `/tmp/fw-browser.lock`) and remove it before resuming agents.

c. **Memory reaper.** On this 8 GB machine, Claude Code's low-memory reaper kills idle background shells, and a repo-wide `jest --changedSince` was killed that way. Prefer a targeted suite list: the tests the branch touched, committed or not (`git diff --name-only origin/dev -- '__tests__/*'` covers commits plus staged and unstaged edits; add `git ls-files --others --exclude-standard -- __tests__` for new untracked suites) plus the suites that import the changed modules. CI does not run everything on every PR: a PR into `dev` runs only `jest --changedSince` (`ci.yaml`), and the full sharded suite runs only on release runs (PRs into `prod`, pushes to `staging` or `prod`). So a change with wide reach (a shared helper, a fixture, a dependency bump) needs its importers run locally or it is first fully tested on the release PR.

d. **Separate worktrees.** Parallel builders get separate worktrees and branches with disjoint file sets. Give them a rule for shared files, for example each builder adds its own block in a shared label file instead of editing common lines. The orchestrator merges the branches afterwards with `git merge --no-ff`. Symlink the main checkout's `node_modules` into each worktree (AGENTS.md section 3.1).

e. **No `git stash`.** The stash is shared across all worktrees, so one builder's stash can be popped by another. Builders commit work in progress instead of stashing.

f. **Who gets what.**

- Money work (`lib/payments/`, tax) goes to Opus at high effort, plus one `codex review --base origin/dev` round, posted on the PR as inline review threads.
- UI, labels and accessibility go to Sonnet at high effort.
- Docs go to Sonnet at medium effort.

g. **Verify the brief.** A builder's report can disprove the orchestrator's premises. In the 2026-11-08 session, two of the three claims in a money brief were wrong. The orchestrator re-checks any contradicted claim in code before acting on it, and corrects the brief before relaunching anyone.

## Sources

All fetched 2026-11-08.

- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview): IDs, prices, context windows, max output, default effort, retirement dates.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing): cache write and read prices, the Haiku 5.5 prompt-length tiers, the Sonnet 5 pricing note.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort): what each level does, per-model defaults and recommendations.
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config): effort levels per model, aliases and provider resolution.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): `model` and `effort` frontmatter, resolution order, plan-mode inheritance.

Not verified: a hard per-model rate-limit or usage-pool weighting for Claude Code subscriptions. No official figure was found, so the "about sevenfold" burn rate in section 5 is an observed estimate, not a published number.

## Deprecated & Superseded Approaches

- **Old price figures.** Earlier versions of this page quoted Fable at "$10/$50 vs Opus $5/$25", Sonnet at "$2/$10 (rising to $3/$15)" and Haiku at "$1/$5". Opus 5.5 is now $4/$20, the Sonnet 5 price increase to $3/$15 was cancelled and $2/$10 is the standard price (carried to Sonnet 5.5), and Haiku 4.5's $1/$5 is replaced by Haiku 5.5's tiered $0.10/$0.50. Delete any budget text that still uses the old numbers.
- **"Mythos-class: Fable".** The advisor tier is now named by model, Fable 5.1. Mythos 5.1 is limited-availability and is not a fleet tier.
- **Older generations.** Opus 5, Opus 4.x (Opus 4.5 to 4.8 at $5/$25), Sonnet 5 and Sonnet 4.6 ($3/$15) are legacy. Do not pin them in agent definitions. Opus 4.6 and Sonnet 4.6 also lack the `xhigh` level, and Opus 4.7 defaulted to `xhigh`.
- **Extended thinking.** The manual `thinking.type: "enabled"` plus `budget_tokens` mode is not accepted on later models. Adaptive thinking steered by effort replaces it.
- **Opus at high everywhere.** Opus 5.5 now defaults to `medium`. Earlier Opus models defaulted to `high`, so an agent that omits `effort:` runs one level lower than it used to. Always set it explicitly.
- **The worked-example train.** The earlier page told one night's story of a ten-PR train, including four fleets that died to the shared-pool mistake. Its lessons now live in sections 5 and 6 as rules.
