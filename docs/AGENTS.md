# Documentation

Applies to everything under `docs/`. The root `AGENTS.md` still applies (contiguous numbering, no ticket-number archaeology). How to write a doc: `.claude/skills/documentation/SKILL.md`.

1. **80–85% current architecture.** Every documentation file focuses on the **currently implemented architecture**, active workflows, state diagrams, sequence diagrams, and engineering invariants.
2. **10–15% deprecated, at the bottom.** Architecture and domain docs end with `## Deprecated & Superseded Approaches`, a brief record of what was previously implemented and why it was superseded. This lets AI agents and engineers recognize and delete residual artifacts from older implementations instead of rediscovering or re-implementing them, without bloating docs with standalone historical investigation logs.
3. **Confidential figures live in Notion.** Growth docs hold mechanisms, invariants, configuration field names and on-screen terms. Never write the referral budget, fraud or hold thresholds, vendor costs and plan choices, growth targets, detailed competitor research or conversion read-outs; write "set by the owner; the value is kept in Notion (Familiarise / Growth & Marketing)".
