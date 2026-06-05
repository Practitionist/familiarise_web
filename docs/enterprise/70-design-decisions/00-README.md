---
title: Design decisions (ADRs) — band index
band: 70-design-decisions
audience: sde3
status: partial
last-reviewed: 2026-06-05
---

# Design decisions (ADRs) — band index

This band collects the architecture decision records for the enterprise layer. Where the other bands document *what* the system does and *how* it does it, each ADR here records *why* one design was chosen over its alternatives, at the moment the choice was made. Read these before proposing a structural change: most "why don't we just…" questions are answered by an ADR, and a change that reverses one should say so explicitly in its PR description.

## Format

Every ADR follows the same four-part shape, written in full sentences:

1. **Context** — the forces in play when the decision was made, including the constraint or incident that prompted it.
2. **Decision** — the choice, stated in one or two sentences, with the code or schema that embodies it.
3. **Alternatives considered** — what was rejected and the concrete reason each alternative lost.
4. **Consequences** — what we gained, what we pay for it, and the conditions under which the decision should be revisited.

## Index

The twelve ADRs below are being written under #793; this index is the authoritative list of planned records. Each row links once the ADR lands.

| # | ADR | Decision in one line |
|---|---|---|
| 01 | Double-entry journal over three logs | One balanced `LedgerTransaction`/`LedgerEntry` journal replaced `FundingLedgerEntry`, `WalletEntry`, and `SettlementLedgerEntry` (#772). |
| 02 | Integer paise and basis points | All money is integer paise and all splits are integer basis points, so no float ever touches a balance. |
| 03 | Deterministic ledger-account IDs | Ledger accounts use deterministic composite IDs (`kind\|org\|consultant\|currency`) instead of UUIDs (#783). |
| 04 | Batch payouts over streaming | Earnings settle in periodic idempotent batches rather than per-earning transfers. |
| 05 | GitHub Actions crons | Scheduled jobs run as GitHub Actions hitting `CRON_SECRET`-gated endpoints rather than Netlify scheduled functions. |
| 06 | Typed Membership over BetterAuth Member | Every permission gate reads the typed `Membership` row, never BetterAuth's own member table. |
| 07 | Upstash rate limiting | BetterAuth's built-in limiter stays off; Upstash sliding windows gate the sensitive routes. |
| 08 | Gapless invoice counters | Invoice and credit-note numbers come from per-org, per-fiscal-year atomic counters to satisfy CGST Rules 46/53. |
| 09 | Webhook secret-rotation grace | Outbound webhook secret rotation dual-signs for 24 hours so receivers can cut over without a hard break. |
| 10 | Session-generation clock | Role changes bump `User.sessionGeneration` to force a membership refetch instead of revoking sessions. |
| 11 | Live-payout submission freeze | `ENABLE_LIVE_PAYOUTS` freezes only the gateway submission step; the whole pipeline upstream of it runs for real. |
| 12 | PENDING_TRUST earnings parking | Earnings for unverified INVOICE-funded orgs park in `PENDING_TRUST` until the org verifies or pays, closing the ghost-org fraud hole (#687). |
