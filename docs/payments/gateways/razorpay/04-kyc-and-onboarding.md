# Razorpay KYC & Onboarding

> KYC requirements and onboarding process for Razorpay and RazorpayX on Familiarise.

**Last Updated**: 2026-02-14

---

## Overview

Razorpay requires KYC (Know Your Customer) verification before live payments can be processed. There are two separate KYC processes:

| KYC For                          | Purpose                         | Who Verifies |
| -------------------------------- | ------------------------------- | ------------ |
| **Razorpay Account** (Platform)  | Accept payments from customers  | Razorpay     |
| **RazorpayX Account** (Platform) | Disburse payouts to consultants | Razorpay     |

> **Note**: Individual consultants do **not** need their own Razorpay/KYC accounts. We create RazorpayX Contacts and Fund Accounts for them via API. Full bank account numbers live only in RazorpayX; our `PayoutAccount` table stores only RazorpayX reference IDs (`razorpayContactId`, `razorpayFundAccId`), `accountNumberLast4`, `ifscCode`, `bankName`, `accountHolderName`, and `upiId`.

---

## Platform KYC (One-Time Setup)

### Test vs Live Mode

| Mode     | KYC Required | Real Money | API Keys     |
| -------- | ------------ | ---------- | ------------ |
| **Test** | No           | No         | `rzp_test_*` |
| **Live** | Yes          | Yes        | `rzp_live_*` |

Test mode is fully functional for development without KYC. Live keys are only generated after KYC approval.

### Familiarise Business Type

Familiarise is an **ed-tech marketplace** platform. The relevant business type for Razorpay KYC is typically:

- **Private Limited Company** or **LLP** (if incorporated)
- **Sole Proprietorship** or **Individual** (if unincorporated)

### Required Documents

| Category           | Documents                                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| **Business Proof** | Certificate of Incorporation / Partnership Deed / GST Certificate           |
| **Identity Proof** | PAN Card (business or individual)                                           |
| **Address Proof**  | Utility bill, bank statement, or GST certificate showing registered address |
| **Bank Proof**     | Cancelled cheque or bank statement (account in business name)               |
| **Signatory ID**   | Aadhaar / Passport / Voter ID of authorized signatory                       |

### Submission Process

1. Complete business profile in Razorpay Dashboard
2. Upload all required documents
3. Submit for review
4. Wait for approval (typically 2-4 business days)
5. Handle clarification requests if any
6. Generate live API keys after approval

### Common Rejection Reasons

| Reason              | Fix                                                   |
| ------------------- | ----------------------------------------------------- |
| Document mismatch   | Ensure business name matches across all documents     |
| Low quality scan    | Re-upload with higher resolution (min 300 DPI)        |
| Expired document    | Upload current, valid documents                       |
| Missing information | Fill all required fields in business profile          |
| Website content     | Ensure website clearly describes services and pricing |

---

## RazorpayX KYC

RazorpayX (for payouts) requires a separate activation:

1. Apply for RazorpayX through the Razorpay dashboard
2. Provide business details and payout use case
3. Wait for approval (may require additional documents)
4. Receive RazorpayX account number after approval

---

## Consultant Onboarding (No KYC Needed)

Individual consultants do **not** go through Razorpay KYC. Instead:

1. Consultant provides bank account details or initiates UPI verification through our platform
2. Our server creates a **Contact** in RazorpayX (`POST /v1/contacts`)
3. Our server creates a **Fund Account** (`POST /v1/fund_accounts`) linked to that Contact
4. Ownership is verified via **Penny Drop** (`POST /v1/fund_accounts/validations` — transfers Rs. 1.00 to the beneficiary bank account and returns `results.account_status` + `results.registered_name`; note that the Rs. 1.00 is not reversed by RazorpayX) or **Reverse Penny Drop** (`POST /v1/fund_accounts/validations` with `validation_type: "upi_intent"`, where the consultant pays Rs. 1.00 via UPI Intent and RazorpayX refunds the Rs. 1.00 while returning `validation_results.bank_account`)
5. Consultant is ready to receive payouts (`PayoutAccount.isVerified = true`)

This is handled by `app/api/consultant/payout-accounts/route.ts` and `lib/payments/payouts/reverse-penny-drop.ts`.

### What Consultants Provide

**For bank account payouts**:

- Account holder name
- Bank account number
- IFSC code

**For UPI payouts**:

- UPI ID (VPA) or ₹1 UPI Intent payment via Reverse Penny Drop

### What We Store (`PayoutAccount` / `OrganizationPayoutAccount`)

- RazorpayX Contact ID (`razorpayContactId`, `cont_...`)
- RazorpayX Fund Account ID (`razorpayFundAccId`, `fa_...`)
- Account holder name (`accountHolderName`) and bank name (`bankName`)
- Masked account tail (`accountNumberLast4`), IFSC code (`ifscCode`), or verified UPI VPA (`upiId`)
- Account verification and default status (`isVerified`, `isDefault`, `verificationError`)

We **never** store full bank account numbers in plaintext — those are held only by RazorpayX.

---

## Timeline Summary

| Step                                 | Duration           |
| ------------------------------------ | ------------------ |
| Platform Razorpay KYC                | 2-4 business days  |
| Platform RazorpayX activation        | 1-3 business days  |
| Consultant fund account creation     | Instant (API call) |
| Bank account validation (penny test) | 1-2 minutes        |

---

## External Resources

For exhaustive details on document requirements by business type, industry certifications, and regulatory specifics, refer to Razorpay's official documentation:

- [Razorpay KYC Guide](https://razorpay.com/docs/payments/sign-up/)
- [RazorpayX Documentation](https://razorpay.com/docs/x/)
- [Business Types Reference](https://razorpay.com/docs/payments/sign-up/#business-types)
- [Industry Certifications](https://razorpay.com/docs/payments/sign-up/#supported-businesses)

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [01-setup.md](./01-setup.md) — Setup and environment configuration
- [03-payout-flow.md](./03-payout-flow.md) — Payout lifecycle and mechanics
