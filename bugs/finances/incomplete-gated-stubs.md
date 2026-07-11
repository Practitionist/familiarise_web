# Incomplete, Gated & Stubbed Finance Paths

## Context

Much of the finance surface is schema-complete and code-complete but **gated**, **stubbed**, or **doc-only**. Shipping without knowing which gates are intentional creates false confidence.

## Known gaps / bugs

| Item | State | Risk if ignored |
|------|--------|-----------------|
| `ENABLE_LIVE_PAYOUTS` | Off by default | Consultants unpaid |
| `ENABLE_IRP_UPLOADER` | Off / needs ClearTax | Non-compliant e-invoice at scale |
| Lemon Squeezy / XFlow | `NOT_IMPLEMENTED` + webhook routes | Dead routes / secret surface |
| Multi-currency ledger #783 | Deferred | Blocks true intl settlement |
| Section 195 / non-resident | Blocked | Intl consultants cannot cash out |
| Overage #715 paths | Partial | Some refunds/reversals refuse |
| GST TCS collection | Schema only | GSTR-8 gap |
| Day pass product | Skills/docs only | Product confusion |
| Paid trial checkout | Partial schema | Trial→pay funnel broken |
| Org Stripe Connect | Deferred | Dual-rail complexity |
| Payment cancellation helper | Warn-only for unknown IDs | Orphan intents |
| Export tax evidence (FIRC/LUT) | TODO in tax-engine | Audit weakness |

Dec 2025 P0 checkout bugs in `tasks/payment-workflow-critical-bugs.md` appear largely fixed in code — the task file may still read “Awaiting Fix” (**doc drift**).

## Unhappy paths & user psychology

- PM ships “payouts” marketing while flag is off — experts feel lied to.
- Eng enables Lemon webhook secretly for a pilot without checkout — phantom events.
- Sales promises USD pricing; currency guard throws at plan create.

## Questions (handled?)

1. **Delete vs quarantine Stripe/Lemon/XFlow code?**  
   - A) Delete unused gateways per Mar 2026 evaluation  
   - B) Quarantine behind `DEPRECATED_GATEWAYS`  
   - C) Keep Stripe test-only  

2. **Single source of truth for “finance ready for prod” checklist?**  
   - A) This bugs pack + shipping checklist sign-off slots  
   - B) Notion/Linear only  
   - C) Feature-flag dashboard as checklist  

3. **Are day passes on the roadmap or should skill/docs mentions be removed?**  
   - A) Build schema + grant path  
   - B) Remove mentions to reduce confusion  
   - C) Keep as future marketing only  

## High concurrency / multi-device

Stubs are mostly safe under load (they throw early). Gated live payouts under concurrent cron+admin is the dangerous incomplete path — never flip the flag without concurrency runbook.

## Suggested directions

Maintain a living “gates” table in finances README or ops Notion. Reconcile `tasks/payment-workflow-critical-bugs.md` status with current code.
