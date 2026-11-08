# Documentation

Applies to everything under `docs/`. The root `AGENTS.md` still applies (contiguous numbering, no ticket-number archaeology). How to write a doc: `.claude/skills/documentation/SKILL.md`.

1. **80–85% current architecture.** Every documentation file focuses on the **currently implemented architecture**, active workflows, state diagrams, sequence diagrams, and engineering invariants.
2. **10–15% deprecated, at the bottom.** Architecture and domain docs end with `## Deprecated & Superseded Approaches`, a brief record of what was previously implemented and why it was superseded. This lets AI agents and engineers recognize and delete residual artifacts from older implementations instead of rediscovering or re-implementing them, without bloating docs with standalone historical investigation logs.
3. **Repo versus Notion.** Write what an engineer or agent needs to build, change or verify the system; keep what a competitor would gain from, or what the owner can change without a code change, in Notion. When both apply, the mechanism goes in the repo and the value or reasoning in Notion (`value kept in Notion (Familiarise / <section>)`). Never copy a Notion page into a doc. Tests and table: root `README.md`, section "Repo versus Notion".
