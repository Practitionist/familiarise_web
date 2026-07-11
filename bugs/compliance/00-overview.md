# Compliance — Overview

## Context

Dual-rail compliance: strong **B2B enterprise** primitives (GST/TDS helpers, invoices, audit logs, DPDP artifacts, MSME, IRP gated) vs weaker **B2C marketplace** (TDS engine drift, TCS unwired, grievance missing, consumer DSAR missing). Primary privacy framework is DPDP (India); GDPR mentioned but not coded as first-class.

Canonical: `docs/compliance/`, `lib/compliance/`, `jobs/compliance/`.

## Known gaps / bugs

- Legal pages use `[COMPANY NAME]` placeholders — **P0** enforceability.
- No consumer grievance officer flow (Consumer Protection Rules).
- B2C TDS wrong-path risk; GST TCS schema-only.
- Age gate not enforced; professional licenses not verified.
- May 2027 DPDP Phase 3 runway — consumer layer incomplete.

## Unhappy paths & user psychology

- User requests data deletion via email; only admin erasure path exists — slow, opaque.
- Consultant assumes platform handles all tax filings; notices wrong TDS.
- Parent lets teen create account — no age check.

## Questions (handled?)

1. **Legal harden before first paid txn?**  
   - A) Hard gate  
   - B) Design-partner MSA covers  
   - C) Ship with draft TOS marked beta  

2. **B2B-only compliance posture until B2C tax fixed?**  
   - A) Yes  
   - B) Fix TDS/TCS in parallel  
   - C) Manual CA for B2C interim  

## High concurrency / multi-device

Compliance is mostly process/ correctness; concurrent invoice numbering and consent writes need care (see finances/tax).

## Suggested directions

Replace legal placeholders; unify TDS; appoint grievance + DPDP officers on paper and in product.
