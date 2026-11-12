# ADR: The repository and Notion split — where each kind of fact lives

- **Status**: Accepted (owner decisions, 2026-11-09). It completes the rule the owner set on 2026-11-08, written into the root `README.md` section "Repo versus Notion", `docs/AGENTS.md` rule 3 and the documentation skill, section 6.
- **Date**: 2026-11-09
- **Author**: Platform engineering
- **Related**: [Repo versus Notion](../../README.md#repo-versus-notion), [the documentation skill](../../.claude/skills/documentation/SKILL.md), [Payment gateways: one rail](2026-11-09-payment-gateways-one-rail.md), [India-first compliance posture](../compliance/01-india-first-posture.md)

## Context

The 2026-11-08 rule says a fact belongs in the repository when an engineer or agent needs it to build, change or verify the system, and in Notion when a competitor would gain from reading it or the owner can change it without a code change. Applying it to the existing Notion workspace on 2026-11-09 surfaced several questions the rule did not answer: how the Notion side is organised, which of two pricing pages wins, when a Notion page may be deleted rather than kept, where competitor screenshots go, what happens to the local launch guide, and where legal facts that used to sit in a research page go. This record answers them.

## Decisions

### 1. Six Notion sections

The owner's "Familiarise" workspace is organised into six sections, and a repository doc that points at Notion names one of them in the form `value kept in Notion (Familiarise / <section>)`:

1. Strategy and Competition
2. Growth & Marketing
3. Finance and Pricing
4. Tax & CA Working Notes
5. Product Vision and Roadmap
6. Archive

Archive holds pages that are no longer current but carry reasoning worth keeping. A doc never points at Archive for a live value.

### 2. One canonical pricing page

Within Finance and Pricing, the page titled "09 Pricing Strategy" is the canonical home for pricing rationale and levels. Any other Notion page that touches pricing defers to it. The repository keeps the mechanism (the fee schedule and how the take rate applies, in the finance docs) and never the levels or the reasoning.

### 3. Delete or archive

A Notion page is deleted only when all three tests hold: it is stale or wrong, its truth has another home (the repository, or another Notion page), and it holds no unique reasoning. Everything else is archived. Notion's Trash keeps a deleted page for 30 days, which is the safety net for a mistaken deletion. The Session G sweep deleted about 54 pages and archived 9.

### 4. Competitor screenshots and teardowns stay out of git

The competitor screenshots and teardowns gathered for issue #2113 live in Notion under Strategy and Competition (a "Competitor screenshots" page), and never in the repository. A repo doc may cite a public vendor fact with its source when the fact justifies a design, as the booking research appendices now do for the patterns that shaped Regular time and the conflict modes.

### 5. The MVP launch guide is rewritten at go-live

The local, gitignored `launch-guide/` folder is not maintained in the meantime. It will be rewritten from scratch in a dedicated go-live session, so nothing in it is migrated into the repository or Notion now.

### 6. Legal facts go into the existing compliance docs

Statutory sections that an engineer needs to implement or defend a behaviour (the Contract Act, IT Act, DPDP Act and Consumer Protection Act sections behind consent and Terms changes) are written into the existing compliance documents, with a citation, and not into a separate claims register. The first batch is in [India-first compliance posture](../compliance/01-india-first-posture.md). CA advice, tax planning and entity structure stay in Notion (Tax & CA Working Notes).

## Consequences

- A fact has one home. When a repo doc and a Notion page disagree, the canonical home wins and the other is fixed or deleted under decision 3.
- Docs trimmed in this change replace our own spend projections, competitor tables and positioning with a pointer: the stack decision page, the capacity ladder, the Stream pricing pages and the booking research appendices.
- The documentation skill is the checklist agents apply, so no new tooling is added.

## Deprecated & Superseded Approaches

- **Research pages that bundled legal facts, competitor tables and our own numbers.** Their durable parts were split: legal and public vendor facts into the repository docs named above, strategy and numbers into Notion.
- **A separate legal claims register.** Considered and rejected in favour of putting each fact in the compliance doc that uses it.
