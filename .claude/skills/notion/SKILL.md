---
name: notion
description: How to write to the owner's private Notion workspace (the "Familiarise" root page) so its pages stay thorough, sourced and consistent — the page standard (header callout, evidence tags, alternatives, future trajectory and a revisit trigger on every decision), the decimal outline and its numbering rules, the two lever-register databases as the single home of tunable values, the Decision Log and Assumptions & Experiments databases, the Archive deletion register, the restricted People & Hiring page, backup-before-edit and re-fetch verification, the Notion MCP mechanics and pitfalls (query allowance, smallest edits, ID collisions, one agent per page), and the research standard (India-first, dated, cited). Use when the user says "Notion", "update the workspace", "write this to Notion", "lever register", "decision log", "assumptions", "Executive Brief", "Scorecard", "90-day plan", "pricing strategy page", "vendors and spend", "sales playbook", "CA questions", or when a decision made in a session must be recorded outside the repo.
---

# Notion

These are the rules for agents writing to the owner's private Notion workspace. Which facts belong in Notion and which in the repository is decided by `documentation` §6 ("Repo versus Notion"); read it first. This skill covers how to write once a fact belongs in Notion. The structure rules follow [the workspace consolidation decision](../../../docs/decisions/2026-11-11-notion-workspace-consolidation.md): numbered titles in Notion, unnumbered pointers in the repository, and an Archive that is a deletion register. The lever mechanisms are in [the levers decision](../../../docs/decisions/2026-11-11-cfo-csmo-levers.md).

Never write a lever value, a personal fact or a page ID into the repository. The repository carries mechanisms, field and constant names, and pointers of the form `value kept in Notion (Familiarise / <section> / <page>)`.

## 1. The workspace map

The root page is **Familiarise**. Find it with `notion-search` for "Familiarise", or fetch the root and walk its children. Never guess page IDs, and never copy one into the repository.

| #       | Page                                                                                                                                                                                                                                                 | Kind                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 01–03   | Executive Brief · Strategy Scorecard · 90-Day Operating Plan                                                                                                                                                                                         | root anchors, read in order |
| 04      | Strategy and Competition (Market, Positioning & Initial Wedge · Competitor Register · Retention & Defensibility · Competitor screenshots and teardowns)                                                                                              | section                     |
| 05      | Growth & Marketing (GTM Plan · Sales Playbook · **Growth & Marketing Lever Register**, a database)                                                                                                                                                   | section and a content page  |
| 06      | Finance and Pricing (Pricing Strategy · Unit Economics & Financial Model, which holds the monthly CFO dashboard · Vendors & Spend · People & Hiring, **restricted** · **Finance Lever Register**, a database · Host Coupons & Early-Bird (deferred)) | section                     |
| 07      | Tax & CA Working Notes (Tax, Legal & Regulatory Register · CA Engagement & Open Questions)                                                                                                                                                           | section                     |
| 08      | Product Vision and Roadmap                                                                                                                                                                                                                           | section                     |
| 09 · 10 | Decision Log · Assumptions & Experiments                                                                                                                                                                                                             | root databases              |
| 11      | Archive (a deletion register only; no archived copies)                                                                                                                                                                                               | register                    |

**Numbering.**

- Titles carry a decimal outline, for example `05.02 — Sales Playbook`.
- A new child takes the next free number in its section.
- On an insert or a delete, renumber the following siblings so the numbering stays contiguous (root `AGENTS.md` §4.4 applies to Notion too).
- Repository docs name pages without numbers (`Familiarise / Finance and Pricing / Pricing Strategy`), so renumbering never breaks a repository pointer.

Every page uses the full page width.

## 2. The page standard

1. **A header callout** on every page:
   - **Purpose:** the decision or function the page supports.
   - **Current position:** one or two lines.
   - **Next decision.**
   - `As of <date> · Owner · Review cadence · Evidence: <links>`.
2. **An evidence tag on every material fact:** **VERIFIED** (source URL and the date checked), **FOUNDER-APPROVED** (date), **FOUNDER-STATED** (date), **REPO-OBSERVED** (a path on `origin/dev`), **HYPOTHESIS**, **UNVERIFIED** or **SUPERSEDED**. Never present a recommendation as founder-approved.
3. **Every decision or recommendation ends with three blocks:**
   - **Alternatives considered:** each option with one line on why it lost.
   - **Future trajectory:** what this becomes at the next stage and the trigger that moves it.
   - **Revisit when:** a measurable trigger.
4. **Thorough, not padded.** Tables first, then full-sentence prose. About 3,500 words a page at most (5,000 for the financial model and the legal register). No motivational prose, superlatives or generic startup advice. Link the canonical page instead of restating another page's facts.
5. **Research standard.** Use India-first sources (Indian platforms, law and vendors) and label foreign sources "directional". Cite a URL and a check date. Never invent a market size, CAC or conversion rate; write "not found". Run scans and research on Sonnet subagents (see `workflow` → model orchestration).
6. **Money figures** come from a script or a register row, never from memory. Each figure carries its assumption (for example the FX rate) inline.
7. **Close each page** with `## Open questions for the founder`.

## 3. The lever registers

- **They are the only home of tunable values:** fees, prices, discounts, referral settings, holds, vendor triggers, budgets, runway and the company levers.
- **Pages explain the reasoning and link to register rows.** A number on a page must match its row exactly. When a value changes, change the row first, then the pages that cite it.
- **Columns (both databases):**
  - Lever, Code (`F<n>` finance, `G<n>` growth), Group, Status (Approved · Partly decided · Proposed · Superseded).
  - Approved value, Min, Max, Recommended.
  - Current (before) and its source, Evidence.
  - Alternatives considered, Future trajectory, Revisit when.
  - Who decides.
  - Where it lives (Notion · Admin config · Code constant (PR) · Law/CA · Owner purchase).
  - Repo mechanism (field or constant **names only**).
  - Decided on, Decision Log link.
- **The code-constant exception.** Where the founder chose to enforce a value in code (per-format minimum prices), the code constant is the value's home. The register row names the file and keeps the reasoning.
- **Personal values never go in a register row.** Founder funding and pay go on the restricted page; the row says "see People & Hiring".

## 4. Decision Log and Assumptions & Experiments

- **One Decision Log row per owner decision**, with Decision text, Rationale, Alternatives, Evidence, Revisit trigger, Related page and Related GitHub.
- **ID series:** `D-nn` (history), `G2-n` (strategy-audit gates), `C-nn` (CFO and CSMO levers), then a new letter per later review.
- **Check for ID collisions before you add a series.** An older row may already cite a bare `C-nn` for a different register. Rename the older citations (for example "claims-register C-nn") and say so in the database description.
- **Never delete a decision row.** Mark it SUPERSEDED and point its Status note at the replacing row.
- **Assumptions & Experiments:** A-rows are beliefs and X-rows are tests. Each X-row has Offer, Channel, Audience, Budget, Duration, Success metric, Stop condition and Decision consequence, and every X0 row carries the day-21 metric. Update Status and Result as tests run; never rewrite history.

## 5. Safety rules (non-negotiable)

1. **Back up before every edit.** Fetch the page. If it changed since the last local backup, save the fetched markdown under the session's backup folder (`temp/<session>/…`, which is gitignored). Restore from the backup or from Notion page history.
2. **Update in place** (same URL). Never recreate a page to edit it.
3. **Never call a sharing or permission tool.** Never move a page under a broader-shared parent.
4. **People & Hiring is restricted.** Keep its red banner. Names, pay and the founder's personal finances appear only there.
5. **Name the chartered accountant nowhere**, and keep emails, ticket numbers and page IDs off pages that do not need them.
6. **Deleting a page** needs the deletion rule: it is stale or wrong, its true content has a canonical home, and a backup exists. Delete it and add a row to the Archive register (Page, Former section, Deleted, Why in twelve words or fewer, Content now in, Recovery). Prefer trimming a section to deleting a page.
7. **Re-fetch after every write.** Check the title, the numbering, the full width and that the content landed. Log the result in the session's publish log. A write that returns without a warning is not verification.
8. **One owner per page or database** when parallel agents publish, to avoid lost updates. Root anchors that summarise other pages are written last.

## 6. Notion MCP mechanics and pitfalls

- **Tools.** `notion-fetch` (pages, databases and `collection://` data sources), `notion-update-page`, `notion-create-pages` (pages and database rows; pass the data source as the parent), `notion-create-database`, `notion-update-data-source` and `notion-query-data-sources` (rows). Load each with ToolSearch before calling it.
- **Read `notion://docs/notion-flavored-markdown-spec` once per session** (fetch it as an `id`) before writing. Callouts, mentions (`<mention url=…>`) and tables have their own syntax.
- **Database schema.** Fetch the database, then its `collection://` URL, and use the data-source ID as the row parent. To make a new database page full width, set `pageFullWidth` through `notion-update-data-source`.
- **The query allowance runs out.** The SQL and rows mode of `notion-query-data-sources` stops answering after enough calls in a session. View mode keeps working: fall back to it with the database's `view://` URL, and read in batches instead of one query per row.
- **Make the smallest edit.** Use `update_content` with the exact old text and the new text instead of replacing a whole page. A whole-page replace is for a page you are rewriting on purpose, and only after a backup.
- **A malformed edit can fail silently or write nothing.** An unclosed tag made one update write nothing. Re-fetch, find the text you meant to change, and retry; do not assume the write landed.
- **Truncation.** Check `truncated` and `unknown_block_count` on a fetch before trusting it. Long pages may need a second fetch.
- **A page can have no icon.** A fetch may return null; set the icon only when the task says so.
- **The backlink tool returns empty lists even for linked pages.** It is not proof that nothing links in; search the page text instead.
- **File URLs expire.** Keep `notion-file-block://` references when round-tripping content such as embedded PDFs.
- **Database rows cite pages that may not exist yet.** If a row needs a link to a row that is written later, write a plain pointer, then come back and set the link once the target exists.
- **One agent per page.** Never let two agents edit the same page or database in parallel. Give each agent a section and write the root anchors last.

## 7. Publishing workflow

1. Decisions are made in the session (`AskUserQuestion`, the recommended option first). Values go into a local register file first.
2. Publish either local drafts, reviewed and then published, or, when the owner approves, direct writes with backups. Split by section, with one agent per section and the root anchors last.
3. After publishing:
   - add the Decision Log rows and the Assumptions rows;
   - update the Archive register;
   - update the repository only through pointers (`value kept in Notion (Familiarise / <section> / <page>)`) or an engineering handoff.

## Deprecated & Superseded Approaches

- **Archive copies inside Notion.** Replaced on 2026-11-11 by the deletion register; originals live in git history and local backups.
- **Two-digit page numbers in titles** (the old "09 Pricing Strategy" form). Replaced by the decimal outline. Repository pointers carry no numbers.
- **Values written on several pages.** Replaced by the two lever registers.
