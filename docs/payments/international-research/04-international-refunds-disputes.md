# International Refunds and Disputes

> **Research Date:** March 2026

---

## 1. Cross-Border Refunds via Razorpay

### How Refunds Work

| Aspect                | Domestic              | International                        |
| --------------------- | --------------------- | ------------------------------------ |
| Processing time       | 5-10 business days    | Up to 20 business days               |
| Currency              | INR to INR            | INR converted back to original currency |
| Initiation            | Dashboard or API      | Same -- Dashboard or API              |
| Partial refunds       | Supported             | Supported                            |

### Forex on Refunds

When a refund is processed for an international payment:

1. **Original payment:** Customer pays in foreign currency (e.g., $100 USD)
2. **Settlement:** Razorpay converts to INR at day's rate and settles to merchant
3. **Refund:** Razorpay debits the INR amount from merchant and converts back to foreign currency at **current day's rate**

**Who absorbs the forex difference?**

The **merchant (Familiarise) absorbs the forex risk** on refunds:
- If INR weakened since original payment: merchant pays more INR for the same USD refund
- If INR strengthened: merchant pays less INR (rare benefit)
- Gateway fees on the original transaction are **NOT refunded**

### Example: Forex Loss on Refund

```
Original transaction:
  Customer pays: $100 USD
  Exchange rate: 1 USD = Rs 85
  Razorpay receives: Rs 8,500
  After 3% fee: Rs 8,245 settled to merchant

Refund 30 days later:
  Exchange rate: 1 USD = Rs 87 (INR weakened)
  Razorpay debits: Rs 8,700 from merchant
  Customer receives: $100 USD refund

  Merchant loss: Rs 8,700 - Rs 8,245 = Rs 455 (forex + fee loss)
```

**Mitigation strategies:**
- Process refunds quickly (minimize exchange rate drift)
- Consider partial refunds in platform credits instead of cash
- Factor forex risk into international pricing (add 2-3% buffer)
- Set clear refund policy with shorter windows for international

---

## 2. Chargebacks on International Transactions

### Higher Risk for International

International transactions carry **heightened chargeback risk** because:
- Card/cardholder is **not verified and authenticated** in the same way as domestic
- 3D Secure may not be enforced in all countries
- Different consumer protection laws in buyer's country
- Time zone differences affect dispute resolution speed

### Chargeback Process

```
1. Cardholder disputes charge with their bank (issuing bank)
2. Issuing bank files chargeback with card network (Visa/Mastercard)
3. Card network notifies Razorpay
4. Razorpay debits disputed amount from merchant (held in escrow)
5. Merchant has 7-15 days to submit evidence
6. Card network makes final decision
7. If merchant wins: funds returned; if not: permanent debit
```

### Forex on Chargebacks

For international chargebacks, the amount debited is based on the **day's currency conversion rate when the dispute was created** -- NOT the original transaction rate. This can result in additional forex loss for the merchant.

### Chargeback Prevention for International

| Strategy                     | Implementation                               |
| ---------------------------- | -------------------------------------------- |
| Clear billing descriptor     | "FAMILIARISE" on card statement               |
| Confirmation emails          | Send booking confirmation with details        |
| Clear refund policy          | Display prominently during checkout           |
| 3D Secure enforcement        | Enable for all international cards            |
| Delivery proof               | Record session attendance/completion          |
| Customer communication       | Respond to complaints before they escalate    |

### Chargeback Costs

| Component        | Cost                                    |
| ---------------- | --------------------------------------- |
| Disputed amount  | Full refund to customer                 |
| Chargeback fee   | Rs 500-1,500 per dispute (Razorpay)     |
| Forex loss       | Variable (based on rate change)         |
| Gateway fees     | NOT refunded from original transaction  |
| Time cost        | 2-4 hours per dispute for evidence      |

---

## 3. Indian E-Commerce Dispute Resolution Obligations

### Consumer Protection (E-Commerce) Rules, 2020

Indian e-commerce entities must:
1. Provide a **grievance redressal mechanism** with designated officer
2. Acknowledge complaints within **48 hours**
3. Resolve complaints within **1 month**
4. Display refund/return/cancellation policies prominently
5. Provide **order confirmation** with all relevant details

### RBI Dispute Resolution Framework

For digital payments, RBI mandates:
- Customer liability limited to Rs 0 for unauthorized transactions reported within 3 days
- Merchant must resolve disputes within specified timeframes
- Maintain audit trail of all transactions

---

## 4. Refund Policy Recommendations for International

### Recommended Tiered Approach

| Scenario                          | Refund Policy                          |
| --------------------------------- | -------------------------------------- |
| Consultant no-show                | Full refund in original currency       |
| Customer cancellation (>24h)      | Full refund minus gateway fees         |
| Customer cancellation (<24h)      | 50% refund or platform credit          |
| Session completed, unsatisfied    | Platform credit only (no cash refund)  |
| Technical failure (platform side) | Full refund in original currency       |
| Chargeback dispute                | Contest with evidence                  |

### Platform Credit vs. Cash Refund

For international transactions, **platform credits are strongly preferred** because:
- No forex conversion needed
- No additional gateway fees
- Keeps customer engaged with platform
- Avoids forex loss for merchant
- Faster resolution

---

## Sources

- [Razorpay Disputes Documentation](https://razorpay.com/docs/payments/disputes/)
- [Razorpay International Payment Support](https://razorpay.com/docs/payments/international-payments/)
- [Razorpay Refund Process Blog](https://razorpay.com/blog/payment-gateway-refund-process)
- [Razorpay Cross-Border Fees Explained](https://razorpay.com/blog/cross-border-fees-explained/)
- [Razorpay Chargebacks Blog](https://razorpay.com/blog/chargebacks/)
- [Hidden Cost of Cross-Border Returns (ReverseLogix)](https://www.reverselogix.com/industry-updates/the-hidden-cost-of-cross-border-returns-on-e-commerce-profitability/)
