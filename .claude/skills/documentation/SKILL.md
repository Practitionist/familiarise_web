---
name: documentation
description: How this repo's documentation is layered and written so a human can understand the system by reading the docs alone, without the code open beside them. Covers the four doc layers and their readers (start-here explainers, domain docs, code comments, agent-facing skills), the readable-without-code test, worked examples with real numbers, naming the enforcer of every rule, citing files and functions but never line numbers, the current-vs-future labelling, one Diátaxis type per page (tutorial, how-to, reference, explanation), the 80/20 current-vs-deprecated split, contiguous numbering, Mermaid validation, and the drift checks (manual and the CI gate) to run before a docs PR. Use when the user says "write the docs", "update the docs", "document this", "explain this subsystem", "HLD", "start-here", "runbook", "worked example", "docs are stale", or when editing anything under docs/, .claude/skills/, AGENTS.md or prompts/.
---

# Documentation

Docs here serve two audiences. Humans need to understand the system from the docs alone. AI agents need terse guardrails, because they read the code anyway. One document can serve both if it opens with prose and examples and ends with a short "Where in code" section. A reader should never need the code open in a split screen to follow a start-here or domain doc. If they do, the doc has failed.

## 1. The four layers

| Layer                                               | Reader                          | Readable alone?                 | What belongs there                                                                                                         |
| --------------------------------------------------- | ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `docs/start-here/` (HLDs and worked examples)       | A new engineer, the owner, a PM | Yes. 20–30 minutes, no code.    | The big picture, diagrams, a glossary, each invariant in plain English, and one worked example per flow with real numbers. |
| `docs/<domain>/` (booking, payments, enterprise, …) | An engineer changing that area  | Mostly. Code is optional depth. | State machines, an invariant table, failure modes, runbooks, and the API contract.                                         |
| Code comments                                       | Whoever edits that line         | n/a                             | Only the local invariant or a non-obvious runtime constraint, in 1–2 lines (AGENTS.md §1.5).                               |
| `.claude/skills/`, `AGENTS.md`, `prompts/`          | AI agents                       | n/a                             | Terse do and don't rules, where things live, what is banned, and how to verify. No narrative.                              |

Put material in exactly one layer and link to it from the others. Never copy it.

### 1.1 One Diátaxis type per page

Every human-facing doc declares exactly one [Diátaxis](https://diataxis.fr/) type in its frontmatter as `type: tutorial | how-to | reference | explanation`, and holds only that kind of content:

| Type          | Answers                      | Here it is                                                                       |
| ------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `explanation` | Why is it built this way?    | The start-here HLDs and ADRs (`docs/decisions/`)                                 |
| `tutorial`    | Show me one flow end to end. | Worked examples (start-here 03)                                                  |
| `how-to`      | How do I fix or do X?        | Runbooks and local-dev guides                                                    |
| `reference`   | What exactly are the rules?  | State machines, invariant tables, API contracts, permission and funding matrices |

The most common mistake is explanation creeping into a how-to, or a reference table dropped into an explainer. Move it to its own page and link to it. Split mixed docs gradually, when you next touch them. Do not big-bang move folders.

## 2. Rules for human-facing docs (start-here and domain)

1. **Pass the phone test.** Someone reading on a phone, with no code, understands what happens, who can do it, and what can go wrong. Spell out a term like CAS, tombstone, hold or sweep the first time it appears, and keep a short glossary in each start-here doc.
2. **Give worked examples with real numbers.** Use the seeded cast (verify the names in `prisma/seedFiles/`), dates, times with a zone, and amounts in rupees _and_ paise. Show every state the booking passes through and every ledger line. For example: "Priya books Hannah's 1 h consultation for Mon 10:00 IST, pays ₹1,180 (₹1,000 + 18 % GST), cancels at 23 h → 50 % tier → ₹590 refunded, credit note for the refunded part."
3. **Name the enforcer of every rule.** Each claim says what makes it true:
   - the database (a named constraint or trigger in `prisma/sql/*.sql`);
   - a CAS helper (`lib/booking/transitions.ts`);
   - a lock;
   - an app check;
   - a sweep that repairs it.

   Example: "Two confirmed sessions can never overlap for one expert. The database refuses it (`occurrence_no_confirmed_overlap`)." The reader learns where to look without being forced to look.

4. **Cite files and function names, never line numbers.** Line numbers rot within weeks, and they belong in issues and PR bodies. Write `cancel route (app/api/appointments/[appointmentId]/cancel/route.ts)` or `quoteBookingRefund()`.
5. **Label the present and the future.** Every behaviour that is not on `dev` yet carries **(after Wave N)** or **(planned)**. Never describe planned behaviour in the present tense.
6. **Keep audit bookkeeping out of explainers.** Finding ids (BK-xx), wave tables and PR numbers live in the GitHub umbrella issue. A doc may end with a one-line "Related issues" list. No ticket archaeology in prose (AGENTS.md §1.5).
7. **Split current from deprecated (AGENTS.md §4.3).** Spend 80–85 % of the doc on what is implemented now. Use 10–15 % at the bottom under `## Deprecated & Superseded Approaches` to record briefly what was replaced and why, so agents can recognise and delete leftovers.
8. **Write full English sentences.** No telegraphic fragments and no arrow-chains as prose. Diagrams can be terse, but the text around them is not.
9. **Respect a size budget.** A start-here doc stays under about 500 lines. Split by concern when it grows (for example, a booking HLD, a money HLD and a worked-examples guide).

## 3. Rules for agent-facing docs (`.claude/skills/`, `AGENTS.md`, `prompts/`)

- Use imperative rules, the file or function to touch, the banned pattern, and the verification command. No history.
- **Never assert a constraint, trigger, job or function name without grepping for it first.** Docs have taught agents a phantom constraint before, and agents trust these files as doctrine. Use `rg -n "<name>" prisma/sql lib app utils scripts`.
- When code changes a rule, edit the skill line in the same PR, or record the delta for the docs PR.

## 4. Templates

- **HLD (start-here):** purpose → one pipeline picture → components and their responsibilities → invariants (plain English plus enforcer) → state machines → failure modes and recovery → target state (labelled) → glossary → Related issues → Deprecated & Superseded.
- **Domain doc:** what it is → the invariant table (rule | enforcer | test | repair) → state machine (Mermaid) → API or contract → failure modes → runbook links → Where in code → Deprecated & Superseded.
- **Runbook:** symptom → how to confirm it (exact SQL, CLI or log query) → impact → fix steps → how to verify the fix → prevention link.
- **Worked example:** cast and setup → numbered steps with timestamps → state after each step → money lines (legs, ledger, refund, credit note) → "what if" variants (race, retry, cancel) → which parts are current vs after Wave N.

## 5. Mechanics

- **Numbering (AGENTS.md §4.4):** when inserting, deleting or renaming a numbered doc, renumber so there are no gaps or duplicates. Update every cross-reference in the same commit (`rg -l "<old-path>" --hidden -g '!node_modules'`).
- **Mermaid:** validate every block you touch with `npx -y @mermaid-js/mermaid-cli -i <file> -o /tmp/out.svg`. ER diagrams cannot name an entity `Class`; use `ClassBatch`.
- **Formatting:** run `npx prettier --write <changed files>` only, never `prettier --write .`. `prompts/` is Prettier-ignored.
- **Verify in code, never from memory.** Open the code for every behavioural claim, and check vendor or legal facts against official docs (India-first sources for policy and regulation).

## 6. Repo versus Notion

Decide where each fact lives before writing it. The owner decision (2026-11-08) and the full table are in the root `README.md`, section "Repo versus Notion". Apply it like this:

1. **Repo test.** If an engineer or agent needs the fact to build, change or verify the system correctly, write it in the repo.
2. **Notion test.** If a competitor would gain from reading it, or the owner can change it without a code change, keep it in Notion (the owner's "Familiarise" workspace) and write only a pointer.
3. **Split the fact when both apply.** Document the mechanism and the configuration field name in the repo. Leave the value or the reasoning to Notion. Example: the repo says "a referral is held when it trips a rule on `ReferralProgramConfig`"; the threshold is "set by the owner; value kept in Notion (Familiarise / Growth & Marketing)".
4. **De-duplicate.** Every fact has one canonical home and the other side links to it. Write "value kept in Notion (Familiarise / <section>)". Never paste a Notion page into a doc, and never restate a repo mechanism in Notion beyond a link. If you find the same fact in both, keep the canonical copy and replace the other with a link.
5. **Stay in bounds without Notion access.** If you cannot tell which side a number belongs to, write the pointer and list it in your report as unverified. Public vendor plan limits with a source URL are allowed in the repo.

## 7. Pre-PR checklist

1. Run the drift check. Every backticked repo path in the changed docs must exist, and every relative link must resolve:
   ```bash
   npx tsx scripts/ci/check-docs-drift.ts
   ```
   It scans all of `docs/` and `.claude/skills/` and is warn-only, so compare its findings with `dev`, not only the count (one fixed warning can hide a new one), and make sure your change adds none. Do not hand-roll a `grep` for this: a bracket expression such as `[a-z\[\]]` closes at the first `]` in POSIX, so the pattern silently matches nothing and always reports a clean run.
2. Confirm no line-number citations remain in `docs/start-here/` or `docs/<domain>/`: `grep -nE '\.(ts|tsx):[0-9]+' <changed docs>`.
3. Confirm every planned behaviour is labelled (after Wave N / planned).
4. Mermaid renders. Numbering is contiguous. The README indexes are updated.
5. Run one CodeRabbit CLI round (`coderabbit review --committed --base dev --agent -c .coderabbit.yaml`) and check the Sonar gate (`sonar qg status -p Practitionist_familiarise_web --pull-request <n>`).

### 7.1 The CI drift gate (owner decision, 2026-10-17)

A small CI script runs on every PR. Put it in `scripts/ci/`, next to `check-db-sidecars.ts`. It enforces three rules:

1. Every repo path cited in `docs/` and `.claude/skills/` exists.
2. Every internal markdown link resolves.
3. No `docs/start-here/` file cites a line number.

It is **warn-only for two weeks** while the existing docs are fixed, then it becomes blocking. Do not add a service or a cron job for this.

Docs PRs are non-money. They follow the normal triage flow in `.claude/skills/workflow/references/pr-comment-triage.md`.
