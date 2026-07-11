# Multi-Currency & Ledger

## Context

Money is modeled as integer paise with double-entry postings via `postLedgerTxn()`: deterministic ledger account IDs, sorted balance-cache updates (deadlock avoidance), COMMIT-time balance triggers, nightly `reconcile-ledgers`. Chart includes CASH, WALLET, PLATFORM_FEE, CONSULTANT_PAYABLE, ORG_PAYABLE/RECEIVABLE, TDS/GST payables, etc. Currency enum includes INR/USD/EUR/GBP, but settlement and ledger postings are **INR-only** today. International buyers may see `displayCurrencyAtCheckout` + `exchangeRateAtCheckout` as audit labels while Razorpay IBT still settles INR.

Key paths: `lib/payments/ledger/post.ts`, `lib/payments/validation/currency-guards.ts`, `prisma/sql/ledger-triggers.sql`.

## Known gaps / bugs

- True multi-currency ledger (#783) not built — non-INR plan pricing throws.
- Wallet balance on `BillingAccount` is a denormalized cache; journal is source of truth — drift possible until nightly reconcile.
- Display FX not used in refunds math beyond audit fields — customer may expect FX-aware refund amounts.
- Stripe/legacy paths increase mental load without multi-currency benefit.

## Unhappy paths & user psychology

- US consultee believes they paid $X; statement shows INR conversion + bank FX fee — they dispute “wrong amount.”
- Finance export mixes display currency and settlement currency without clear columns — reconciliation pain.
- Hot wallet org: many parallel bookings debit wallet cache; one fails mid-ledger posting — user sees balance flicker across tabs.

## Questions (handled?)

1. **Is INR settlement + local FX acceptable until meaningful US/EU consultant supply?**  
   - A) Yes — document clearly in checkout UI  
   - B) No — block non-INR buyers until #783  
   - C) Dual books: display FX wallet separate from INR ledger  

2. **On wallet drift detection, auto-heal from journal or page humans?**  
   - A) Auto-correct cache from ledger balance  
   - B) Freeze wallet + ops alert  
   - C) Log only until N paise threshold  

3. **Should refunds always return gateway-settled INR, ignoring display currency?**  
   - A) Yes (gateway truth)  
   - B) Attempt display-currency refund where gateway supports  
   - C) Credit wallet in INR equivalent only  

## High concurrency / multi-device

Ledger idempotency keys prevent double-post on webhook retry. Sorted account lock ordering reduces deadlock; under extreme parallel wallet debit + refund + top-up, expect P2034 retries. Multi-tab wallet UI must refresh from server after each mutation.

## Suggested directions

Add checkout copy: “Charged in INR; your bank may show a foreign transaction.” Prioritize ledger reconcile paging before multi-currency expansion.
