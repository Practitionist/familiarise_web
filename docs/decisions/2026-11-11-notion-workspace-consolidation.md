# ADR: Notion workspace consolidation — numbered titles, unnumbered pointers

- **Status**: Accepted (owner decisions, 2026-11-11). It refines the section and pricing-page decisions of the 2026-11-09 record.
- **Date**: 2026-11-11
- **Author**: Platform engineering
- **Related**: [The repository and Notion split](2026-11-09-repo-notion-split.md), [Repo versus Notion](../../README.md#repo-versus-notion), [the documentation skill](../../.claude/skills/documentation/SKILL.md)

## Context

On 2026-11-11 the owner consolidated the Notion workspace, merging and deleting pages and giving every page an outline number in its title. Repository pointers name Notion pages in text only, so a renamed or renumbered page would silently break them.

## Decisions

### 1. Six sections, numbered titles, unnumbered pointers

The workspace keeps the six sections from the 2026-11-09 record. Notion page titles carry outline numbers (for example 08.01), and a repository pointer names the section and the page without the number: `value kept in Notion (Familiarise / Finance and Pricing / Pricing Strategy)`. Renumbering therefore never breaks a pointer.

### 2. Canonical pages

| Section                    | Page                                                                                 | Holds                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy and Competition   | Market, Positioning & Initial Wedge; Competitor Register; Retention & Defensibility  | Positioning, the competitor survey and the moat; the teardowns sit under "Competitor screenshots".                                                       |
| Growth & Marketing         | GTM Plan, plus the section page itself                                               | The go-to-market plan; referral levers, email vendor and costs, growth targets, read-outs and market research detail stay on the section page.           |
| Finance and Pricing        | Pricing Strategy; Unit Economics & Financial Model; Vendors & Spend; People & Hiring | Fee schedule and rationale; unit economics; vendor plans, bills, plan triggers, tier and capacity-ladder spend, payment-rail revisit thresholds; hiring. |
| Tax & CA Working Notes     | Tax, Legal & Regulatory Register; CA Engagement & Open Questions                     | The tax and legal register, including the former 14-question CA research memo; the accountant engagement.                                                |
| Product Vision and Roadmap | Product Vision, Scope & Horizons; Practitionist Ecosystem                            | Vision, scope and horizons; the ecosystem.                                                                                                               |

Two databases sit at the workspace root: Decision Log, and Assumptions & Experiments.

### 3. Pricing Strategy stays the canonical pricing page

"Pricing Strategy" (numbered 08.01) remains the one canonical home for pricing rationale and levels. It supersedes the title "09 Pricing Strategy" named in the 2026-11-09 record.

### 4. Archive is a deletion register

The Archive section keeps no page copies, only a register of deletions. Retired content lives in its canonical page or in git history. A doc never points at Archive.

## Consequences

- Pointers that named a merged or deleted page were repointed to the page that now holds the value (vendor plan and cost facts to Vendors & Spend, competitor survey facts to Competitor Register, positioning to Market, Positioning & Initial Wedge, the CA research memo to Tax, Legal & Regulatory Register).
- The 2026-11-09 records are left as written; this record supersedes their page titles.
- Fee values, budgets and vendor costs stay in Notion, not here.
