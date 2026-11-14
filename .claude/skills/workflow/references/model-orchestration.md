---
name: model-orchestration
description: Choose which Claude tier runs which part of a large multi-agent effort — the advisor/teacher/student split, current model prices and context windows, what each effort level does, per-role effort, how to brief Fable 5.2, session-budget economics, running a fleet on one 8 GB machine (plan mode, heavy-command mutex, memory reaper, worktrees, git stash), and the resume-from-worktree pattern for surviving usage limits. Load when planning any fleet of subagents, when a session keeps hitting usage walls, or when deciding between Fable/Opus/Sonnet/Haiku for a task.
---

# Model orchestration: advisor, teacher, student

One model tier does not fit a whole engineering campaign. Split the work by the kind of thinking it needs, not by who happened to start the session. The advisor writes specs and verifies claims, the teacher builds and triages, and the student does mechanical breadth. This page also holds the rules for running several agents at once on one small machine.

## 1. The current family (researched 2026-11-11)

Figures come from Anthropic's official pages (links in Sources). Prices are USD per million tokens (MTok) on the Claude API. Re-check the pricing page before quoting a number in a budget decision, because prices and defaults change between model generations.

| Model             | API ID              | Input / output   | Cache read (hit) | Context | Max output | Default effort (API) | Default effort (Claude Code) |
| ----------------- | ------------------- | ---------------- | ---------------- | ------- | ---------- | -------------------- | ---------------------------- |
| Claude Fable 5.2  | `claude-fable-5-2`  | $8 / $40         | $0.20            | 1M      | 128K       | high                 | medium                       |
| Claude Opus 5.5   | `claude-opus-5-5`   | $4 / $20         | $0.20            | 1M      | 128K       | medium               | medium                       |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10         | $0.10            | 1M      | 128K       | high                 | medium                       |
| Claude Haiku 5.5  | `claude-haiku-5-5`  | $0.10 / $0.50 \* | $0.01 \*         | 1M      | 128K       | medium               | medium                       |

\* Haiku 5.5 is priced by prompt length. A request whose prompt is over 100,000 tokens (cache reads and writes count) pays $0.50 input, $2.50 output and $0.05 cache read. The other three models include the full 1M window at standard pricing.

Facts that matter for budgeting:

- Fable 5.2 costs 2× Opus 5.5 per input and output token ($8/$40 against $4/$20), and 4× Sonnet 5.5. Every advisor token spent re-reading files an executor could read is still waste.
- Cache reads are 0.025× the input price on Fable 5.2 and 0.05× on Opus 5.5 and Sonnet 5.5 (0.1× elsewhere). A cached token therefore costs the same $0.20 on Fable 5.2 as on Opus 5.5, so a long, stable advisor prefix is cheap; fresh reads and output are where Fable's price shows.
- Batch API requests are 50% off. Cache writes cost 1.25× input (5-minute) or 2× input (1-hour).
- Fast mode costs 2× the standard price: $16/$80 on Fable 5.2 and $8/$40 on Opus 5.5. A fast Opus session costs as much per token as a standard Fable session.
- Fable 5.2 was released on 2026-11-09. Anthropic reports output up to 30% faster than Fable 5.1 and about 55% fewer safeguard blocks. A blocked request comes back with `stop_reason: "refusal"`; on the API, cyber refusals can fall back to Opus 4.8 and biology refusals to Opus 5.
- Every current model has a reliable knowledge cutoff of June 2026 and adaptive thinking. Fable 5.2 and Opus 5.5 keep adaptive thinking always on, so effort is the control for how much they reason and what a request costs.
- Fable 5.2's thinking blocks are readable only by Fable 5.2 and Mythos 5.2. Switching a conversation from Fable to another model (Opus 5.5 included) drops Fable's reasoning for the turns that run there. Hand work down by launching a fresh agent with a written spec, not by switching `/model` mid-thought.
- Claude Mythos 5.2 is priced like Fable 5.2 but is limited-availability (verified organisations only), so do not plan a fleet around it.
- Claude Code resolves the aliases `fable`, `opus`, `sonnet` and `haiku` to Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 on the Anthropic API. In a Claude apps gateway session, `fable` still resolves to Fable 5 unless `ANTHROPIC_DEFAULT_FABLE_MODEL` overrides it, so select `claude-fable-5-2` explicitly there. Each model needs a minimum Claude Code version: Fable 5.2 needs v2.1.321, Opus 5.5 v2.1.280, Sonnet 5.5 v2.1.284 and Haiku 5.5 v2.1.293 (run `claude update`). From v2.1.321, `best` resolves to the same model as `opus`, not Fable, and a `claude-fable-5-1` pin in Pro, Max or Ultra user settings is moved to the `fable` alias. On older versions, and on other providers (Bedrock, Google Cloud, Claude Platform on AWS, Foundry), the aliases can resolve to older models, so pin a full ID such as `claude-opus-5-5` when the exact model matters, and check the resolved model in `/model`.

## 2. Effort levels

Effort (`low | medium | high | xhigh | max`) is a second, independent lever, often bigger than the model choice. It is a behavioural signal, not a token budget. The scale is calibrated per model, so the same name means a different amount of thinking on different models. Anthropic reports that Fable 5.2 at `low` scores close to Fable 5.1 at higher levels. Run a small sweep on your own checks before copying a level from one model to another.

| Level    | What it does (Anthropic's wording, condensed)                                                                                                 | Use it for                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `low`    | Most efficient. Large token savings with some capability loss. May skip a check or stop early in a long agent prompt.                         | Simple, high-volume work and subagents where you review each result.         |
| `medium` | Balanced, with moderate token savings. The API default on Opus 5.5 and Haiku 5.5, and Claude Code's default on all four current models.       | Day-to-day engineering with a clear scope, such as implementing a feature.   |
| `high`   | Spends as many tokens as the task needs for excellent results. The API default on Fable 5.2 and Sonnet 5.5. Most of Fable 5.2's gain is here. | Work where verification matters or edge cases are likely, such as bug fixes. |
| `xhigh`  | Extended capability for long-horizon work at higher token spend. Gains over `high` are uneven and task-dependent.                             | Long agentic or coding runs (over 30 minutes) where a gain has been seen.    |
| `max`    | No constraint on token spending. Slower and costlier than `xhigh` for a small gain. Anthropic reserves it for measuring the model's ceiling.  | A ceiling measurement, or a rare open-ended problem where time is no object. |

All four current models accept all five levels. A model that does not support a level falls back to the highest supported level at or below it. Claude Code and the API disagree on defaults: Claude Code starts Fable 5.2 and Sonnet 5.5 at `medium`, while the API starts them at `high`. Set `effort:` explicitly in every agent definition and every advisor session so the default never decides.

In a subagent definition, `effort:` overrides the session level while that agent runs, but `CLAUDE_CODE_EFFORT_LEVEL` in the environment overrides both. The orchestrator can also pass `effort` per invocation (Claude Code v2.1.292 or later), and that value persists when the agent is resumed. A subagent on a different model than the session does not inherit the session effort, so always set the field.

## 3. The three roles

**Advisor (Fable 5.2).** Owns judgment, not keystrokes: audit synthesis across dozens of sources, architecture and doctrine decisions, money-path code review, and adversarial verification of other agents' claims. The advisor writes specs so complete that a cheaper model can execute them without judgment calls. That spec-writing is its highest-leverage work. Anthropic positions Fable 5.2 for demanding reasoning and long-horizon agentic work, names it as a planner and orchestrator for smaller models, and says to reach for it when Opus 5.5 at higher effort still falls short on your evals.

**Teacher (Opus 5.5).** Executes complex, well-specified work and teaches the codebase back: builds a whole PR from a numbered spec, triages review comments by verifying each claim against current code, and writes tests that pin semantics. Anthropic's daily-driver recommendation for most coding and knowledge work.

**Student (Sonnet 5.5, Haiku 5.5 for the smallest jobs).** Mechanical breadth and UI work: regenerate a reference doc, sweep unused imports, apply a decided rename, build labelled UI. Haiku 5.5 is for classification, extraction and routing, where its price and latency win.

Escalate on evidence, not vibes. When a student or teacher report contradicts the spec, the advisor re-verifies the claim in code before acting (see section 6, rule g).

### 3.1 Role table

| Role                                           | Model           | Effort | Why                                                                                          |
| ---------------------------------------------- | --------------- | ------ | -------------------------------------------------------------------------------------------- |
| Advisor session (audit or design day)          | fable           | xhigh  | Long-horizon synthesis. Above `high` the gain is task-dependent, so stop at `xhigh`.         |
| Advisor session (orchestration day)            | fable           | high   | Dispatch and spot-checks. Never leave it at Claude Code's `medium` default.                  |
| Advisor ceiling run (rare)                     | fable           | max    | Only to measure the ceiling on one hard question, with the owner's go-ahead.                 |
| Teacher: build a PR, money code                | opus            | high   | Multi-file coherence and test writing; pair with a `codex review` round.                     |
| Teacher: triage review comments                | opus            | high   | Claim-versus-code verification needs care. Non-money triage can use medium.                  |
| Student: UI, labels, accessibility             | sonnet          | high   | Visible quality matters more than token savings.                                             |
| Student: docs that verify claims in code       | sonnet          | high   | Stale docs mislead the agents that read them; see `.claude/agents/documentation-writer.md`.  |
| Student: E2E scenarios, lean preview re-checks | sonnet          | medium | Breadth over depth; see `.claude/agents/sweeper.md`.                                         |
| Student: preview QA                            | sonnet          | xhigh  | Full rounds on state or money: many cases and long runs; see `.claude/agents/qa-preview.md`. |
| Student: rename or lint sweep                  | sonnet or haiku | low    | Mechanical.                                                                                  |

Choose the lowest effort that passes your checks. It is the biggest cost lever you control.

### 3.2 Briefing Fable 5.2

Anthropic's Fable 5.2 prompting guide reports four behaviours that change how an advisor session and its briefs should be written.

1. **It stops early at low and medium effort.** On long tasks it may end a turn with a list of what remains or an offer to continue. Run advisor sessions at `high` or above, and put the finish clause from section 5, rule 3, in every long brief.
2. **It delegates readily when prompts invite it.** At `xhigh` and `max` it also starts subagents to review its own work. An unpinned subagent (`general-purpose`, `Plan`, a fork) runs on the session's model, so from a Fable session it bills at Fable rates. Pass `model` on every ad-hoc launch, and prefer the pinned role agents in `.claude/agents/`. The built-in `Explore` agent already runs on Opus under a Fable session on a subscription or Console account.
3. **Stacked cautions make it hold back routine work.** It follows "never" rules, notes and reviewer conditions closely, and in multi-agent setups it may ask for approvals it does not need. Do not add blanket "never" lines to briefs. Give each rule its scope and reason, and name the steps that need no approval, for example read-only Supabase queries, re-running a failed `tsc` or `jest`, and retrying a timed-out read. Keep the owner's confirmation step for merges, database writes, deletions and any push the brief does not authorise. A role agent whose brief says to deliver a draft PR (`pr-builder`, `sweeper`) pushes it without asking; the orchestrator still pauses before pushing its own work.
4. **What the brief says about ownership changes the diff.** A sentence that calls the code its own makes it merge duplicates and fix nearby problems, at about 1.5× output tokens and with changes nobody asked for. This repository's rules want small, scoped diffs, so leave that sentence out of builder briefs and state the file scope instead.

Two smaller points: a line telling it to "answer directly without deliberating" no longer reduces its thinking at `medium` or above, so lower the effort instead; and it follows style rules literally, so a hard word limit per sentence makes its prose choppy.

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

Every subagent draws on the same session usage pool, weighted by its model's cost. A Fable orchestrator that launches six Fable executors in parallel multiplies its own burn rate about sevenfold and hits the wall mid-write. Agents die after the expensive read phase and before the cheap write phase. Depending on the plan and seat tier, Fable can also bill to usage credits instead of the included limits (the `/model` picker then marks it "Requires usage credits", and `-p` or Agent SDK runs bill without asking), so a Fable fleet can cost real money outside the shared pool. Anthropic's launch note says Fable counts for up to 50% of weekly usage limits on Pro and standard Team seats. Rules:

1. **Executors run on cheaper tiers than the orchestrator.** That is the point of the split.
2. **Serialize when the pool is uncertain.** Two agents that finish beat six that die at 80%.
3. **Every long-running agent prompt carries a finish-and-limit clause**: "Finish the whole brief. Do not stop to list what remains or to offer to continue while doable work is left. Diagnose ordinary obstacles (a failed command, a timeout, a busy lock, an empty result) and work through them. Stop only at a deliberate blocker or a decision that is the owner's, and say plainly what you found. If you approach a session limit, commit what is consistent. If this brief authorises a draft PR, push and open it marking unfinished items; otherwise leave the commit local. Report the branch, the commit and the unfinished items." An agent that dies silently strands its work in a dirty worktree.
4. **Resume, never restart.** A dead agent's worktree keeps its uncommitted edits. The relaunch prompt says: `cd` into the worktree path, run `git status` and `git diff`, keep coherent edits, finish incoherent ones, and it carries the dead agent's last progress note.
5. **The orchestrator persists a resume queue** (a plan file or an issue) after every fleet event: worktree path, branch, last note, remaining items. Any later session, on any model, can pick up from it.

Settings to decide per campaign:

- Advisor, teacher and student models (defaults: fable, opus, sonnet).
- Session effort default (suggest `high`; `xhigh` for audit or design days; `max` only for a ceiling run).
- Parallel executor cap (suggest 2–3 until you have measured the pool).
- The finish-and-limit clause pasted into every agent prompt.
- Which findings force advisor re-verification (suggest anything touching payments, locks, auth or data deletion).

## 6. Running a fleet on one machine

This machine has 8 GB of RAM, one `node_modules`, one browser profile and one `git stash`. These rules come from the 2026-11-08 multi-agent session.

a. **Plan mode.** Background subagents launched while the main session is in plan mode inherit plan mode and only plan. Exit plan mode before launching builders and QA agents, or resume them with a message afterwards.

b. **One heavy command at a time.** When two or more agents build at once, run heavy commands (`tsc`, `jest`, `eslint`, `codex`) one at a time behind a shared mutex:

```bash
bash -c 'until mkdir /tmp/fw-heavy.lock 2>/dev/null; do sleep 15; done; trap "rmdir /tmp/fw-heavy.lock" EXIT; <cmd>'
```

Always release the lock, even when the command fails: put the whole thing in one `bash -c` and use `trap 'rmdir /tmp/fw-heavy.lock' EXIT` as `.claude/skills/workflow/SKILL.md` does. After a killed run or a reboot, check for a stale `/tmp/fw-heavy.lock` (and `/tmp/fw-browser.lock`) and remove it before resuming agents.

This snippet is the one definition of the lock. The two repo-owned check scripts take it the same way, for their whole run, and release it in an `EXIT` trap: `scripts/dev/pre-push-checks.sh <log-dir>` (every pre-push step, see c below) and `scripts/dev/db-tier-local.sh [--log-statements] <log-file> [jest args…]` (the database tier on a disposable Postgres, `.claude/skills/booking/references/verification.md` section 11). The `check-runner` agent runs them and returns only the numbers and the failures.

c. **Memory reaper.** On this 8 GB machine, Claude Code's low-memory reaper kills idle background shells, and a repo-wide `jest --changedSince` was killed that way. While iterating, prefer a targeted suite list: the tests the branch touched, committed or not (`git diff --name-only origin/dev -- '__tests__/*'` covers commits plus staged and unstaged edits; add `git ls-files --others --exclude-standard -- __tests__` for new untracked suites) plus the suites that import the changed modules. CI does not run everything on every PR: a PR into `dev` runs only `jest --changedSince` (`ci.yaml`), and the full sharded suite runs only on release runs (PRs into `prod`, pushes to `staging` or `prod`). So a change with wide reach (a shared helper, a fixture, a dependency bump) needs its importers run locally or it is first fully tested on the release PR.

On the final head, before a push, run the WHOLE suite once all the same: `npx jest --coverage=false --maxWorkers=2`, detached with `nohup` and behind the heavy lock, takes about 12 minutes on an idle machine, longer beside another job, and survives the reaper. `scripts/dev/pre-push-checks.sh` runs it as its last step, after `prisma generate`, a cold `tsc`, eslint and Prettier on the changed files, the comment-archaeology guard and a check that no commit carries a session trailer, and prints one `name rc=N Ns` line per step. In the 2026-11-13 trains a named-directory run missed a real failure three times, each in a suite outside the directories that looked relevant. A UI suite that times out at 5 seconds while Chrome or a second jest is running is re-run alone before it is called a failure.

d. **Separate worktrees.** Parallel builders get separate worktrees and branches with disjoint file sets. Give them a rule for shared files, for example each builder adds its own block in a shared label file instead of editing common lines. The orchestrator merges the branches afterwards with `git merge --no-ff`. Symlink the main checkout's `node_modules` into each worktree (AGENTS.md section 3.1).

e. **No `git stash`.** The stash is shared across all worktrees, so one builder's stash can be popped by another. Builders commit work in progress instead of stashing.

f. **Who gets what.**

- Money work (`lib/payments/`, tax) goes to Opus at high effort, plus one `codex review --base origin/dev` round, posted on the PR as inline review threads.
- UI, labels and accessibility go to Sonnet at high effort.
- Docs go to Sonnet at high effort (`documentation-writer`); a doc regenerated from a written verdict goes to Sonnet at low effort (`mechanic`).
- A full preview QA round goes to Sonnet at extra-high effort (`qa-preview`); a lean re-check of a few cases goes to Sonnet at medium effort (`sweeper`).

g. **Verify the brief.** A builder's report can disprove the orchestrator's premises. In the 2026-11-08 session, two of the three claims in a money brief were wrong. The orchestrator re-checks any contradicted claim in code before acting on it, and corrects the brief before relaunching anyone.

h. **A QA run pins the head.** While a preview QA run is in progress, nobody pushes to that branch: the builder waits for the orchestrator's message, never for a report file to appear, and the QA agent writes its report once, at the end, with the head recorded at the start and the end. A push in the middle of a run made one round describe two builds.

The hold is enforced by a hook, not only by this rule. `qa-preview` (and `sweeper` on a preview re-check) takes the hold with `scripts/dev/qa-hold.sh take <branch> <PR> <head>` before the first case. That writes `/tmp/fw-qa-hold/<key>` (the branch with `%` as `%25` and `/` as `%2F`) holding `<PR> <head> <UTC ISO time>`, never overwrites another run's fresh hold, and prints the line. The agent releases it with `scripts/dev/qa-hold.sh release <branch> "<line>"` when the run ends, which removes the file only if the file still holds that line. `.claude/hooks/qa-push-hold.sh`, a `PreToolUse` hook on every Bash call, blocks a `git push` to a held branch with a message naming the PR, the head and the hold's age, ending "wait for the QA run to end, or for the orchestrator to remove the hold file". That message means a QA run is still reading the preview: do not retry or work around it; wait for the orchestrator. A held branch is the destination of each explicit refspec, or the branch checked out where the push runs when no refspec is given; `--all` or `--mirror` is blocked while any fresh hold exists. A hold older than 3 hours is stale and lets the push through with a note, and a hook that cannot parse its input fails open. It is a guard, not a boundary: text that only contains `git push` inside quotes can be blocked, and a push hidden behind an alias, `sh -c` or a variable is not seen. A QA agent that died without cleaning up leaves its hold behind: the orchestrator removes it with `rm -f` once it knows the run is over. With no hold directory the hook exits before reading its input, so it costs every other Bash call about 2 ms.

i. **How many at once.** Two builders plus one heavy job is the limit on 8 GB; three builders, jest and Chrome together got jobs killed. A QA agent in the browser counts as the heavy job's neighbour, so expect UI test timeouts while it runs.

j. **Reports go to files.** Each agent writes its result to a named file under `temp/` and returns a short summary. The orchestrator's context is summarised in a long session, and a result that lived only in a notification is lost with it.

k. **An independent review is a gate.** Clean suites and passing previews did not catch what a second reviewer found on three PRs in a row. After a fix in access or money code, the builder sweeps the same class (every caller, every path that can throw between a write and its check) before the next review pass, instead of fixing the one line the reviewer named. The `independent-reviewer` agent can be that second pass before the owner's external review, but only when the owner says yes: the orchestrator offers it for a money, state or access PR that is otherwise ready, never runs it on its own, and runs it at most once per head.

## Sources

All fetched 2026-11-11.

- [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview): IDs, prices, context windows, max output, default effort, retirement dates.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing): cache write and read prices, fast mode, the Haiku 5.5 prompt-length tiers.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort): what each level does, per-model defaults and recommendations.
- [What's new in Claude Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2): breaking changes, thinking-block binding, refusals and fallback, behaviour differences.
- [Prompting Claude Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2): effort calibration, early stopping, ownership, subagents, caution pile-up.
- [Introducing Claude Fable 5.2 and Claude Mythos 5.2](https://www.anthropic.com/claude-fable-and-mythos-5-2): release date, speed, refusal rates, plan usage, Fable-versus-Opus guidance.
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config): Claude Code effort defaults, aliases, version history and provider resolution.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): `model` and `effort` frontmatter, resolution order, forks, plan-mode inheritance, Explore under Fable.

Not verified: a hard per-model rate-limit or usage-pool weighting for Claude Code subscriptions. No official figure was found, so the "about sevenfold" burn rate in section 5 is an observed estimate, not a published number.

## Deprecated & Superseded Approaches

- **Old price figures.** Earlier versions of this page quoted Fable 5.1 at $10/$50 (2.5× Opus 5.5), Fable at "$10/$50 vs Opus $5/$25", Sonnet at "$2/$10 (rising to $3/$15)" and Haiku at "$1/$5". Fable 5.2 is $8/$40 (2× Opus 5.5), Opus 5.5 is $4/$20, the Sonnet 5 price increase to $3/$15 was cancelled and $2/$10 is the standard price, and Haiku 5.5 is tiered at $0.10/$0.50. Delete any budget text that still uses the old numbers.
- **Fable 5.1 as the advisor.** `fable` resolved to Fable 5.1 from Claude Code v2.1.257 until v2.1.321, and `best` used to follow `fable`. Fable 5.1 is now legacy; do not pin `claude-fable-5-1`.
- **`max` on audit and design days.** The advisor audit row used `max`. Anthropic's Fable 5.2 guidance puts most of the gain at `high` and calls `max` slow for a small gain, so audit days now run at `xhigh` and `max` is a rare ceiling run.
- **"Mythos-class: Fable".** The advisor tier is named by model, now Fable 5.2. Mythos 5.2 is limited-availability and is not a fleet tier.
- **Older generations.** Opus 5, Opus 4.x (Opus 4.5 to 4.8 at $5/$25), Sonnet 5 and Sonnet 4.6 ($3/$15) are legacy. Do not pin them in agent definitions. Opus 4.6 and Sonnet 4.6 also lack the `xhigh` level, and Opus 4.7 defaulted to `xhigh`.
- **Extended thinking.** The manual `thinking.type: "enabled"` plus `budget_tokens` mode is not accepted on later models. Adaptive thinking steered by effort replaces it.
- **Opus at high everywhere.** Opus 5.5 now defaults to `medium`. Earlier Opus models defaulted to `high`, so an agent that omits `effort:` runs one level lower than it used to. Always set it explicitly.
- **The worked-example train.** The earlier page told one night's story of a ten-PR train, including four fleets that died to the shared-pool mistake. Its lessons now live in sections 5 and 6 as rules.
