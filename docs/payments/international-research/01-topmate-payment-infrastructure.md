# TopMate.io Payment Infrastructure Research

> **Research Date:** March 2026
> **Relevance:** Direct competitor payment stack analysis

---

## 1. Payment Gateways Used

TopMate uses **both Stripe and Razorpay** to process payments.

| Gateway   | Use Case                                    | Fee         |
| --------- | ------------------------------------------- | ----------- |
| Razorpay  | Indian domestic payments (UPI, cards, etc.) | ~2% + GST   |
| Stripe    | International card payments                 | 2.9% + $0.30|

**Key insight:** TopMate's gateway selection mirrors Familiarise's current dual-gateway approach.

---

## 2. Commission / Fee Structure

TopMate has moved to a **tiered commission model** (updated from the original flat 5%):

| Plan     | Commission | Target                    |
| -------- | ---------- | ------------------------- |
| Basic    | 7%         | Beginners, casual users   |
| Premium  | 10%        | Serious professionals     |

**On top of commission, payment gateway fees (2-3%) are charged at actuals.**

### Effective Cost Breakdown for International Payments

| Fee Component                  | Rate         |
| ------------------------------ | ------------ |
| Platform commission            | 7-10%        |
| Payment gateway (international)| 3%           |
| Currency conversion markup     | 2-3%         |
| PayPal/transfer fees (payout)  | 1-2%         |
| **Total effective rate**       | **13-18%**   |

**Critical finding:** TopMate's advertised "7-10% commission" obscures the true cost of 16-18% for international creators, due to hidden forex markups and transfer fees.

---

## 3. Payout Methods

| Method        | Supported Countries       | Processing Time        |
| ------------- | ------------------------- | ---------------------- |
| Bank Transfer | India, USA only           | 0-2 days (up to 5 BD) |
| PayPal        | 100+ countries            | 0-7 days               |

- US bank payouts: within 7 business days, usually within 1 hour from second withdrawal onward
- Currency/payout method changes require emailing support@topmate.io
- Minimum withdrawal amount: not publicly disclosed

**Notable gaps:** No Wise, no Payoneer, no direct bank for UK/EU/AUS.

---

## 4. International Payment Handling

### Accepting International Payments (Inbound)
- Razorpay handles currency conversion for Indian-side payments
- Stripe handles international card payments
- Payments settled to TopMate in INR (via Razorpay) or USD (via Stripe)
- No multi-currency pricing -- prices set in one currency

### Paying International Creators (Outbound)
- India: Direct bank transfer (Razorpay payouts)
- USA: Direct bank transfer (likely Stripe payouts)
- All others: PayPal only (100+ countries)
- Hidden 2-3% forex markup embedded in conversion

---

## 5. Tax / GST Handling

TopMate does **not** appear to handle GST/TDS on behalf of creators:
- No built-in GST invoice generation for creators
- No TDS deduction mentioned in their documentation
- No GSTR-8 TCS collection mentioned
- Creators are responsible for their own tax compliance

**Regulatory concern:** TopMate's Terms of Use reportedly make no mention of RBI PA-CB authorization, which has been required since October 2023 for cross-border payment facilitators.

---

## 6. Tech Stack (from Public Sources)

| Category          | Technology                  |
| ----------------- | --------------------------- |
| Cloud             | Amazon Web Services (AWS)   |
| Storage           | Amazon S3                   |
| User Identity     | Gravatar                    |
| Video             | Zoom (external)             |
| Payments          | Stripe + Razorpay           |
| Analytics         | 8+ technology products      |
| Team Size         | ~15-20 (lean startup)       |

From job postings (Wellfound/AngelList):
- IIT Bombay alumni founded
- Employees get 1 day per sprint for passion projects (ML, blockchain, AR)
- No public engineering blog or tech talks found

---

## 7. Key Vulnerabilities (for Familiarise to Exploit)

1. **Payout reliability:** Trustpilot reviews consistently cite withdrawal delays and account closures
2. **Hidden fees:** 16-18% effective international rate vs. advertised 7-10%
3. **No PA-CB compliance:** Potential regulatory risk for cross-border operations
4. **PayPal-only international payouts:** Expensive and limited for non-US/India creators
5. **No native video:** Still relies on Zoom links
6. **No GST/TDS handling:** Leaves tax burden entirely on creators

---

## Sources

- [TopMate Payouts Help Article](https://topmate72420835211887570.freshdesk.com/support/solutions/articles/1070000111278-payouts)
- [TopMate Pricing Page](https://topmate.io/pricing)
- [TopMate.io Guide 2025: Earnings, Hidden Fees & Alternatives (EximPe)](https://eximpe.com/blog/others/topmate-io-the-complete-guide-to-getting-started-earning-money-avoiding-pitfalls)
- [TopMate Fee Calculator (SankalpX)](https://sankalpx.com/topmate-fee-earnings-calculator/)
- [TopMate Localized Currency Help](https://topmate72420835211887570.freshdesk.com/support/solutions/articles/1070000111310-localised-currency)
- [TopMate Crunchbase Tech Stack](https://www.crunchbase.com/organization/topmate/technology)
- [TopMate Wellfound Jobs](https://wellfound.com/company/topmate-io/jobs)
