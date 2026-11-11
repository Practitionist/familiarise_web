# ADR: Fable 5.2 becomes the advisor tier, audit days run at xhigh, and executor pins stay on Opus and Sonnet

- **Status**: Accepted on 2026-11-11 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-11
- **Author**: Platform engineering
- **Related**: [Model orchestration skill](../../.claude/skills/workflow/references/model-orchestration.md), [Subagent index](../../.claude/agents/README.md), [What's new in Claude Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2), [Prompting Claude Fable 5.2](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2), [Claude Code model configuration](https://code.claude.com/docs/en/model-config)

## Context

Anthropic released Claude Fable 5.2 on 2026-11-09. It costs $8 per million input tokens and $40 per million output tokens, against $10 and $50 for Fable 5.1, so it is now 2× Opus 5.5 instead of 2.5×. From Claude Code v2.1.321 the `fable` alias resolves to Fable 5.2, and this machine runs v2.1.322. Claude Code starts Fable 5.2 at `medium` effort, while the API starts it at `high`.

Anthropic's effort guidance for Fable 5.2 says most of the capability gain is already present at `high`, that gains above `high` are uneven, and that `max` is slow and costly for a small gain and is meant for measuring the model's ceiling. The prompting guide also reports four behaviours that affect how this repository briefs agents: early stopping at low and medium effort, ready delegation when prompts invite it, over-caution when "never" rules stack up, and larger diffs when a prompt calls the code the model's own.

The model orchestration skill still named Fable 5.1, its prices and a `max` audit row.

## Decision

1. **The advisor tier is Fable 5.2.** The skill, the subagent index and the workflow skill index name Fable 5.2 with its current prices and Claude Code version floor.
2. **Advisor effort.** An audit or design day runs Fable at `xhigh`. An orchestration day runs it at `high`. `max` is kept only for a rare ceiling run on one hard question, with the owner's go-ahead. No advisor session is left at Claude Code's `medium` default.
3. **No agent pin changes.** `pr-builder` and `pr-triager` stay on Opus 5.5, and the student agents stay on Sonnet 5.5. Anthropic still recommends Opus 5.5 as the daily driver, and moving an executor to Fable has not been measured on this repository's work.
4. **Fable 5.2 briefing rules.** The skill gains a short "Briefing Fable 5.2" section. The section-5 limit clause becomes a finish-and-limit clause that adapts Anthropic's finish-the-whole-task wording.

## Alternatives considered

- **Keep `max` on audit days.** This is the most expensive option, and Anthropic now advises against `max` outside ceiling measurements.
- **`high` for every advisor session.** This is the cheapest option, but long synthesis days lose the extra depth that `xhigh` can give.
- **A new Fable money-review agent, or a Fable money `pr-builder`.** Both raise cost per token by 2× without measured gains, and Fable usage may bill to usage credits. These can be reconsidered after a measured comparison on a real money PR.
- **Only update the facts, with no behavioural guidance.** This was rejected because the early-stopping and delegation behaviours change what a brief must say.
- **Also audit `AGENTS.md` and the memory files for stacked cautions.** This was deferred because it is much bigger than a skill hotfix and belongs in its own pull request.

## Consequences

- Orchestrators set `effort` explicitly on every Fable session and launch, because the Claude Code default of `medium` is the level where Fable 5.2 stops early most often.
- An unpinned subagent launched from a Fable session bills at Fable rates. The skill now says to pass `model` on every ad-hoc launch.
- Builder briefs leave out any sentence that calls the code the model's own, so diffs stay scoped as the root `AGENTS.md` requires.

## Deprecated & Superseded Approaches

- **Fable 5.1 as the advisor, at `max` on audit days.** This applied from Claude Code v2.1.257 until Fable 5.2 replaced it in v2.1.321. It was superseded by decisions 1 and 2 above.
