# Chart of accounts

**What this covers:** the ten `LedgerAccountKind` buckets every posting touches, which side each is *normal* on (so you can read a balance correctly), and how an account is scoped + addressed deterministically. This is the vocabulary the [postings doc](08-ledger-and-postings.md) speaks.

> **Reading a balance.** `ledgerBalancePaise()` returns the **signed** balance `Σ(DEBIT) − Σ(CREDIT)` in paise. For a **debit-normal** account that number is the balance as-is. For a **credit-normal** account (every liability and revenue), the meaningful figure — *the amount we owe / the revenue we booked* — is the **negative** of it. That single sign flip is why callers must know an account's normal side.

---

## 1. The ten accounts

```mermaid
classDiagram
  class Assets_DebitNormal {
    CASH  — platform gateway / settlement cash
    ORG_RECEIVABLE  — an INVOICE-funded org owes us (accrued at booking, cleared on payment)
  }
  class Liabilities_CreditNormal {
    WALLET  — prepaid balance we owe an org
    CONSULTANT_PAYABLE  — owed to a consultant
    ORG_PAYABLE  — owed to a host org
    TDS_PAYABLE  — tax withheld, owed to the government
    GST_PAYABLE  — tax collected, owed to the government
  }
  class Revenue_CreditNormal {
    PLATFORM_FEE  — platform's take
  }
  class ContraRevenue_DebitNormal {
    PLATFORM_PROMO  — platform-funded grants / comps / referral credits
    DISCOUNT  — discount given to the buyer
  }
```

| Kind | Class | Normal side | Scope | Means |
| --- | --- | --- | --- | --- |
| `CASH` | asset | DEBIT | platform | real money at the gateway / in settlement |
| `ORG_RECEIVABLE` | asset | DEBIT | org | an INVOICE-funded org owes us; accrued at booking, cleared on invoice payment |
| `WALLET` | liability | CREDIT | org | prepaid balance we owe the org (an IOU) |
| `CONSULTANT_PAYABLE` | liability | CREDIT | consultant | earnings owed to a consultant, not yet paid out |
| `ORG_PAYABLE` | liability | CREDIT | org | host-org share owed, not yet paid out |
| `TDS_PAYABLE` | liability | CREDIT | platform | TDS withheld at payout, owed to the government |
| `GST_PAYABLE` | liability | CREDIT | platform | GST collected on a booking, owed to the government |
| `PLATFORM_FEE` | revenue | CREDIT | platform | the platform's recognized take |
| `PLATFORM_PROMO` | contra-revenue | DEBIT | platform | platform-funded credits/comps + referral credits the platform eats |
| `DISCOUNT` | contra-revenue | DEBIT | platform | discount given to the buyer (reduces recognized revenue) |

`LedgerAccountKind` and `LedgerDirection` (`DEBIT` / `CREDIT`) are enums in `prisma/schema.prisma`. The class list above mirrors them exactly.

---

## 2. Scope: platform / org / consultant sub-ledgers

An account is **scoped** by who it belongs to:

- **Platform-wide** (both owners null): `CASH`, `PLATFORM_FEE`, `PLATFORM_PROMO`, `DISCOUNT`, `TDS_PAYABLE`, `GST_PAYABLE`. One account per kind per currency.
- **Org-scoped** (`organizationId` set): `WALLET`, `ORG_PAYABLE`, `ORG_RECEIVABLE`. One per org.
- **Consultant-scoped** (`consultantProfileId` set): `CONSULTANT_PAYABLE`. One per consultant.

So "what do we owe LearnPro?" is `-balance(ORG_PAYABLE, organizationId=learnpro)`, and "what does IIT-Madras hold in its wallet?" is `-balance(WALLET, organizationId=iit-madras)`.

---

## 3. Deterministic account ids

Accounts aren't looked up by a generated UUID; their id **is** their scope, joined by `|`:

```
<kind>|<organizationId | "_">|<consultantProfileId | "_">|<currency>
```

Examples:
- `CASH|_|_|INR` — the platform cash account.
- `WALLET|org_abc|_|INR` — org `org_abc`'s wallet.
- `CONSULTANT_PAYABLE|_|cp_xyz|INR` — what we owe consultant `cp_xyz`.

This is `ledgerAccountId(ref)` in `lib/payments/ledger/post.ts`. Two reasons it's deterministic rather than a UUID:

1. **Upsert-dedupe under concurrency.** `resolveAccountId()` does `upsert({ where: { id } })`, so two concurrent postings to the same scope converge on one row with no race.
2. **It sidesteps the Postgres nullable-unique gotcha.** A `@@unique([organizationId, consultantProfileId, kind, currency])` index would *not* dedupe rows where the owner columns are `NULL` (Postgres treats `NULL`s as distinct in unique indexes). Encoding the nulls as the literal `"_"` inside a single string primary key makes the dedupe exact. The composite unique still exists as a backstop, but the deterministic id is the working guard.

---

## 4. How the accounts net out (sanity check)

After a booking fully settles and the consultant + org are paid, the platform's books should show: `CASH` holding the platform's net take + taxes-not-yet-remitted, `PLATFORM_FEE` revenue recognized (less `DISCOUNT`/`PLATFORM_PROMO` contra), the `*_PAYABLE` liabilities drawn back to zero as payouts clear, and `TDS_PAYABLE`/`GST_PAYABLE` carrying what's owed to the government until remitted. Because every transaction balanced on the way in, the whole set always ties to zero net equity movement except recognized revenue — which is the point of double entry.

---

### Related docs
- [Money model overview](06-money-model-overview.md) — why derived, why integer paise.
- [Ledger & postings](08-ledger-and-postings.md) — the exact legs each flow posts to these accounts.
- [Ledger integrity](14-ledger-integrity.md) — the reconciler that re-sums these accounts.
- Ground truth: `lib/payments/ledger/post.ts` (`ledgerAccountId`, `AccountRef`), `prisma/schema.prisma` (`LedgerAccountKind`, `LedgerDirection`, `LedgerAccount`).
